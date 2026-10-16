/** @jsxImportSource @opentui/solid */
import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Plugin } from "plugin-v2/tui"
import { createSearchClient, databasePath, indexPath, type SearchClient, type Status } from "./client.js"
import type { Hit, SearchOutput } from "./engine.js"
import { fitSegments, relativeTime, truncate, type Segment } from "./query.js"

// Nothing is imported from @opencode-ai/plugin at runtime: on opencode 2 that specifier is
// remapped to a host builtin, while opencode 1 resolves the npm package, where v2 exports are missing.

type Context = Plugin.Context
type Color = string | RGBA

const ID = "opencode-search-sessions"
const COMMAND = `${ID}.open`
const SHORTCUT = "<leader>f"
const LIMIT = 50
const ROW_HEIGHT = 2
/** The host's xlarge dialog width; the dialog itself clamps to the terminal. */
const DIALOG_WIDTH = 116
/** Matches the host lists: one cell of scroll padding plus the row gutter. */
const INSET = 4
const PLACEHOLDER = "Search every prompt and reply…"
const EVENTS = ["session.idle", "session.renamed", "session.deleted"] as const
const SYNC_DELAY_MS = 1_500

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
// cli.json rejects keybind IDs it does not know, so the shortcut is a plugin option.
const keybindOption = (options: Readonly<Record<string, unknown>> | undefined): string | false =>
  typeof options?.keybind === "string" || options?.keybind === false ? options.keybind : SHORTCUT
const plural = (count: number, word: string) => `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`
const plain = (segments: readonly Segment[]) => segments.map((segment) => segment.text).join("")

type Palette = {
  text: Color
  muted: Color
  match: Color
  border: Color
  error: Color
  selected: Color
  selectedText: Color
  field: Color
  fieldText: Color
}

function statusLine(status: Status, output: SearchOutput | undefined, query: string): string {
  if (status.syncing && status.pending > 0 && status.sessions > 0) {
    const percent = Math.floor(((status.sessions - status.pending) / status.sessions) * 100)
    return `indexing ${percent}%`
  }
  if (!output) return ""
  if (query.trim().length < 2) return plural(output.total, "session")
  return `${plural(output.total, "session")} · ${Math.max(1, Math.round(output.elapsed))}ms`
}

function emptyMessage(input: {
  status: Status
  failure?: string
  output?: SearchOutput
  query: string
}): string {
  if (input.status.state === "failed") return `Search is unavailable. ${input.status.error}`
  if (input.failure) return `Search failed: ${input.failure}. Change the query to try again.`
  if (!input.output) return "Opening the search index…"
  const query = input.query.trim()
  if (query.length < 2) return input.status.syncing ? "Indexing your sessions…" : "No sessions yet"
  if (input.status.syncing) return `Nothing yet. ${plural(input.status.pending, "session")} left to index.`
  return `No sessions match “${query}”`
}

function Segments(props: { segments: readonly Segment[]; color: Color; match: Color }): JSX.Element {
  return (
    <For each={props.segments}>
      {(segment) =>
        segment.hit ? (
          <b>
            <span style={{ fg: props.match }}>{segment.text}</span>
          </b>
        ) : (
          <span style={{ fg: props.color }}>{segment.text}</span>
        )
      }
    </For>
  )
}

function ResultRow(props: {
  hit: Hit
  active: boolean
  current: boolean
  scoped: boolean
  width: number
  now: number
  palette: Palette
  onHover: () => void
  onOpen: () => void
}) {
  const meta = () =>
    [props.scoped ? undefined : props.hit.project, relativeTime(props.hit.updated, props.now)].filter(Boolean).join(" · ")
  // Two gutter cells, then the text; the meta takes its own width plus a two-cell gap.
  const titleWidth = () => Math.max(8, props.width - 2 - meta().length - 2)
  const title = () => {
    const segments = props.hit.title
    const text = plain(segments)
    if (text.length <= titleWidth()) return segments
    return [{ text: truncate(text, titleWidth()), hit: false }]
  }
  const snippet = () => fitSegments(props.hit.snippet, Math.max(8, props.width - 4))
  const text = () => (props.active ? props.palette.selectedText : props.palette.text)
  const muted = () => (props.active ? props.palette.selectedText : props.palette.muted)
  const match = () => (props.active ? props.palette.selectedText : props.palette.match)
  return (
    <box
      flexDirection="column"
      paddingLeft={1}
      paddingRight={INSET - 1}
      backgroundColor={props.active ? props.palette.selected : undefined}
      onMouseMove={props.onHover}
      onMouseDown={props.onHover}
      onMouseUp={props.onOpen}
    >
      <box flexDirection="row" gap={1}>
        <text flexShrink={0} fg={text()}>
          {props.current ? "●" : " "}
        </text>
        <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" fg={text()}>
          <Show when={props.active} fallback={<Segments segments={title()} color={text()} match={match()} />}>
            <b>
              <Segments segments={title()} color={text()} match={match()} />
            </b>
          </Show>
        </text>
        <text flexShrink={0} wrapMode="none" fg={muted()}>
          {" " + meta()}
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        <text flexShrink={0}> </text>
        <text flexGrow={1} flexShrink={1} minWidth={0} wrapMode="none" fg={muted()}>
          {/* The bar mirrors how OpenCode draws your own messages in a session. */}
          <span style={{ fg: props.active ? props.palette.selectedText : props.palette.border }}>
            {props.hit.role === "user" ? "┃ " : "  "}
          </span>
          <Segments segments={snippet()} color={muted()} match={match()} />
        </text>
      </box>
    </box>
  )
}

function SearchDialog(props: { context: Context; client: SearchClient; query?: string; current?: string }) {
  const context = props.context
  const dimensions = useTerminalDimensions()
  const theme = () => (typeof context.theme.surface === "function" ? context.theme.surface("dialog") : context.theme)
  const palette = createMemo<Palette>(() => ({
    text: theme().text.base,
    muted: theme().text.muted,
    match: theme().text.action.primary.base,
    border: theme().border.base,
    error: theme().text.feedback.error.base,
    selected: theme().background.action.primary.focused,
    selectedText: theme().text.action.primary.focused,
    field: theme().background.formfield.focused,
    fieldText: theme().text.formfield.focused,
  }))
  const [prefs, setPrefs] = context.storage.store("preferences", { initial: { project: false } })
  const [query, setQuery] = createSignal(props.query ?? "")
  const [output, setOutput] = createSignal<SearchOutput>()
  const [failure, setFailure] = createSignal<string>()
  const [selected, setSelected] = createSignal(0)
  const [status, setStatus] = createSignal(props.client.status())
  const [refresh, setRefresh] = createSignal(0)
  onCleanup(props.client.subscribe(setStatus))

  // While a first build runs, results fill in as more sessions reach the index.
  const syncing = createMemo(() => status().syncing)
  createEffect(() => {
    if (!syncing()) return
    const timer = setInterval(() => setRefresh((value) => value + 1), 1_200)
    onCleanup(() => {
      clearInterval(timer)
      setRefresh((value) => value + 1)
    })
  })

  const hits = () => output()?.hits ?? []
  const now = createMemo(() => (output(), Date.now()))
  const width = () => Math.min(DIALOG_WIDTH, dimensions().width - 2) - 2 - INSET
  const visibleRows = createMemo(() => Math.max(2, Math.floor((Math.floor(dimensions().height * 0.55) - 7) / ROW_HEIGHT)))
  let scroll: ScrollBoxRenderable | undefined

  const reveal = (index: number) => {
    if (!scroll) return
    const top = index * ROW_HEIGHT
    const height = visibleRows() * ROW_HEIGHT
    if (top < scroll.scrollTop) scroll.scrollTop = top
    else if (top + ROW_HEIGHT > scroll.scrollTop + height) scroll.scrollTop = top + ROW_HEIGHT - height
  }
  const select = (index: number) => {
    setSelected(index)
    reveal(index)
  }
  const move = (delta: number) => {
    const count = hits().length
    if (count === 0) return
    if (Math.abs(delta) === 1) select((selected() + delta + count) % count)
    else select(Math.max(0, Math.min(count - 1, selected() + delta)))
  }

  // The host knows which project a directory belongs to, including a worktree no session used yet.
  const directory = context.location?.directory ?? context.data.location.default()?.directory
  const [projectID, setProjectID] = createSignal<string>()
  if (directory) {
    context.client.location
      .get({ location: { directory } })
      .then((info) => setProjectID(info.project.id))
      .catch(() => undefined)
  }

  let request = 0
  let shownQuery: string | undefined
  createEffect(
    on([query, () => prefs.project, projectID, refresh], ([text, project, id]) => {
      const current = ++request
      const timer = setTimeout(() => {
        props.client
          .search({
            query: text,
            limit: LIMIT,
            ...(project ? { directory, projectID: id } : {}),
          })
          .then((result) => {
            if (current !== request) return
            // A refresh of the same query keeps the selected session; a new query starts at the top.
            const keep = shownQuery === text ? hits()[selected()]?.sessionID : undefined
            const index = keep ? result.hits.findIndex((hit) => hit.sessionID === keep) : -1
            shownQuery = text
            batch(() => {
              setOutput(result)
              setFailure(undefined)
              setSelected(Math.max(0, index))
            })
            if (index < 0 && scroll) scroll.scrollTop = 0
            else reveal(index)
          })
          .catch((error: unknown) => {
            if (current === request) setFailure(message(error))
          })
      }, 25)
      onCleanup(() => clearTimeout(timer))
    }),
  )

  const open = (sessionID: string) => {
    context.ui.dialog.clear()
    if (context.ui.tabs?.enabled?.()) context.ui.tabs.focus(sessionID)
    else context.ui.router.navigate({ type: "session", sessionID })
  }
  const openSelected = () => {
    const hit = hits()[selected()]
    if (hit) open(hit.sessionID)
  }
  const toggleScope = () =>
    void setPrefs((draft) => {
      draft.project = !draft.project
    }).catch(() => undefined)

  // The host's own dialog command IDs, so custom list keybindings carry over.
  context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { id: "dialog.select.prev", title: "Previous result", group: "Dialog", bind: "up,ctrl+p", run: () => move(-1) },
      { id: "dialog.select.next", title: "Next result", group: "Dialog", bind: "down,ctrl+n", run: () => move(1) },
      { id: "dialog.select.page_up", title: "Page up", group: "Dialog", bind: "pageup", run: () => move(-visibleRows()) },
      { id: "dialog.select.page_down", title: "Page down", group: "Dialog", bind: "pagedown", run: () => move(visibleRows()) },
      { id: "dialog.select.submit", title: "Open session", group: "Dialog", bind: "return", run: openSelected },
      {
        bind: "ctrl+a",
        title: prefs.project ? "Search all projects" : "Search this project",
        group: "Dialog",
        run: toggleScope,
      },
    ],
  }))

  return (
    <box gap={1} paddingBottom={1}>
      <box paddingLeft={INSET} paddingRight={INSET}>
        <box flexDirection="row" justifyContent="space-between" gap={2}>
          <box flexDirection="row" flexShrink={1} minWidth={0}>
            <text fg={palette().text} flexShrink={0}>
              <b>Search sessions</b>
            </text>
            <Show when={prefs.project && output()?.scope}>
              <text fg={palette().muted} wrapMode="none">
                {" in " + output()?.scope}
              </text>
            </Show>
          </box>
          <text fg={palette().muted} flexShrink={0} onMouseUp={() => context.ui.dialog.clear()}>
            esc
          </text>
        </box>
        <box paddingTop={1}>
          <input
            value={props.query ?? ""}
            placeholder={PLACEHOLDER}
            placeholderColor={palette().muted}
            focusedBackgroundColor={palette().field}
            focusedTextColor={palette().fieldText}
            cursorColor={palette().fieldText}
            onInput={(value) => setQuery(value)}
            ref={(input) => {
              setTimeout(() => {
                if (!input.isDestroyed) input.focus()
              }, 1)
            }}
          />
        </box>
      </box>
      <Show
        when={hits().length > 0}
        fallback={
          <box paddingLeft={INSET} paddingRight={INSET}>
            <text fg={status().state === "failed" || failure() ? palette().error : palette().muted}>
              {emptyMessage({ status: status(), failure: failure(), output: output(), query: query() })}
            </text>
          </box>
        }
      >
        <scrollbox
          paddingLeft={1}
          paddingRight={1}
          height={Math.min(hits().length, visibleRows()) * ROW_HEIGHT}
          scrollbarOptions={{ visible: false }}
          ref={(renderable: ScrollBoxRenderable) => (scroll = renderable)}
        >
          <For each={hits()}>
            {(hit, index) => (
              <ResultRow
                hit={hit}
                active={index() === selected()}
                current={hit.sessionID === props.current}
                scoped={prefs.project}
                width={width()}
                now={now()}
                palette={palette()}
                onHover={() => {
                  if (index() !== selected()) setSelected(index())
                }}
                onOpen={() => open(hit.sessionID)}
              />
            )}
          </For>
        </scrollbox>
      </Show>
      <box paddingLeft={INSET} paddingRight={INSET} flexDirection="row" justifyContent="space-between" gap={2}>
        <text wrapMode="none" onMouseUp={toggleScope}>
          <span style={{ fg: palette().text }}>{prefs.project ? "all projects" : "this project"}</span>
          <span style={{ fg: palette().muted }}> ctrl+a</span>
        </text>
        <text fg={palette().muted} wrapMode="none" flexShrink={0}>
          {statusLine(status(), output(), query())}
        </text>
      </box>
    </box>
  )
}

/**
 * A one-line field under the home prompt, drawn like a smaller prompt: same surface, a
 * neutral bar instead of the agent color. A click opens the search dialog.
 */
function HomeSearch(props: { context: Context; open: () => void }) {
  const dimensions = useTerminalDimensions()
  const [hovered, setHovered] = createSignal(false)
  const theme = () => props.context.theme
  const surface = () => theme().decrease?.(theme().background.raised.base) ?? theme().background.raised.base
  const shortcut = () => props.context.keymap.shortcuts(COMMAND)[0]
  return (
    <Show when={dimensions().height >= 24}>
      <box
        position="absolute"
        top={2}
        left={0}
        width="100%"
        height={1}
        flexDirection="row"
        onMouseOver={() => setHovered(true)}
        onMouseOut={() => setHovered(false)}
        onMouseUp={props.open}
      >
        <text flexShrink={0} fg={hovered() ? theme().text.muted : theme().border.base}>
          ┃
        </text>
        <box flexGrow={1} flexDirection="row" paddingLeft={2} paddingRight={2} gap={2} backgroundColor={surface()}>
          <text flexGrow={1} wrapMode="none" fg={hovered() ? theme().text.base : theme().text.muted}>
            Search sessions
          </text>
          <Show when={shortcut()}>
            <text flexShrink={0} wrapMode="none" fg={theme().text.base}>
              {shortcut()}
            </text>
          </Show>
        </box>
      </box>
    </Show>
  )
}

// ---------------------------------------------------------------------------
// opencode 2
// ---------------------------------------------------------------------------

function setup(context: Context) {
  if (typeof context.keymap?.layer !== "function" || typeof context.ui?.dialog?.show !== "function") return
  const database = typeof context.options.database === "string" ? context.options.database : databasePath(context.app?.channel)
  const client = createSearchClient({
    database,
    index: typeof context.options.index === "string" ? context.options.index : indexPath(database, "v2"),
    flavor: "v2",
  })

  let showing = false
  const open = (query?: string) => {
    // The shortcut stays live in dialogs; pressing it again inside search would reset the query.
    if (showing) return
    showing = true
    client.sync()
    const route = context.ui.router.current()
    const current = route.type === "session" ? context.data.session.root(route.sessionID) : undefined
    context.ui.dialog.show(
      () => <SearchDialog context={context} client={client} query={query?.trim()} current={current} />,
      () => {
        showing = false
      },
    )
    context.ui.dialog.set({ size: "xlarge" })
  }

  // Global like OpenCode's own session list: the command palette only lists commands that stay
  // reachable while it is open, and it is a dialog itself.
  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND,
        title: "Search sessions",
        description: "Find any prompt or reply across every session",
        group: "Session",
        palette: true,
        bind: keybindOption(context.options),
        slash: { name: "search", arguments: true },
        run: (input) => open(input),
      },
    ],
  }))

  const cleanups: (() => void)[] = [() => client.dispose()]
  if (context.options.home !== false) {
    cleanups.push(
      context.ui.slot({
        append: "prompt.footer",
        render: (input) => (
          <Show when={!input.sessionID && input.mode === "normal"}>
            <HomeSearch context={context} open={() => open()} />
          </Show>
        ),
      }),
    )
  }

  // A finished turn, a rename or a deletion changes what search should find.
  const hints = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  for (const type of EVENTS) {
    cleanups.push(
      context.data.on(type, (event) => {
        const sessionID = (event as { data?: { sessionID?: string } }).data?.sessionID
        if (sessionID) hints.add(context.data.session.root(sessionID) ?? sessionID)
        clearTimeout(timer)
        timer = setTimeout(() => {
          client.sync([...hints])
          hints.clear()
        }, SYNC_DELAY_MS)
      }),
    )
  }
  cleanups.push(() => clearTimeout(timer))
  return () => cleanups.forEach((cleanup) => cleanup())
}

// ---------------------------------------------------------------------------
// opencode 1
// ---------------------------------------------------------------------------

function SearchDialogV1(props: { api: TuiPluginApi; client: SearchClient; query?: string }) {
  const [output, setOutput] = createSignal<SearchOutput>()
  let request = 0
  const search = (query: string) => {
    const id = ++request
    props.client
      .search({ query, limit: LIMIT })
      .then((result) => {
        if (id === request) setOutput(result)
      })
      .catch(() => undefined)
  }
  search(props.query ?? "")
  const now = createMemo(() => (output(), Date.now()))
  const options = () =>
    (output()?.hits ?? []).map((hit) => ({
      title: plain(hit.title),
      value: hit.sessionID,
      description: truncate(plain(hit.snippet), 72),
      footer: `${hit.project} · ${relativeTime(hit.updated, now())}`,
    }))
  const DialogSelect = props.api.ui.DialogSelect
  return (
    <DialogSelect
      title="Search sessions"
      placeholder={PLACEHOLDER}
      options={options()}
      skipFilter
      flat
      onFilter={search}
      onSelect={(option) => {
        props.api.ui.dialog.clear()
        props.api.route.navigate("session", { sessionID: option.value })
      }}
    />
  )
}

type LegacyKeymap = {
  registerLayer?: (layer: {
    commands: { name: string; title: string; category: string; namespace: string; slashName: string; run: () => void }[]
    bindings: { key: string; cmd: string; desc: string }[]
  }) => unknown
}

const tui: TuiPlugin = async (api, options) => {
  const database = typeof options?.database === "string" ? options.database : databasePath()
  const client = createSearchClient({
    database,
    index: typeof options?.index === "string" ? options.index : indexPath(database, "v1"),
    flavor: "v1",
  })
  api.lifecycle.onDispose(() => client.dispose())
  const open = () => {
    client.sync()
    api.ui.dialog.replace(() => <SearchDialogV1 api={api} client={client} />)
    api.ui.dialog.setSize("large")
  }

  const keymap = api.keymap as unknown as LegacyKeymap | undefined
  const key = keybindOption(options)
  if (typeof keymap?.registerLayer === "function") {
    keymap.registerLayer({
      commands: [
        { name: COMMAND, title: "Search sessions", category: "Session", namespace: "palette", slashName: "search", run: open },
      ],
      bindings: key ? [{ key, cmd: COMMAND, desc: "Search sessions" }] : [],
    })
  } else {
    api.command?.register(() => [
      { title: "Search sessions", value: COMMAND, category: "Session", slash: { name: "search" }, onSelect: open },
    ])
  }

  if (options?.home !== false && typeof api.slots?.register === "function") {
    api.slots.register({
      order: 500,
      slots: {
        home_bottom() {
          return (
            <box flexDirection="row" justifyContent="center" paddingTop={1} onMouseUp={open}>
              <text fg={api.theme.current.textMuted}>
                Search sessions <span style={{ fg: api.theme.current.text }}>/search</span>
              </text>
            </box>
          )
        },
      },
    })
  }
}

export default { id: ID, tui, setup }
