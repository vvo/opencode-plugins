import assert from "node:assert/strict"
import { test } from "node:test"
import {
  applyV1Event,
  applyV2Event,
  createHold,
  createTracker,
  linuxInhibitArgs,
  parseBattery,
  platformBackends,
  sleepDisabled,
} from "../dist/awake.js"

function fakeHold() {
  const calls = []
  return { calls, set: (active) => calls.push(active) }
}

test("holds while any session runs and releases after the last one ends", () => {
  const hold = fakeHold()
  const tracker = createTracker(hold)
  applyV2Event(tracker, { type: "session.execution.started", data: { sessionID: "a" } })
  applyV2Event(tracker, { type: "session.execution.started", data: { sessionID: "b" } })
  applyV2Event(tracker, { type: "session.execution.succeeded", data: { sessionID: "a" } })
  assert.equal(hold.calls.at(-1), true)
  applyV2Event(tracker, { type: "session.execution.interrupted", data: { sessionID: "b" } })
  assert.equal(hold.calls.at(-1), false)
})

test("a running session never expires, a heartbeat-only session does", () => {
  let now = 0
  const hold = fakeHold()
  const tracker = createTracker(hold, 60_000, () => now)
  applyV2Event(tracker, { type: "session.execution.started", data: { sessionID: "long" } })
  applyV2Event(tracker, { type: "session.tool.called", data: { sessionID: "seen-mid-run" } })
  now = 10 * 60_000
  tracker.sweep()
  assert.equal(tracker.size(), 1)
  assert.equal(hold.calls.at(-1), true)
})

test("heartbeats alone release after the grace period", () => {
  let now = 0
  const hold = fakeHold()
  const tracker = createTracker(hold, 60_000, () => now)
  applyV2Event(tracker, { type: "session.text.started", data: { sessionID: "a" } })
  assert.equal(hold.calls.at(-1), true)
  now = 61_000
  tracker.sweep()
  assert.equal(hold.calls.at(-1), false)
})

test("ignores events without a session", () => {
  const hold = fakeHold()
  const tracker = createTracker(hold)
  applyV2Event(tracker, { type: "session.execution.started", data: {} })
  applyV2Event(tracker, null)
  assert.equal(tracker.size(), 0)
})

test("maps OpenCode 1 session events", () => {
  const hold = fakeHold()
  const tracker = createTracker(hold)
  applyV1Event(tracker, { type: "session.status", properties: { sessionID: "a", status: { type: "busy" } } })
  assert.equal(hold.calls.at(-1), true)
  applyV1Event(tracker, { type: "session.status", properties: { sessionID: "a", status: { type: "idle" } } })
  assert.equal(hold.calls.at(-1), false)
  applyV1Event(tracker, { type: "session.status", properties: { sessionID: "b", status: { type: "retry" } } })
  applyV1Event(tracker, { type: "session.deleted", properties: { info: { id: "b" } } })
  assert.equal(hold.calls.at(-1), false)
})

test("starts and stops every backend once per transition", () => {
  const calls = []
  const backend = (name) => ({ name, start: () => calls.push(`${name}+`), stop: () => calls.push(`${name}-`) })
  const hold = createHold([backend("a"), backend("b")])
  hold.set(true)
  hold.set(true)
  hold.set(false)
  hold.set(false)
  assert.deepEqual(calls, ["a+", "b+", "a-", "b-"])
})

test("reads battery state from pmset", () => {
  assert.deepEqual(
    parseBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t73%; discharging; 2:34 remaining"),
    { onBattery: true, percent: 73 },
  )
  assert.deepEqual(parseBattery("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged"), {
    onBattery: false,
    percent: 100,
  })
})

test("detects a sleep disable someone else already set", () => {
  assert.equal(sleepDisabled(" SleepDisabled\t\t1\n"), true)
  assert.equal(sleepDisabled(" SleepDisabled\t\t0\n"), false)
  assert.equal(sleepDisabled(" sleep 1\n"), false)
})

test("the Linux inhibitor dies with OpenCode", () => {
  const args = linuxInhibitArgs("idle:sleep:handle-lid-switch", 42)
  assert.equal(args[0], "--what=idle:sleep:handle-lid-switch")
  assert.deepEqual(args.slice(-4), ["tail", "--pid=42", "-f", "/dev/null"])
})

test("picks backends per platform", () => {
  const log = () => {}
  assert.deepEqual(platformBackends({}, log, "darwin").map((b) => b.name), ["caffeinate", "pmset"])
  assert.deepEqual(platformBackends({ lid: false }, log, "darwin").map((b) => b.name), ["caffeinate"])
  assert.deepEqual(platformBackends({}, log, "linux").map((b) => b.name), ["systemd-inhibit"])
  assert.deepEqual(platformBackends({}, log, "win32"), [])
})
