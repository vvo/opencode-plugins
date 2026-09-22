/** @jsxImportSource @opentui/solid */
import { createSignal, onCleanup, Show, type Accessor } from "solid-js"
import {
  computeContext,
  computeTurns,
  type Child,
  type Context as ContextSize,
  type ContextMessage,
  type Entry,
  type Turns,
} from "./turns.js"

// One object satisfies both hosts. opencode 1 validates `tui`, opencode 2
// validates `setup`, and neither rejects the other's key. Nothing is imported
// from @opencode-ai/plugin at runtime: on opencode 2 that specifier is remapped
// to a host builtin, but on opencode 1 it resolves to the real npm package,
// where the v2 exports do not exist.
import type { RGBA } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Plugin } from "plugin-v2/tui"

type Context = Plugin.Context

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** How far back to page when backfilling; two user messages is all we display. */
const BACKFILL_PAGE = 200
const BACKFILL_PAGES = 50
const BACKFILL_TURNS = 2
/** Usage events arrive per step; the footer total waits for a quiet moment before asking again. */
const TODAY_DEBOUNCE_MS = 3_000

type Tracker = {
  /** Turns the host's own (short) message window has dropped. */
  history: Map<string, Entry>
  /** Subagent sessionID -> cost, so a session is only counted once. */
  children: Map<string, Child>
  version: Accessor<number>
  bump: () => void
}

function createTracker(): Tracker {
  const [version, setVersion] = createSignal(0)
  return {
    history: new Map(),
    children: new Map(),
    version,
    bump: () => setVersion((v) => v + 1),
  }
}

/**
 * The whole sidebar Context block: the host's three lines plus our turn costs,
 * so all four read as one group. Replaces the built-in section, which the user
 * disables with `-opencode.sidebar.context` (`-internal:sidebar-context` on
 * opencode 1).
 */
// opencode 1 hands out RGBA theme values, opencode 2 hands out strings; the
// opentui `fg` prop accepts either.
function ContextBlock(props: {
  context: () => ContextSize | undefined
  spent: () => number
  turns: () => Turns
  fg: string | RGBA
  headerFg: string | RGBA
}) {
  // Same condition as the host: show up to the first sign of activity.
  const visible = () => props.context() !== undefined || props.spent() > 0
  const costs = () => props.turns().current > 0 || props.turns().previous > 0
  return (
    <>
      {visible() ? (
        <box>
          <text fg={props.headerFg}>
            <b>Context</b>
          </text>
          {props.context() ? <text fg={props.fg}>{props.context()!.tokens.toLocaleString()} tokens</text> : null}
          {props.context()?.percent !== undefined ? <text fg={props.fg}>{props.context()!.percent}% used</text> : null}
          {props.spent() > 0 ? <text fg={props.fg}>{money.format(props.spent())} spent</text> : null}
          {costs() ? (
            <text fg={props.fg}>
              current {money.format(props.turns().current)}, previous {money.format(props.turns().previous)}
            </text>
          ) : null}
        </box>
      ) : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// opencode 2
// ---------------------------------------------------------------------------

async function backfillV2(context: Context, sessionID: string, tracker: Tracker) {
  try {
    let cursor: string | undefined
    let users = 0
    for (let page = 0; page < BACKFILL_PAGES && users < BACKFILL_TURNS; page++) {
      const res = await context.client.message.list({
        sessionID,
        limit: BACKFILL_PAGE,
        order: "desc",
        ...(cursor ? { cursor } : {}),
      })
      for (const message of res.data) {
        tracker.history.set(message.id, {
          id: message.id,
          user: message.type === "user",
          cost: "cost" in message ? (message.cost ?? 0) : 0,
          created: message.time.created,
        })
        if (message.type === "user" && ++users >= BACKFILL_TURNS) break
      }
      cursor = res.cursor.next ?? undefined
      if (!cursor) break
    }
  } catch {
    // A backfill failure only costs us the previous turn; the live window still renders.
  }

  try {
    const children = await context.client.session.list({ parentID: sessionID, order: "desc" })
    for (const child of children.data) {
      if (!tracker.children.has(child.id))
        tracker.children.set(child.id, { cost: child.cost ?? 0, created: child.time.created })
    }
  } catch {
    // Subagent costs stay out until a usage event reports them.
  }

  tracker.bump()
}

function setup(context: Context) {
  if (typeof context.ui?.slot !== "function") {
    context.ui?.toast?.show({
      variant: "error",
      message: "opencode-cost-details needs a newer opencode (sidebar slots unavailable)",
    })
    return
  }

  const trackers = new Map<string, Tracker>()
  const track = (sessionID: string) => {
    let tracker = trackers.get(sessionID)
    if (!tracker) {
      tracker = createTracker()
      trackers.set(sessionID, tracker)
      void backfillV2(context, sessionID, tracker)
    }
    return tracker
  }

  // session.updated is gone in v2, and usage events carry no parentID, so the
  // parent is resolved through the session tree instead.
  const unsubscribe = context.data.on("session.usage.updated", (event) => {
    const { sessionID, cost } = event.data
    const root = context.data.session.root(sessionID)
    if (!root || root === sessionID) return
    const tracker = trackers.get(root)
    if (!tracker) return
    const created = context.data.session.get(sessionID)?.time.created
    if (created === undefined) return
    tracker.children.set(sessionID, { cost: cost ?? 0, created })
    tracker.bump()
  })

  // `prepend`, not `append`: the built-in MCP section is an `append` claim, and
  // claims render before -> [prepend, append] -> after. Since builtins register
  // ahead of config plugins, appending would always land us below MCP. This puts
  // the block back where the built-in Context section was.
  const unslot = context.ui.slot({
    prepend: "sidebar.content",
    render: ({ sessionID }) => {
      const messages = () => context.data.session.message.list(sessionID)
      const session = () => context.data.session.get(sessionID)

      const size = () => {
        const list: ContextMessage[] = messages().map((message) => ({
          id: message.id,
          assistant: message.type === "assistant",
          compacted: message.type === "compaction" && message.status === "completed",
          tokens: "tokens" in message ? message.tokens : undefined,
        }))
        // The model has to match on both halves of the ref; ids repeat across providers.
        const model = session()?.model
        const limit = model
          ? context.data.location.model
              .list(session()?.location)
              ?.find((m) => m.providerID === model.providerID && m.id === model.id)?.limit.context
          : undefined
        return computeContext(list, limit, session()?.revert?.messageID)
      }

      // The host's own total. It under-reports nested subagents, but disagreeing
      // with opencode inside a block we render would be worse; our turn line
      // carries the fuller figure.
      const spent = () => context.data.session.cost(sessionID)

      const turns = () => {
        const tracker = track(sessionID)
        tracker.version()
        const live = messages().map((message) => ({
          id: message.id,
          user: message.type === "user",
          cost: "cost" in message ? (message.cost ?? 0) : 0,
          created: message.time.created,
        }))
        return computeTurns([...tracker.history.values(), ...live], tracker.children.values())
      }

      return (
        <ContextBlock
          context={size}
          spent={spent}
          turns={turns}
          fg={context.theme.text.muted}
          headerFg={context.theme.text.base}
        />
      )
    },
  })

  // Home has no session, so the footer shows the day's total instead.
  const unfooter = context.ui.slot({
    append: "home.footer.status",
    render: () => <TodayCost context={context} />,
  })

  return () => {
    unsubscribe()
    unslot()
    unfooter()
  }
}

function TodayCost(props: { context: Context }) {
  const [today, setToday] = createSignal<number>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const refresh = () => {
    const from = new Date().setHours(0, 0, 0, 0)
    props.context.client.session
      .stats({ from, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, tools: "none" })
      .then((stats) => setToday(stats.cost))
      .catch(() => undefined)
  }
  refresh()
  const unsubscribe = props.context.data.on("session.usage.updated", () => {
    clearTimeout(timer)
    timer = setTimeout(refresh, TODAY_DEBOUNCE_MS)
  })
  onCleanup(() => {
    clearTimeout(timer)
    unsubscribe()
  })
  return <Show when={today() !== undefined}><text fg={props.context.theme.text.muted}>{money.format(today()!)} today</text></Show>
}

// ---------------------------------------------------------------------------
// opencode 1
// ---------------------------------------------------------------------------

type V1Message = {
  id: string
  role: string
  cost?: number
  time: { created: number }
  providerID?: string
  modelID?: string
  tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
}

async function backfillV1(api: TuiPluginApi, sessionID: string, tracker: Tracker) {
  try {
    const res = await api.client.session.messages({ sessionID })
    for (const { info } of res?.data ?? []) {
      tracker.history.set(info.id, {
        id: info.id,
        user: info.role === "user",
        cost: info.role === "assistant" ? (info.cost ?? 0) : 0,
        created: info.time.created,
      })
    }
  } catch {
    // Live window only.
  }

  try {
    const children = await api.client.session.children({ sessionID })
    for (const child of children?.data ?? []) {
      if (!tracker.children.has(child.id))
        tracker.children.set(child.id, { cost: child.cost ?? 0, created: child.time.created })
    }
  } catch {
    // Subagent costs stay out until session.updated reports them.
  }

  tracker.bump()
}

/** The built-in sidebar Context section on opencode 1. */
const V1_CONTEXT = "internal:sidebar-context"

const tui: TuiPlugin = async (api) => {
  if (typeof api.slots?.register !== "function") {
    api.ui?.toast({
      variant: "error",
      message: "opencode-cost-details needs a newer opencode (sidebar slots unavailable)",
    })
    return
  }

  // We render the built-in section's three lines ourselves, so hide the original
  // to avoid showing it twice. opencode 1 lets a plugin do this to itself, and
  // restores it on dispose so removing the plugin brings the stock sidebar back.
  // opencode 2 dropped this API; there the user adds `-opencode.sidebar.context`
  // to cli.json instead.
  const internal = api.plugins?.list?.().find((p) => p.id === V1_CONTEXT)
  if (internal) {
    if (internal.active) await api.plugins.deactivate(V1_CONTEXT)
    api.lifecycle.onDispose(async () => {
      await api.plugins.activate(V1_CONTEXT)
    })
  }

  const trackers = new Map<string, Tracker>()
  const track = (sessionID: string) => {
    let tracker = trackers.get(sessionID)
    if (!tracker) {
      tracker = createTracker()
      trackers.set(sessionID, tracker)
      void backfillV1(api, sessionID, tracker)
    }
    return tracker
  }

  api.lifecycle.onDispose(
    api.event.on("session.updated", (event) => {
      const info = event.properties.info
      if (!info.parentID) return
      const tracker = trackers.get(info.parentID)
      if (!tracker) return
      tracker.children.set(info.id, { cost: info.cost ?? 0, created: info.time.created })
      tracker.bump()
    }),
  )

  // 100 is where the built-in Context section sat, so we take its place in the
  // ordering once the user disables it with `-internal:sidebar-context`.
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        const messages = () => api.state.session.messages(props.session_id) as readonly V1Message[]

        // opencode 1 computes this differently from opencode 2: newest assistant
        // message with output, and no compaction or revert handling. Match the
        // host we are running on rather than sharing one implementation.
        const size = () => {
          const latest = messages().findLast((m) => m.role === "assistant" && (m.tokens?.output ?? 0) > 0)
          if (!latest?.tokens) return undefined
          const t = latest.tokens
          const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
          if (tokens <= 0) return undefined
          const limit = api.state.provider.find((p) => p.id === latest.providerID)?.models[latest.modelID!]?.limit
            .context
          return { tokens, percent: limit ? Math.round((tokens / limit) * 100) : undefined }
        }

        const spent = () => api.state.session.get(props.session_id)?.cost ?? 0

        const turns = () => {
          const tracker = track(props.session_id)
          tracker.version()
          const live = messages().map((message) => ({
            id: message.id,
            user: message.role === "user",
            cost: message.cost ?? 0,
            created: message.time.created,
          }))
          return computeTurns([...tracker.history.values(), ...live], tracker.children.values())
        }

        return (
          <ContextBlock
            context={size}
            spent={spent}
            turns={turns}
            fg={api.theme.current.textMuted}
            headerFg={api.theme.current.text}
          />
        )
      },
    },
  })
}

export default {
  id: "opencode-cost-details",
  tui,
  setup,
}
