import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { Worker } from "node:worker_threads"
import { Engine, type Flavor, type SearchInput, type SearchOutput } from "./engine.js"

export type Status = {
  readonly state: "starting" | "ready" | "failed"
  /** Sessions in the index. */
  readonly sessions: number
  /** Sessions left to index in the current pass. */
  readonly pending: number
  readonly syncing: boolean
  readonly error?: string
}

export type SearchClient = {
  search(input: SearchInput): Promise<SearchOutput>
  /** Indexes new and changed sessions. Hinted sessions are rechecked even when their row looks unchanged. */
  sync(hints?: readonly string[]): void
  status(): Status
  subscribe(listener: (status: Status) => void): () => void
  dispose(): void
}

type Options = { readonly database: string; readonly index: string; readonly flavor: Flavor }

type Backend = {
  search(input: SearchInput): Promise<SearchOutput>
  sync(hints?: readonly string[]): void
  dispose(): void
}

type Update = (next: Partial<Status>) => void

const CHANNELS_SHARING_DEFAULT_DB = ["latest", "dev", "beta", "next", "prod"]

/** Where OpenCode keeps its database, resolved the way the OpenCode CLI does. */
export function databasePath(channel?: string): string {
  const data = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode")
  const shared =
    !channel ||
    CHANNELS_SHARING_DEFAULT_DB.includes(channel) ||
    ["1", "true"].includes(process.env.OPENCODE_DISABLE_CHANNEL_DB ?? "")
  const file = process.env.OPENCODE_DB ?? (shared ? "opencode.db" : `opencode-${channel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  return resolve(data, file)
}

/** The search index is derived data: safe to delete, rebuilt on the next start. */
export function indexPath(database: string, flavor: Flavor): string {
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), ".cache")
  const id = createHash("sha256").update(database).digest("hex").slice(0, 12)
  return join(cache, "opencode-search-sessions", `${flavor}-${id}.sqlite`)
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function workerBackend(options: Options, update: Update, onCrash: () => void): Backend {
  const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: options })
  // An idle index must never keep OpenCode from exiting.
  worker.unref()
  let started = false
  let next = 0
  const pending = new Map<number, { resolve: (output: SearchOutput) => void; reject: (error: Error) => void }>()
  const rejectAll = (error: Error) => {
    for (const request of pending.values()) request.reject(error)
    pending.clear()
  }
  worker.on("message", (event: { type: string; id?: number; [key: string]: any }) => {
    if (event.type === "ready") {
      started = true
      update({ state: "ready", sessions: event.sessions, error: undefined })
    } else if (event.type === "failed") {
      update(started ? { error: event.message } : { state: "failed", error: event.message })
    } else if (event.type === "progress") {
      update({ sessions: event.progress.sessions, pending: event.progress.pending, syncing: event.progress.syncing })
    } else if (event.id !== undefined) {
      const request = pending.get(event.id)
      pending.delete(event.id)
      if (event.type === "result") request?.resolve(event.output)
      else request?.reject(new Error(event.message))
    }
  })
  worker.on("error", (error) => {
    rejectAll(error)
    if (!started) onCrash()
    else update({ error: error.message })
  })
  return {
    search(input) {
      return new Promise((resolve, reject) => {
        const id = ++next
        pending.set(id, { resolve, reject })
        worker.postMessage({ id, type: "search", input })
      })
    },
    sync(hints) {
      worker.postMessage({ id: ++next, type: "sync", hints })
    },
    dispose() {
      rejectAll(new Error("search closed"))
      void worker.terminate()
    },
  }
}

// Same engine on the UI thread, in short slices, for hosts that cannot start a worker.
function inlineBackend(options: Options, update: Update): Backend {
  const engine = Engine.open(options)
  engine.then(
    (opened) => update({ state: "ready", sessions: opened.sessionCount(), error: undefined }),
    (error: unknown) => update({ state: "failed", error: message(error) }),
  )
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 8))
  return {
    async search(input) {
      return (await engine).search(input)
    },
    sync(hints) {
      void engine
        .then(async (opened) => {
          const changed = await opened.sync({
            hints,
            pause,
            slice: 8,
            progress: (progress) =>
              update({ sessions: progress.sessions, pending: progress.pending, syncing: progress.syncing }),
          })
          if (changed) opened.refreshLexicon()
        })
        .catch((error: unknown) => update({ error: message(error) }))
    },
    dispose() {
      void engine.then((opened) => opened.close()).catch(() => undefined)
    },
  }
}

export function createSearchClient(options: Options): SearchClient {
  let status: Status = { state: "starting", sessions: 0, pending: 0, syncing: false }
  const listeners = new Set<(status: Status) => void>()
  const update: Update = (next) => {
    status = { ...status, ...next }
    for (const listener of listeners) listener(status)
  }
  const base = {
    status: () => status,
    subscribe(listener: (status: Status) => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
  }
  if (!existsSync(options.database)) {
    update({
      state: "failed",
      error: `No OpenCode database at ${options.database}. Set the plugin's database option to its path.`,
    })
    return {
      ...base,
      search: () => Promise.reject(new Error(status.error)),
      sync: () => undefined,
      dispose: () => listeners.clear(),
    }
  }

  let backend: Backend
  try {
    backend = workerBackend(options, update, () => {
      backend = inlineBackend(options, update)
      backend.sync()
    })
  } catch {
    backend = inlineBackend(options, update)
  }
  backend.sync()

  return {
    ...base,
    search: (input) => backend.search(input),
    sync: (hints) => backend.sync(hints),
    dispose() {
      listeners.clear()
      backend.dispose()
    },
  }
}
