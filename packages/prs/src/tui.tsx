/** @jsxImportSource @opentui/solid */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createEffect, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Plugin } from "plugin-v2/tui"
import type { PanelInput } from "plugin-v2/tui/context"
import {
  extractCreatedPullRequests,
  groupPullRequests,
  marquee,
  predatesSession,
  pullRequestChecksIndicator,
  pullRequestCommentsLabel,
  pullRequestFromNode,
  pullRequestFromRest,
  pullRequestLabel,
  pullRequestStatusLabel,
  pullRequestStatusIsWarning,
  pullRequestsQuery,
  slackPullRequest,
  slackPullRequestHtml,
  slackPullRequests,
  slackPullRequestsHtml,
  slackPullRequestsTexty,
  sortPullRequests,
  uniquePullRequests,
  type CheckSummary,
  type ChecksIndicator,
  type PullRequest,
  type PullRequestNode,
  type PullRequestRef,
  type RestPullRequest,
} from "./prs.js"

const execFileAsync = promisify(execFile)
const REFRESH_MS = 30_000
const MAX_HISTORY_PAGES = 50
const MAX_VISIBLE_PRS = 10
const MARQUEE_DELAY_MS = 500
const MARQUEE_STEP_MS = 120
const MERGED_OPACITY = 0.7
const PANEL_NAME = "opencode-prs.panel"
type Context = Plugin.Context
type Message = { type?: string; content?: unknown[]; time?: { created?: number } }
type ShellToolPart = {
  type?: string
  name?: string
  tool?: string
  state?: {
    status?: string
    input?: { command?: string }
    content?: unknown[]
    output?: string
  }
}
type SessionCache = {
  history: PullRequestRef[]
  historyPromise?: Promise<PullRequestRef[]>
  prs: PullRequest[]
  refsKey: string
  unavailable: boolean
  refreshPromise?: Promise<void>
  /** Reactive copy of `prs` and `unavailable`, shared by the sidebar and the panel. */
  view: Accessor<{ prs: PullRequest[]; unavailable: boolean }>
  setView: (view: { prs: PullRequest[]; unavailable: boolean }) => void
}

const sessionCache = new Map<string, SessionCache>()

function fade(color: string | RGBA, opacity: number): string | RGBA {
  if (typeof color === "string") return color
  const [r, g, b] = color.toInts()
  return `#${[r, g, b, Math.round(opacity * 255)].map((value) => value.toString(16).padStart(2, "0")).join("")}`
}

async function copyRichText(plain: string, html: string, fallback: (text: string) => boolean, slackTexty?: string): Promise<boolean> {
  if (process.platform !== "darwin") return fallback(plain)
  try {
    // Payload goes through stdin: osascript parses a leading "- " as an option and dies on argv over about 1 KB.
    const script = `ObjC.import("AppKit")
function run() {
  const input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile
  const payload = JSON.parse(ObjC.unwrap($.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding)))
  const pasteboard = $.NSPasteboard.generalPasteboard
  pasteboard.clearContents
  pasteboard.setStringForType($(payload.plain), $.NSPasteboardTypeString)
  pasteboard.setStringForType($(payload.html), $.NSPasteboardTypeHTML)
  if (payload.slackTexty) pasteboard.setStringForType($(payload.slackTexty), "slack/texty")
}`
    const osascript = execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script])
    // If osascript exits before reading, the write raises EPIPE on the stream, not on the awaited promise.
    osascript.child.stdin?.on("error", () => {})
    osascript.child.stdin?.end(JSON.stringify({ plain, html, slackTexty }))
    await osascript
    return true
  } catch {
    return fallback(plain)
  }
}

function getSessionCache(sessionID: string): SessionCache {
  let cache = sessionCache.get(sessionID)
  if (!cache) {
    const [view, setView] = createSignal({ prs: [] as PullRequest[], unavailable: false })
    cache = { history: [], prs: [], refsKey: "", unavailable: false, view, setView }
    sessionCache.set(sessionID, cache)
  }
  return cache
}

function samePullRequest(left: PullRequest, right: PullRequest): boolean {
  return (
    left.url === right.url &&
    left.title === right.title &&
    left.state === right.state &&
    left.isDraft === right.isDraft &&
    left.reviewDecision === right.reviewDecision &&
    left.mergeStateStatus === right.mergeStateStatus &&
    left.unresolvedThreads === right.unresolvedThreads &&
    left.checks === right.checks &&
    sameCheckSummary(left.checkSummary, right.checkSummary) &&
    left.createdAt === right.createdAt &&
    left.mergedAt === right.mergedAt &&
    left.additions === right.additions &&
    left.deletions === right.deletions
  )
}

function pullRequestRefsKey(refs: Iterable<PullRequestRef>): string {
  return uniquePullRequests(refs).map((ref) => ref.url).join("\n")
}

function sameCheckSummary(left: CheckSummary, right: CheckSummary): boolean {
  return (
    left.passing === right.passing &&
    left.skipped === right.skipped &&
    left.total === right.total &&
    left.failing.join("\n") === right.failing.join("\n") &&
    left.running.join("\n") === right.running.join("\n")
  )
}

function mergePullRequests(
  refs: PullRequestRef[],
  results: (PullRequest | undefined)[],
  cached: PullRequest[],
): PullRequest[] {
  const previous = new Map(cached.map((pr) => [pr.url, pr]))
  return results
    .map((result, index) => {
      const existing = previous.get(refs[index].url)
      if (!result) return existing
      return existing && samePullRequest(existing, result) ? existing : result
    })
    .filter((result): result is PullRequest => result !== undefined && result.state !== "CLOSED")
}

function PullRequestRow(props: {
  pr: PullRequest
  subdued: string | RGBA
  link: string | RGBA
  draft: string | RGBA
  open: string | RGBA
  success: string | RGBA
  error: string | RGBA
  copy: (plain: string, html: string, slackTexty?: string) => Promise<boolean>
}) {
  const [hovered, setHovered] = createSignal(false)
  const [width, setWidth] = createSignal(1)
  const [offset, setOffset] = createSignal(0)
  let delay: ReturnType<typeof setTimeout> | undefined
  let interval: ReturnType<typeof setInterval> | undefined

  createEffect(() => {
    clearTimeout(delay)
    clearInterval(interval)
    setOffset(0)
    if (!hovered() || props.pr.title.length <= width()) return
    delay = setTimeout(() => {
      const cycleLength = props.pr.title.length + 3
      let step = 0
      interval = setInterval(() => {
        step++
        if (step < cycleLength) {
          setOffset(step)
          return
        }
        clearInterval(interval)
        interval = undefined
        setOffset(0)
      }, MARQUEE_STEP_MS)
    }, MARQUEE_DELAY_MS)
  })
  onCleanup(() => {
    clearTimeout(delay)
    clearInterval(interval)
  })

  const merged = () => props.pr.state === "MERGED"
  const commentsSuffix = () => {
    const label = pullRequestCommentsLabel(props.pr)
    return label ? ` · ${label}` : ""
  }
  const subdued = () => merged() ? fade(props.subdued, MERGED_OPACITY) : props.subdued
  const titleColor = () => merged() ? subdued() : props.link
  const statusColor = () => {
    if (merged()) return subdued()
    return pullRequestStatusIsWarning(props.pr) ? props.draft : props.open
  }
  const checksColor = (indicator: ChecksIndicator) => {
    if (indicator === "✓") return props.success
    if (indicator === "×") return props.error
    return props.subdued
  }
  return (
    <box
      flexDirection="column"
      minWidth={0}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <box flexDirection="row" minWidth={0}>
        <text fg={subdued()} flexShrink={0}>• </text>
        <box flexGrow={1} minWidth={0} overflow="hidden" onSizeChange={function () { setWidth(this.width) }}>
          <text fg={titleColor()} wrapMode="none"><a href={props.pr.url}>{marquee(props.pr.title, width(), offset())}</a></text>
        </box>
      </box>
      <box
        flexDirection="row"
        marginLeft={2}
        minWidth={0}
        onMouseUp={() => props.copy(slackPullRequest(props.pr), slackPullRequestHtml(props.pr))}
      >
        <box flexShrink={1} minWidth={0} overflow="hidden">
          <text fg={subdued()} wrapMode="none">
            {pullRequestLabel(props.pr)}
            <span style={{ fg: statusColor() }}> · {pullRequestStatusLabel(props.pr)}</span>
            {commentsSuffix()}
          </text>
        </box>
        <Show when={pullRequestChecksIndicator(props.pr)} keyed>
          {(indicator) => (
            <text fg={props.subdued} flexShrink={0}> · <span style={{ fg: checksColor(indicator) }}>{indicator}</span></text>
          )}
        </Show>
      </box>
    </box>
  )
}

type GraphqlData = Record<string, { pullRequest: PullRequestNode | null } | null>

async function fetchPullRequests(refs: PullRequestRef[], cached: PullRequest[]): Promise<(PullRequest | undefined)[]> {
  if (refs.length === 0) return []
  const data = await fetchPullRequestsGraphql(refs)
  if (data) {
    return refs.map((ref, index) => {
      const node = data[`pr${index}`]?.pullRequest
      return node ? pullRequestFromNode(ref, node) : undefined
    })
  }
  // REST has its own rate limit, so it still answers when GraphQL is exhausted.
  const previous = new Map(cached.map((pr) => [pr.url, pr]))
  return Promise.all(refs.map((ref) => fetchPullRequestRest(ref, previous.get(ref.url))))
}

async function fetchPullRequestsGraphql(refs: PullRequestRef[]): Promise<GraphqlData | undefined> {
  // gh exits non-zero when one alias fails to resolve but still prints the data for the others.
  const stdout = await execFileAsync("gh", ["api", "graphql", "-f", `query=${pullRequestsQuery(refs)}`])
    .then((result) => result.stdout)
    .catch((error: { stdout?: string }) => error.stdout ?? "")
  try {
    return (JSON.parse(stdout) as { data?: GraphqlData | null }).data ?? undefined
  } catch {
    return undefined
  }
}

async function fetchPullRequestRest(ref: PullRequestRef, cached: PullRequest | undefined): Promise<PullRequest | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", ["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`])
    return pullRequestFromRest(ref, JSON.parse(stdout) as RestPullRequest, cached)
  } catch {
    return undefined
  }
}

function refsFromV2(messages: readonly Message[], sessionCreated: number | undefined): PullRequestRef[] {
  const refs: PullRequestRef[] = []
  for (const message of messages) {
    if (message.type !== "assistant" || predatesSession(message, sessionCreated)) continue
    for (const content of message.content ?? []) {
      if (!content || typeof content !== "object") continue
      const part = content as ShellToolPart
      if (part.type !== "tool" || part.name !== "shell" || part.state?.status !== "completed") continue
      refs.push(...extractCreatedPullRequests(part.state.input?.command ?? "", JSON.stringify(part.state.content)))
    }
  }
  return refs
}

function refsFromV1(api: TuiPluginApi, sessionID: string): PullRequestRef[] {
  const refs: PullRequestRef[] = []
  const sessionCreated = api.state.session.get(sessionID)?.time.created
  for (const message of api.state.session.messages(sessionID)) {
    if (predatesSession(message, sessionCreated)) continue
    for (const part of api.state.part(message.id)) {
      if (part.type !== "tool" || part.tool !== "shell" || part.state.status !== "completed") continue
      const input = part.state.input as { command?: string }
      refs.push(...extractCreatedPullRequests(input.command ?? "", part.state.output))
    }
  }
  return refs
}

async function refsFromV2History(context: Context, sessionID: string): Promise<PullRequestRef[]> {
  const sessionCreated = await sessionCreatedV2(context, sessionID)
  const refs: PullRequestRef[] = []
  let cursor: string | undefined
  let page = 0
  do {
    const response = await context.client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : { order: "desc" }) })
    const messages = response.data as readonly Message[]
    refs.push(...refsFromV2(messages, sessionCreated))
    // Newest first, so once a page reaches inherited messages the rest is the parent's history.
    if (messages.some((message) => predatesSession(message, sessionCreated))) break
    cursor = response.cursor.next ?? undefined
    page++
  } while (cursor && page < MAX_HISTORY_PAGES)
  return refs
}

async function sessionCreatedV2(context: Context, sessionID: string): Promise<number | undefined> {
  const created = context.data.session.get(sessionID)?.time.created
  if (created !== undefined) return created
  return context.client.session.get({ sessionID }).then((session) => session.time.created).catch(() => undefined)
}

async function refsFromV1History(api: TuiPluginApi, sessionID: string): Promise<PullRequestRef[]> {
  const [response, sessionCreated] = await Promise.all([
    api.client.session.messages({ sessionID }),
    api.client.session.get({ sessionID }).then((session) => session.data?.time.created).catch(() => undefined),
  ])
  const refs: PullRequestRef[] = []
  for (const item of response.data ?? []) {
    if (predatesSession(item.info, sessionCreated)) continue
    for (const part of item.parts as ShellToolPart[]) {
      if (part.type !== "tool" || part.tool !== "shell" || part.state?.status !== "completed") continue
      refs.push(...extractCreatedPullRequests(part.state.input?.command ?? "", part.state.output ?? ""))
    }
  }
  return refs
}

function PullRequests(props: {
  sessionID: string
  refs: Accessor<PullRequestRef[]>
  history: () => Promise<PullRequestRef[]>
  sync?: () => Promise<void>
  focused?: Accessor<boolean>
  foreground: string | RGBA
  subdued: string | RGBA
  link: string | RGBA
  draft: string | RGBA
  open: string | RGBA
  success: string | RGBA
  error: string | RGBA
  copy: (plain: string, html: string, slackTexty?: string) => Promise<boolean>
  /** opencode 2 only: the header opens the panel instead of folding the section. */
  onHeaderClick?: () => void
}) {
  const cache = getSessionCache(props.sessionID)
  const [open, setOpen] = createSignal(true)
  const [showMerged, setShowMerged] = createSignal(false)
  const prs = () => cache.view().prs
  const unavailable = () => cache.view().unavailable
  const groups = () => groupPullRequests(prs())
  const activePrs = () => groups().active.slice(0, MAX_VISIBLE_PRS)
  const mergedPrs = () => groups().merged.slice(0, Math.max(0, MAX_VISIBLE_PRS - activePrs().length))
  const row = (pr: PullRequest) => (
    <PullRequestRow
      pr={pr}
      subdued={props.subdued}
      link={props.link}
      draft={props.draft}
      open={props.open}
      success={props.success}
      error={props.error}
      copy={props.copy}
    />
  )
  let mounted = true
  let focused = props.focused?.() ?? true
  let observedRefsKey = pullRequestRefsKey(props.refs())
  const showCache = () => {
    if (!mounted) return
    cache.setView({ prs: cache.prs, unavailable: cache.unavailable })
  }
  const refresh = async (force = false) => {
    while (mounted) {
      const refs = uniquePullRequests([...cache.history, ...props.refs()])
      const refsKey = pullRequestRefsKey(refs)
      if (!force && refsKey === cache.refsKey) return
      force = false
      if (!cache.refreshPromise) {
        cache.refreshPromise = fetchPullRequests(refs, cache.prs).then((results) => {
          const failed = refs.length > 0 && results.every((result) => result === undefined)
          if (!failed || cache.prs.length === 0) {
            const next = mergePullRequests(refs, results, cache.prs)
            if (next.length !== cache.prs.length || next.some((pr, index) => pr !== cache.prs[index])) cache.prs = next
          }
          cache.unavailable = failed && cache.prs.length === 0
          cache.refsKey = refsKey
        }).finally(() => {
          cache.refreshPromise = undefined
        })
      }
      await cache.refreshPromise
      showCache()
    }
  }
  const revalidate = async () => {
    await props.sync?.().catch(() => undefined)
    const historyPromise = cache.historyPromise ??= props.history().catch(() => cache.history).finally(() => {
      cache.historyPromise = undefined
    })
    cache.history = await historyPromise
    await refresh(true)
  }
  createEffect(() => {
    const refsKey = pullRequestRefsKey(props.refs())
    if (refsKey === observedRefsKey) return
    observedRefsKey = refsKey
    void refresh()
  })
  onMount(() => {
    void revalidate()
    const interval = setInterval(() => {
      if (focused) void refresh(true)
    }, REFRESH_MS)
    onCleanup(() => {
      mounted = false
      clearInterval(interval)
    })
  })
  createEffect(() => {
    const next = props.focused?.() ?? true
    if (next === focused) return
    focused = next
    if (focused) void revalidate()
  })
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseUp={() => (props.onHeaderClick ?? (() => setOpen((value) => !value)))()}>
        <text fg={props.foreground} onMouseUp={(event) => { event.stopPropagation(); setOpen((value) => !value) }}>{open() ? "▼" : "▶"}</text>
        <text fg={props.foreground}><b>PRs ({groups().active.length})</b></text>
        <Show when={groups().active.length > 0}>
          <text
            fg={props.subdued}
            onMouseUp={(event) => {
              event.stopPropagation()
              const active = groups().active
              void props.copy(slackPullRequests(active), slackPullRequestsHtml(active), slackPullRequestsTexty(active))
            }}
          >⧉</text>
        </Show>
      </box>
      <Show when={open()}>
        <Show when={unavailable()}><text fg={props.subdued}>GitHub unavailable</text></Show>
        <Show when={!unavailable() && prs().length === 0}><text fg={props.subdued}>No PRs</text></Show>
        <For each={activePrs()}>{row}</For>
        <Show when={groups().merged.length > 0}>
          <box flexDirection="row" onMouseUp={() => setShowMerged((value) => !value)}>
            <text fg={fade(props.subdued, MERGED_OPACITY)}>{showMerged() ? "▾" : "▸"} {groups().merged.length} merged</text>
          </box>
          <Show when={showMerged()}><For each={mergedPrs()}>{row}</For></Show>
        </Show>
      </Show>
    </box>
  )
}

function openInBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open"
  execFile(opener, [url], () => undefined)
}

function PullRequestPanel(props: {
  context: Context
  panel: PanelInput
  copy: (plain: string, html: string, slackTexty?: string) => Promise<boolean>
}) {
  const theme = props.context.theme
  const cache = getSessionCache(props.panel.sessionID)
  const prs = () => sortPullRequests(cache.view().prs)
  const active = () => groupPullRequests(cache.view().prs).active
  const [cursor, setCursor] = createSignal(0)
  const selected = () => prs()[Math.min(cursor(), Math.max(0, prs().length - 1))]
  const move = (delta: number) => setCursor((value) => Math.max(0, Math.min(prs().length - 1, value + delta)))
  const openSelected = () => {
    const pr = selected()
    if (pr) openInBrowser(pr.url)
  }
  const copySelected = () => {
    const pr = selected()
    if (pr) void props.copy(slackPullRequest(pr), slackPullRequestHtml(pr))
  }
  const copyActive = () => {
    if (active().length > 0) void props.copy(slackPullRequests(active()), slackPullRequestsHtml(active()), slackPullRequestsTexty(active()))
  }
  // Clearing the refs key makes the sidebar's next refs effect run a full refresh.
  const refresh = () => {
    cache.refsKey = ""
    props.context.data.session.message.invalidate(props.panel.sessionID)
  }

  props.context.keymap.layer(() => ({
    enabled: () => props.panel.focused,
    commands: [
      { bind: "j", run: () => move(1) },
      { bind: "down", run: () => move(1) },
      { bind: "k", run: () => move(-1) },
      { bind: "up", run: () => move(-1) },
      { bind: "enter", run: openSelected },
      { bind: "o", run: openSelected },
      { bind: "c", run: copySelected },
      { bind: "shift+c", run: copyActive },
      { bind: "r", run: refresh },
      { bind: "f", run: props.panel.toggleFullscreen },
      { bind: "q", run: props.panel.close },
      { bind: "escape", run: props.panel.close },
    ],
  }))

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={theme.background.base}>
      <box flexDirection="row" paddingLeft={1} paddingRight={1} height={1} flexShrink={0} gap={1}>
        <text fg={theme.text.base} flexGrow={1} wrapMode="none"><b>PRs ({active().length})</b></text>
        <text fg={theme.text.muted} flexShrink={0} wrapMode="none">j/k move · enter open · c copy · C copy all · r refresh · f full · q close</text>
      </box>
      <scrollbox flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
        <Show when={cache.view().unavailable}><text fg={theme.text.muted}>GitHub unavailable</text></Show>
        <Show when={!cache.view().unavailable && prs().length === 0}><text fg={theme.text.muted}>No PRs</text></Show>
        <For each={prs()}>{(pr, index) => (
          <PanelRow
            pr={pr}
            selected={() => index() === cursor()}
            focused={() => props.panel.focused}
            onSelect={() => { setCursor(index()); props.panel.focus() }}
            onOpen={() => openInBrowser(pr.url)}
            context={props.context}
          />
        )}</For>
      </scrollbox>
    </box>
  )
}

function PanelRow(props: {
  pr: PullRequest
  selected: Accessor<boolean>
  focused: Accessor<boolean>
  onSelect: () => void
  onOpen: () => void
  context: Context
}) {
  const theme = props.context.theme
  const merged = () => props.pr.state === "MERGED"
  const subdued = () => merged() ? fade(theme.text.muted, MERGED_OPACITY) : theme.text.muted
  const statusColor = () => {
    if (merged()) return subdued()
    return pullRequestStatusIsWarning(props.pr) ? theme.text.feedback.warning.base : theme.text.feedback.info.base
  }
  const checksLine = () => {
    const summary = props.pr.checkSummary
    const parts = [`${summary.passing} passing`]
    if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`)
    return `${parts.join(", ")} of ${summary.total}`
  }
  const commentsSuffix = () => {
    const label = pullRequestCommentsLabel(props.pr)
    return label ? ` · ${label}` : ""
  }
  const marker = () => {
    if (!props.selected()) return " "
    return props.focused() ? "▶" : "▷"
  }
  return (
    <box
      flexDirection="column"
      minWidth={0}
      marginBottom={1}
      backgroundColor={props.selected() ? theme.background.raised.base : undefined}
      onMouseUp={props.onSelect}
    >
      <box flexDirection="row" minWidth={0} gap={1}>
        <text fg={theme.text.base} flexShrink={0}>{marker()}</text>
        <text fg={merged() ? subdued() : theme.markdown.link} flexGrow={1} minWidth={0} wrapMode="word" onMouseUp={(event) => { event.stopPropagation(); props.onSelect(); props.onOpen() }}>
          <a href={props.pr.url}>{props.pr.title}</a>
        </text>
      </box>
      <box flexDirection="row" marginLeft={2} minWidth={0}>
        <text fg={subdued()} wrapMode="none">
          {pullRequestLabel(props.pr)}
          <span style={{ fg: statusColor() }}> · {pullRequestStatusLabel(props.pr)}</span>
          {commentsSuffix()}
          {` · +${props.pr.additions}/-${props.pr.deletions}`}
        </text>
      </box>
      <Show when={props.pr.state === "OPEN" && props.pr.checkSummary.total > 0}>
        <box flexDirection="column" marginLeft={2} minWidth={0}>
          <For each={props.pr.checkSummary.failing}>{(name) => (
            <text fg={theme.text.feedback.error.base} wrapMode="none">× {name}</text>
          )}</For>
          <For each={props.pr.checkSummary.running}>{(name) => (
            <text fg={theme.text.muted} wrapMode="none">◌ {name}</text>
          )}</For>
          <text fg={theme.text.muted} wrapMode="none"><span style={{ fg: theme.text.feedback.success.base }}>✓</span> {checksLine()}</text>
        </box>
      </Show>
    </box>
  )
}

function setup(context: Context) {
  if (typeof context.ui?.slot !== "function") return
  const cleanups: (() => void)[] = []
  // Panels and keymap layers arrived together in opencode 2.0.12; older hosts keep the sidebar only.
  const panels = typeof context.ui.panel?.open === "function" && typeof context.keymap?.layer === "function"
  if (panels) {
    cleanups.push(context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME}>
          <PullRequestPanel context={context} panel={panel} copy={(plain, html, slackTexty) => copyWithToast(context, plain, html, slackTexty)} />
        </Show>
      ),
    }))
    cleanups.push(context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "opencode-prs.panel.open",
            title: "Open pull requests panel",
            group: "Pull requests",
            palette: true,
            slash: { name: "prs" },
            run: () => {
              if (!context.ui.panel.open(PANEL_NAME)) context.ui.toast.show({ message: "Open a session to list its PRs", variant: "warning" })
            },
          }],
        }))
        return null
      },
    }))
  }
  cleanups.push(context.ui.slot({
    append: "sidebar.content",
    render: ({ sessionID }) => (
      <PullRequests
        sessionID={sessionID}
        refs={() => refsFromV2(
          context.data.session.message.list(sessionID) as readonly Message[],
          context.data.session.get(sessionID)?.time.created,
        )}
        history={() => refsFromV2History(context, sessionID)}
        sync={() => context.data.session.message.sync(sessionID)}
        focused={() => !context.ui.tabs.enabled() || context.ui.tabs.list().some((tab) => (
          tab.sessionID === context.data.session.root(sessionID) && tab.active
        ))}
        foreground={context.theme.text.base}
        subdued={context.theme.text.muted}
        link={context.theme.markdown.link}
        draft={context.theme.text.feedback.warning.base}
        open={context.theme.text.feedback.info.base}
        success={context.theme.text.feedback.success.base}
        error={context.theme.text.feedback.error.base}
        copy={(plain, html, slackTexty) => copyWithToast(context, plain, html, slackTexty)}
        onHeaderClick={panels ? () => { context.ui.panel.open(PANEL_NAME) } : undefined}
      />
    ),
  }))
  return () => cleanups.forEach((cleanup) => cleanup())
}

async function copyWithToast(context: Context, plain: string, html: string, slackTexty?: string): Promise<boolean> {
  const copied = await copyRichText(plain, html, (text) => context.renderer.copyToClipboardOSC52(text), slackTexty)
  context.ui.toast.show({
    message: copied ? "Copied to clipboard" : "Could not copy to clipboard",
    variant: copied ? "success" : "error",
  })
  return copied
}

const tui: TuiPlugin = async (api) => {
  if (typeof api.slots?.register !== "function") return
  api.slots.register({
    order: 240,
    slots: {
      sidebar_content(_ctx, props) {
        return <PullRequests
          sessionID={props.session_id}
          refs={() => refsFromV1(api, props.session_id)}
          history={() => refsFromV1History(api, props.session_id)}
          foreground={api.theme.current.text}
          subdued={api.theme.current.textMuted}
          link={api.theme.current.markdownLink}
          draft={api.theme.current.warning}
          open={api.theme.current.info}
          success={api.theme.current.success}
          error={api.theme.current.error}
          copy={async (plain, html, slackTexty) => {
            const copied = await copyRichText(plain, html, (text) => api.renderer.copyToClipboardOSC52(text), slackTexty)
            api.ui.toast({
              message: copied ? "Copied to clipboard" : "Could not copy to clipboard",
              variant: copied ? "success" : "error",
            })
            return copied
          }}
        />
      },
    },
  })
}

export default { id: "opencode-prs", tui, setup }
