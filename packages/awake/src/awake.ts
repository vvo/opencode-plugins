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
  return {
    set(active: boolean) {
      if (active === on) return
      on = active
      for (const backend of backends) {
        if (active) backend.start()
        else backend.stop()
      }
    },
    tick() {
      if (!on) return
      for (const backend of backends) backend.tick?.()
    },
  }
}

export type Hold = ReturnType<typeof createHold>

export function createTracker(hold: Pick<Hold, "set">, graceMs = 60_000, now = Date.now) {
  const running = new Set<string>()
  const heartbeats = new Map<string, number>()
  const size = () => running.size + heartbeats.size
  const update = () => hold.set(size() > 0)
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
    size,
  }
}

export type Tracker = ReturnType<typeof createTracker>

function applyStatus(tracker: Tracker, sessionID: string, status: string | undefined) {
  if (status === "idle") tracker.ended(sessionID)
  else tracker.started(sessionID)
}

export function applyV2Event(tracker: Tracker, event: unknown) {
  const { type, data } = (event ?? {}) as { type?: string; data?: { sessionID?: unknown; status?: { type?: string } } }
  const sessionID = data?.sessionID
  if (typeof type !== "string" || typeof sessionID !== "string") return
  if (type === "session.execution.started") tracker.started(sessionID)
  else if (type === "session.status") applyStatus(tracker, sessionID, data?.status?.type)
  else if (END_EVENTS.has(type)) tracker.ended(sessionID)
  else if (HEARTBEAT_EVENTS.has(type)) tracker.heartbeat(sessionID)
}

export function applyV1Event(tracker: Tracker, event: unknown) {
  const { type, properties } = (event ?? {}) as {
    type?: string
    properties?: { sessionID?: string; status?: { type?: string }; info?: { id?: string } }
  }
  const sessionID = properties?.sessionID
  if (type === "session.status" && sessionID) applyStatus(tracker, sessionID, properties?.status?.type)
  else if (type === "session.idle" && sessionID) tracker.ended(sessionID)
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

function pmsetOutput(...args: string[]) {
  return spawnSync("pmset", args, { encoding: "utf8" }).stdout ?? ""
}

function disableSleep(value: 0 | 1) {
  return spawnSync("sudo", ["-n", "/usr/bin/pmset", "-a", "disablesleep", String(value)]).status === 0
}

function watchdogScript(pid: number, seconds: number) {
  return [
    `end=$(( $(date +%s) + ${seconds} ))`,
    `while kill -0 ${pid} 2>/dev/null && [ $(date +%s) -lt $end ]; do sleep 10; done`,
    "sudo -n /usr/bin/pmset -a disablesleep 0",
  ].join("; ")
}

function pmsetBackend(options: { lidMaxMinutes: number; lidMinBattery: number }, log: Log): Backend {
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
    disableSleep(0)
    log("info", `lid sleep restored (${reason})`)
  }

  process.once("exit", () => {
    if (owned) disableSleep(0)
  })

  return {
    name: "pmset",
    start() {
      if (allowed === undefined) {
        allowed = spawnSync("sudo", ["-n", "-l", "/usr/bin/pmset", "-a", "disablesleep", "1"]).status === 0
        if (!allowed) log("info", "closing the lid will still sleep this Mac, see the README to allow pmset without a password")
      }
      if (!allowed) return
      if (sleepDisabled(pmsetOutput("-g"))) return
      if (!disableSleep(1)) {
        log("warn", "pmset disablesleep 1 failed")
        return
      }
      owned = true
      startedAt = Date.now()
      const script = watchdogScript(process.pid, Math.round(options.lidMaxMinutes * 60))
      watchdog = spawn("/bin/sh", ["-c", script], { detached: true, stdio: "ignore" })
      watchdog.unref()
      log("info", "lid sleep disabled while OpenCode works")
    },
    stop: () => release("sessions idle"),
    tick() {
      if (!owned) return
      if (Date.now() - startedAt > options.lidMaxMinutes * 60_000) {
        release("time limit")
        return
      }
      const battery = parseBattery(pmsetOutput("-g", "batt"))
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
