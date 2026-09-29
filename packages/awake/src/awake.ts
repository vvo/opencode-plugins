import { spawn, spawnSync, type ChildProcess } from "node:child_process"

export type Log = (level: "info" | "warn", message: string) => void

export type Options = {
  lid?: boolean
  lidMaxMinutes?: number
  lidMinBattery?: number
  graceSeconds?: number
}

export type Backend = {
  name: string
  start(): void
  stop(): void
  tick?(): void
}

const END_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.deleted",
  "session.idle",
])

const HEARTBEAT_EVENTS = new Set([
  "session.step.started",
  "session.reasoning.started",
  "session.text.started",
  "session.tool.called",
  "session.tool.progress",
  "session.retry.scheduled",
  "session.compaction.started",
])

export function createHold(backends: Backend[]) {
  let on = false
  const set = (active: boolean) => {
    if (active === on) return
    on = active
    for (const backend of backends) active ? backend.start() : backend.stop()
  }
  return {
    set,
    tick: () => on && backends.forEach((backend) => backend.tick?.()),
    active: () => on,
  }
}

export type Hold = ReturnType<typeof createHold>

export function createTracker(hold: Pick<Hold, "set">, graceMs = 60_000, now = Date.now) {
  const running = new Set<string>()
  const heartbeats = new Map<string, number>()
  const update = () => hold.set(running.size + heartbeats.size > 0)
  return {
    started(sessionID: string) {
      running.add(sessionID)
      heartbeats.delete(sessionID)
      update()
    },
    heartbeat(sessionID: string) {
      if (running.has(sessionID)) return
      heartbeats.set(sessionID, now())
      update()
    },
    ended(sessionID: string) {
      running.delete(sessionID)
      heartbeats.delete(sessionID)
      update()
    },
    sweep() {
      for (const [sessionID, seen] of heartbeats) if (now() - seen > graceMs) heartbeats.delete(sessionID)
      update()
    },
    clear() {
      running.clear()
      heartbeats.clear()
      update()
    },
    size: () => running.size + heartbeats.size,
  }
}

export type Tracker = ReturnType<typeof createTracker>

export function applyV2Event(tracker: Tracker, event: unknown) {
  const { type, data } = (event ?? {}) as { type?: string; data?: { sessionID?: unknown; status?: { type?: string } } }
  const sessionID = data?.sessionID
  if (typeof type !== "string" || typeof sessionID !== "string") return
  if (type === "session.execution.started") tracker.started(sessionID)
  else if (type === "session.status") data?.status?.type === "idle" ? tracker.ended(sessionID) : tracker.started(sessionID)
  else if (END_EVENTS.has(type)) tracker.ended(sessionID)
  else if (HEARTBEAT_EVENTS.has(type)) tracker.heartbeat(sessionID)
}

export function applyV1Event(tracker: Tracker, event: unknown) {
  const { type, properties } = (event ?? {}) as {
    type?: string
    properties?: { sessionID?: string; status?: { type?: string }; info?: { id?: string } }
  }
  if (type === "session.status" && properties?.sessionID) {
    properties.status?.type === "idle" ? tracker.ended(properties.sessionID) : tracker.started(properties.sessionID)
  } else if (type === "session.idle" && properties?.sessionID) tracker.ended(properties.sessionID)
  else if (type === "session.deleted" && properties?.info?.id) tracker.ended(properties.info.id)
}

export function parseBattery(output: string) {
  const percent = output.match(/(\d+)%/)
  return {
    onBattery: output.includes("'Battery Power'"),
    percent: percent ? Number(percent[1]) : undefined,
  }
}

export function sleepDisabled(output: string) {
  return /SleepDisabled\s+1/.test(output)
}

export function linuxInhibitArgs(what: string, pid: number) {
  return [
    `--what=${what}`,
    "--who=OpenCode",
    "--why=An OpenCode session is working",
    "--mode=block",
    "tail",
    `--pid=${pid}`,
    "-f",
    "/dev/null",
  ]
}

function processBackend(name: string, variants: { command: string; args: string[] }[], log: Log): Backend {
  let child: ChildProcess | undefined
  let variant = 0
  let wanted = false
  const launch = () => {
    const { command, args } = variants[variant]!
    const current = spawn(command, args, { stdio: "ignore" })
    child = current
    current.once("error", (error) => {
      if (child === current) child = undefined
      log("warn", `${name} unavailable: ${error.message}`)
    })
    current.once("exit", (code) => {
      if (child !== current) return
      child = undefined
      if (!wanted) return
      if (code && variant < variants.length - 1) {
        variant++
        log("warn", `${name} refused ${args[0]}, retrying with ${variants[variant]!.args[0]}`)
        launch()
      } else log("warn", `${name} exited with code ${code}`)
    })
  }
  return {
    name,
    start() {
      wanted = true
      if (!child) launch()
    },
    stop() {
      wanted = false
      const current = child
      child = undefined
      current?.kill()
    },
  }
}

function pmsetBackend(options: Required<Omit<Options, "lid" | "graceSeconds">>, log: Log): Backend {
  const disable = (value: 0 | 1) => spawnSync("sudo", ["-n", "/usr/bin/pmset", "-a", "disablesleep", String(value)]).status === 0
  let allowed: boolean | undefined
  let owned = false
  let startedAt = 0
  let watchdog: ChildProcess | undefined

  const release = (reason: string) => {
    if (!owned) return
    owned = false
    try {
      if (watchdog?.pid) process.kill(-watchdog.pid, "SIGTERM")
    } catch {}
    watchdog = undefined
    disable(0)
    log("info", `lid sleep restored (${reason})`)
  }

  process.once("exit", () => owned && disable(0))

  return {
    name: "pmset",
    start() {
      if (allowed === undefined) {
        allowed = spawnSync("sudo", ["-n", "-l", "/usr/bin/pmset", "-a", "disablesleep", "1"]).status === 0
        if (!allowed) log("info", "closing the lid will still sleep this Mac, see the README to allow pmset without a password")
      }
      if (!allowed) return
      if (sleepDisabled(spawnSync("pmset", ["-g"], { encoding: "utf8" }).stdout ?? "")) return
      if (!disable(1)) return log("warn", "pmset disablesleep 1 failed")
      owned = true
      startedAt = Date.now()
      const seconds = Math.round(options.lidMaxMinutes * 60)
      watchdog = spawn(
        "/bin/sh",
        [
          "-c",
          `end=$(( $(date +%s) + ${seconds} )); while kill -0 ${process.pid} 2>/dev/null && [ $(date +%s) -lt $end ]; do sleep 10; done; sudo -n /usr/bin/pmset -a disablesleep 0`,
        ],
        { detached: true, stdio: "ignore" },
      )
      watchdog.unref()
      log("info", "lid sleep disabled while OpenCode works")
    },
    stop: () => release("sessions idle"),
    tick() {
      if (!owned) return
      if (Date.now() - startedAt > options.lidMaxMinutes * 60_000) return release("time limit")
      const battery = parseBattery(spawnSync("pmset", ["-g", "batt"], { encoding: "utf8" }).stdout ?? "")
      if (battery.onBattery && battery.percent !== undefined && battery.percent < options.lidMinBattery) {
        release(`battery at ${battery.percent}%`)
      }
    },
  }
}

export function platformBackends(options: Options, log: Log, platform = process.platform): Backend[] {
  const pid = process.pid
  if (platform === "darwin") {
    const backends = [processBackend("caffeinate", [{ command: "caffeinate", args: ["-i", "-s", "-w", String(pid)] }], log)]
    if (options.lid !== false) {
      backends.push(
        pmsetBackend({ lidMaxMinutes: options.lidMaxMinutes ?? 180, lidMinBattery: options.lidMinBattery ?? 20 }, log),
      )
    }
    return backends
  }
  if (platform === "linux") {
    const whats = options.lid === false ? ["idle:sleep"] : ["idle:sleep:handle-lid-switch", "idle:sleep"]
    return [
      processBackend(
        "systemd-inhibit",
        whats.map((what) => ({ command: "systemd-inhibit", args: linuxInhibitArgs(what, pid) })),
        log,
      ),
    ]
  }
  log("warn", `no sleep inhibitor for ${platform}`)
  return []
}
