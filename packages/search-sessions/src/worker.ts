// Runs the engine off the UI thread: indexing and searching never block a keystroke.
import { parentPort, workerData } from "node:worker_threads"
import { Engine, type Flavor, type SearchInput } from "./engine.js"

export type WorkerRequest =
  | { readonly id: number; readonly type: "search"; readonly input: SearchInput }
  | { readonly id: number; readonly type: "sync"; readonly hints?: readonly string[] }

const port = parentPort
if (!port) throw new Error("opencode-search-sessions: worker started outside a worker thread")
const options = workerData as { database: string; index: string; flavor: Flavor }

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const idle = () => new Promise<void>((resolve) => setImmediate(resolve))

const ready = Engine.open(options).then(
  (engine) => {
    port.postMessage({ type: "ready", sessions: engine.sessionCount() })
    return engine
  },
  (error: unknown) => {
    port.postMessage({ type: "failed", message: message(error) })
    return undefined
  },
)

async function sync(engine: Engine, hints?: readonly string[]) {
  try {
    const changed = await engine.sync({
      hints,
      pause: idle,
      progress: (progress) => port!.postMessage({ type: "progress", progress }),
    })
    if (!changed) return
    // Rebuilt between requests so the next search does not pay for it.
    await idle()
    engine.refreshLexicon()
  } catch (error) {
    port!.postMessage({ type: "failed", message: message(error) })
  }
}

port.on("message", async (request: WorkerRequest) => {
  const engine = await ready
  if (!engine) {
    port.postMessage({ id: request.id, type: "error", message: "search index unavailable" })
    return
  }
  if (request.type === "sync") {
    void sync(engine, request.hints)
    return
  }
  try {
    port.postMessage({ id: request.id, type: "result", output: engine.search(request.input) })
  } catch (error) {
    port.postMessage({ id: request.id, type: "error", message: message(error) })
  }
})
