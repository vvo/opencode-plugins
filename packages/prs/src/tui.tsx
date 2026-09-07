/** @jsxImportSource @opentui/solid */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createEffect, createSignal, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import type { RGBA } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Plugin } from "plugin-v2/tui"
import {
  extractCreatedPullRequests,
  marquee,
  pullRequestStatus,
  slackPullRequest,
  slackPullRequestHtml,
  sortPullRequests,
  uniquePullRequests,
  type PullRequest,
  type PullRequestRef,
} from "./prs.js"

const execFileAsync = promisify(execFile)
const REFRESH_MS = 60_000
const MAX_HISTORY_PAGES = 50
const MAX_VISIBLE_PRS = 10
const MARQUEE_DELAY_MS = 500
const MARQUEE_STEP_MS = 120
const RICH_CLIPBOARD_SCRIPT = `ObjC.import("AppKit")
function run(argv) {
  const decode = (value) => $.NSString.alloc.initWithDataEncoding(
    $.NSData.alloc.initWithBase64EncodedStringOptions(value, 0),
    $.NSUTF8StringEncoding,
  )
  const pasteboard = $.NSPasteboard.generalPasteboard
  pasteboard.clearContents
  pasteboard.setStringForType(decode(argv[0]), $.NSPasteboardTypeString)
  pasteboard.setStringForType(decode(argv[1]), $.NSPasteboardTypeHTML)
}`
type Context = Plugin.Context
type Message = { type?: string; content?: unknown[] }
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
}

const sessionCache = new Map<string, SessionCache>()

async function copyRichText(plain: string, html: string, fallback: (text: string) => boolean): Promise<boolean> {
  if (process.platform !== "darwin") return fallback(plain)
  try {
    await execFileAsync("/usr/bin/osascript", [
      "-l",
      "JavaScript",
      "-e",
      RICH_CLIPBOARD_SCRIPT,
      Buffer.from(plain).toString("base64"),
      Buffer.from(html).toString("base64"),
    ])
    return true
  } catch {
    return fallback(plain)
  }
}

function getSessionCache(sessionID: string): SessionCache {
  let cache = sessionCache.get(sessionID)
  if (!cache) {
    cache = { history: [], prs: [], refsKey: "", unavailable: false }
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
    left.createdAt === right.createdAt &&
    left.additions === right.additions &&
    left.deletions === right.deletions
  )
}

function pullRequestRefsKey(refs: Iterable<PullRequestRef>): string {
  return uniquePullRequests(refs).map((ref) => ref.url).join("\n")
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
  numberWidth: number
  subdued: string | RGBA
  link: string | RGBA
  draft: string | RGBA
  open: string | RGBA
  copy: (plain: string, html: string) => Promise<boolean>
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
  const titleColor = () => (merged() ? props.subdued : props.link)
  const statusColor = () => {
    if (merged()) return props.subdued
    return props.pr.isDraft ? props.draft : props.open
  }

  return (
    <box
      flexDirection="column"
      minWidth={0}
      onMouseOver={() => setHovered(true)}
      onMouseOut={() => setHovered(false)}
    >
      <box flexDirection="row" minWidth={0}>
        <text fg={props.subdued} flexShrink={0}>• </text>
        <box flexGrow={1} minWidth={0} overflow="hidden" onSizeChange={function () { setWidth(this.width) }}>
          <text fg={titleColor()} wrapMode="none"><a href={props.pr.url}>{marquee(props.pr.title, width(), offset())}</a></text>
        </box>
      </box>
      <box flexDirection="row" marginLeft={2}>
        <text fg={props.subdued}>
          #{String(props.pr.number).padStart(props.numberWidth)}
          <span style={{ fg: statusColor() }}> · {pullRequestStatus(props.pr)}</span>
        </text>
        <text
          fg={props.subdued}
          onMouseUp={() => props.copy(slackPullRequest(props.pr), slackPullRequestHtml(props.pr))}
        > · ⧉</text>
      </box>
    </box>
  )
}

async function fetchPullRequest(ref: PullRequestRef): Promise<PullRequest | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", ["pr", "view", ref.url, "--json", "title,state,url,number,isDraft,createdAt,additions,deletions"])
    const data = JSON.parse(stdout) as Pick<PullRequest, "title" | "state" | "url" | "number" | "isDraft" | "createdAt" | "additions" | "deletions">
    return { ...ref, ...data }
  } catch {
    return undefined
  }
}

function refsFromV2(messages: readonly Message[]): PullRequestRef[] {
  const refs: PullRequestRef[] = []
  for (const message of messages) {
    if (message.type !== "assistant") continue
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
  for (const message of api.state.session.messages(sessionID)) {
    for (const part of api.state.part(message.id)) {
      if (part.type !== "tool" || part.tool !== "shell" || part.state.status !== "completed") continue
      const input = part.state.input as { command?: string }
      refs.push(...extractCreatedPullRequests(input.command ?? "", part.state.output))
    }
  }
  return refs
}

async function refsFromV2History(context: Context, sessionID: string): Promise<PullRequestRef[]> {
  const refs: PullRequestRef[] = []
  let cursor: string | undefined
  let page = 0
  do {
    const response = await context.client.message.list({ sessionID, limit: 200, ...(cursor ? { cursor } : {}) })
    refs.push(...refsFromV2(response.data as readonly Message[]))
    cursor = response.cursor.next ?? undefined
    page++
  } while (cursor && page < MAX_HISTORY_PAGES)
  return refs
}

async function refsFromV1History(api: TuiPluginApi, sessionID: string): Promise<PullRequestRef[]> {
  const response = await api.client.session.messages({ sessionID })
  const refs: PullRequestRef[] = []
  for (const item of response.data ?? []) {
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
  foreground: string | RGBA
  subdued: string | RGBA
  link: string | RGBA
  draft: string | RGBA
  open: string | RGBA
  copy: (plain: string, html: string) => Promise<boolean>
}) {
  const cache = getSessionCache(props.sessionID)
  const [open, setOpen] = createSignal(true)
  const [prs, setPrs] = createSignal<PullRequest[]>(cache.prs)
  const [unavailable, setUnavailable] = createSignal(cache.unavailable)
  const visiblePrs = () => sortPullRequests(prs()).slice(0, MAX_VISIBLE_PRS)
  const numberWidth = () => Math.max(1, ...visiblePrs().map((pr) => String(pr.number).length))
  let mounted = true
  let observedRefsKey = pullRequestRefsKey(props.refs())
  const showCache = () => {
    if (!mounted) return
    setPrs(cache.prs)
    setUnavailable(cache.unavailable)
  }
  const refresh = async (force = false) => {
    const refs = uniquePullRequests([...cache.history, ...props.refs()])
    const refsKey = pullRequestRefsKey(refs)
    if (!force && refsKey === cache.refsKey) return
    if (!cache.refreshPromise) {
      cache.refreshPromise = Promise.all(refs.map(fetchPullRequest)).then((results) => {
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
  createEffect(() => {
    const refsKey = pullRequestRefsKey(props.refs())
    if (refsKey === observedRefsKey) return
    observedRefsKey = refsKey
    void refresh()
  })
  onMount(() => {
    cache.historyPromise ??= props.history()
    void cache.historyPromise.then((value) => {
      cache.history = value
      void refresh(true)
    })
    const interval = setInterval(() => void refresh(true), REFRESH_MS)
    onCleanup(() => {
      mounted = false
      clearInterval(interval)
    })
  })
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1} onMouseUp={() => setOpen((value) => !value)}>
        <text fg={props.foreground}>{open() ? "▼" : "▶"}</text>
        <text fg={props.foreground}><b>PRs ({prs().length})</b></text>
      </box>
      <Show when={open()}>
        <Show when={unavailable()}><text fg={props.subdued}>GitHub unavailable</text></Show>
        <Show when={!unavailable() && prs().length === 0}><text fg={props.subdued}>No PRs</text></Show>
        <For each={visiblePrs()}>{(pr) => (
          <PullRequestRow
            pr={pr}
            numberWidth={numberWidth()}
            subdued={props.subdued}
            link={props.link}
            draft={props.draft}
            open={props.open}
            copy={props.copy}
          />
        )}</For>
      </Show>
    </box>
  )
}

function setup(context: Context) {
  if (typeof context.ui?.slot !== "function") return
  return context.ui.slot({
    append: "sidebar.content",
    render: ({ sessionID }) => (
      <PullRequests
        sessionID={sessionID}
        refs={() => refsFromV2(context.data.session.message.list(sessionID) as readonly Message[])}
        history={() => refsFromV2History(context, sessionID)}
        foreground={context.theme.text.default}
        subdued={context.theme.text.subdued}
        link={context.theme.markdown.link}
        draft={context.theme.text.feedback.warning.default}
        open={context.theme.text.feedback.info.default}
        copy={async (plain, html) => {
          const copied = await copyRichText(plain, html, (text) => context.renderer.copyToClipboardOSC52(text))
          context.ui.toast.show({
            message: copied ? "Copied to clipboard" : "Could not copy to clipboard",
            variant: copied ? "success" : "error",
          })
          return copied
        }}
      />
    ),
  })
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
          copy={async (plain, html) => {
            const copied = await copyRichText(plain, html, (text) => api.renderer.copyToClipboardOSC52(text))
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
