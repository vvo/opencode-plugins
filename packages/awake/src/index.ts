import type { Plugin as V1Plugin } from "@opencode-ai/plugin"
import type { Plugin as V2Plugin } from "plugin-v2/promise/plugin"
import { applyV1Event, applyV2Event, createHold, createTracker, platformBackends, type Log, type Options } from "./awake.js"

const ID = "opencode-awake"
const TICK_MS = 15_000

function start(options: Options, log: Log) {
  const hold = createHold(platformBackends(options, log))
  const tracker = createTracker(hold, (options.graceSeconds ?? 60) * 1000)
  const timer = setInterval(() => {
    tracker.sweep()
    hold.tick()
  }, TICK_MS)
  timer.unref()
  return {
    tracker,
    stop() {
      clearInterval(timer)
      tracker.clear()
    },
  }
}

const v2: V2Plugin = {
  id: ID,
  setup(ctx) {
    const log: Log = (level, message) => console[level](`[${ID}] ${message}`)
    const awake = start(ctx.options as Options, log)
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) applyV2Event(awake.tracker, event)
      } catch (error) {
        if (!controller.signal.aborted) log("warn", `event stream closed: ${String(error)}`)
      }
    })()
    return () => {
      controller.abort()
      awake.stop()
    }
  },
}

const server: V1Plugin = async (input, options) => {
  const log: Log = (level, message) =>
    void input.client.app.log({ body: { service: ID, level, message } }).catch(() => {})
  const awake = start((options ?? {}) as Options, log)
  return {
    event: async ({ event }) => applyV1Event(awake.tracker, event),
    dispose: async () => awake.stop(),
  }
}

export default { ...v2, server }
export { server }
