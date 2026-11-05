import assert from "node:assert/strict"
import { test } from "node:test"
import { computeContext, computeModels, computeTurns, modelLabel } from "../dist/turns.js"

const user = (id, created) => ({ id, user: true, cost: 0, created })
const msg = (id, created, cost) => ({ id, user: false, cost, created })

test("no messages", () => {
  assert.deepEqual(computeTurns([]), { current: 0, previous: 0 })
})

test("splits on user messages", () => {
  const entries = [user("1", 1), msg("2", 2, 0.5), user("3", 3), msg("4", 4, 0.25)]
  assert.deepEqual(computeTurns(entries), { current: 0.25, previous: 0.5 })
})

test("a single turn leaves previous at zero", () => {
  assert.deepEqual(computeTurns([user("1", 1), msg("2", 2, 0.5)]), { current: 0.5, previous: 0 })
})

test("sums every message in a turn", () => {
  const entries = [user("1", 1), msg("2", 2, 0.5), msg("3", 3, 0.25)]
  assert.deepEqual(computeTurns(entries), { current: 0.75, previous: 0 })
})

test("sorts by creation time, not input order", () => {
  const entries = [msg("4", 4, 0.25), user("3", 3), msg("2", 2, 0.5), user("1", 1)]
  assert.deepEqual(computeTurns(entries), { current: 0.25, previous: 0.5 })
})

test("dedupes by id so the live window can overlap the backfill", () => {
  const entries = [user("1", 1), msg("2", 2, 0.5), msg("2", 2, 0.5)]
  assert.deepEqual(computeTurns(entries), { current: 0.5, previous: 0 })
})

test("ignores messages before the first user message", () => {
  assert.deepEqual(computeTurns([msg("0", 0, 9)]), { current: 0, previous: 0 })
})

test("reports only the last two of many turns", () => {
  const entries = [user("1", 1), msg("2", 2, 1), user("3", 3), msg("4", 4, 2), user("5", 5), msg("6", 6, 3)]
  assert.deepEqual(computeTurns(entries), { current: 3, previous: 2 })
})

test("attributes a subagent to the turn open when it started", () => {
  const entries = [user("1", 1), msg("2", 2, 0.5), user("3", 3), msg("4", 4, 0.25)]
  assert.deepEqual(computeTurns(entries, [{ cost: 1, created: 3.5 }]), { current: 1.25, previous: 0.5 })
  assert.deepEqual(computeTurns(entries, [{ cost: 1, created: 1.5 }]), { current: 0.25, previous: 1.5 })
})

test("drops a subagent that predates every turn", () => {
  assert.deepEqual(computeTurns([user("1", 1)], [{ cost: 1, created: 0 }]), { current: 0, previous: 0 })
})

const tokens = (n) => ({ input: n, output: 0, reasoning: 0, cache: { read: 0, write: 0 } })
const reply = (id, n) => ({ id, assistant: true, compacted: false, tokens: tokens(n) })

test("no messages means nothing to render", () => {
  assert.equal(computeContext([], 1000), undefined)
})

test("sums every token bucket", () => {
  const m = { id: "1", assistant: true, compacted: false, tokens: { input: 1, output: 2, reasoning: 4, cache: { read: 8, write: 16 } } }
  assert.deepEqual(computeContext([m], undefined), { tokens: 31, percent: undefined })
})

test("reads the newest assistant message", () => {
  assert.deepEqual(computeContext([reply("1", 100), reply("2", 200)], 1000), { tokens: 200, percent: 20 })
})

test("ignores messages without token usage", () => {
  const pending = { id: "2", assistant: true, compacted: false }
  assert.deepEqual(computeContext([reply("1", 100), pending], 1000), { tokens: 100, percent: 10 })
})

test("omits percent when the model has no context limit", () => {
  assert.deepEqual(computeContext([reply("1", 100)], undefined), { tokens: 100, percent: undefined })
})

test("ignores anything at or before a completed compaction", () => {
  const messages = [
    reply("1", 900),
    { id: "2", assistant: false, compacted: true },
    reply("3", 50),
  ]
  assert.deepEqual(computeContext(messages, 1000), { tokens: 50, percent: 5 })
})

test("hides itself when compaction is the newest message", () => {
  const messages = [reply("1", 900), { id: "2", assistant: false, compacted: true }]
  assert.equal(computeContext(messages, 1000), undefined)
})

test("ignores messages at or after a revert point", () => {
  const messages = [reply("1", 100), reply("2", 900)]
  assert.deepEqual(computeContext(messages, 1000, "2"), { tokens: 100, percent: 10 })
})

test("hides itself when the revert target is not loaded", () => {
  assert.equal(computeContext([reply("1", 100)], 1000, "nope"), undefined)
})

test("hides itself when the newest usage is zero", () => {
  assert.equal(computeContext([reply("1", 0)], 1000), undefined)
})

const spend = (id, created, cost, model) => ({ id, user: false, cost, created, model })

test("models: one model shows nothing, the spent line already says it", () => {
  assert.deepEqual(computeModels([spend("1", 1, 2, "a"), spend("2", 2, 1, "a")]), [])
})

test("models: sums per model, most expensive first", () => {
  const entries = [user("0", 0), spend("1", 1, 1, "a"), spend("2", 2, 3, "b"), spend("3", 3, 1, "a")]
  assert.deepEqual(computeModels(entries), [
    { model: "b", cost: 3 },
    { model: "a", cost: 2 },
  ])
})

test("models: skips messages a fork copied from its parent", () => {
  const entries = [spend("1", 1, 50, "a"), spend("2", 10, 3, "b"), spend("3", 11, 1, "a")]
  assert.deepEqual(computeModels(entries, [], 10), [
    { model: "b", cost: 3 },
    { model: "a", cost: 1 },
  ])
})

test("models: subagents count under their own model", () => {
  const children = [
    { cost: 2, created: 5, model: "worker" },
    { cost: 1, created: 6 },
  ]
  assert.deepEqual(computeModels([spend("1", 1, 3, "a")], children), [
    { model: "a", cost: 3 },
    { model: "worker", cost: 2 },
    { model: "subagents", cost: 1 },
  ])
})

test("models: folds the long tail into one row", () => {
  const entries = [5, 4, 3, 2, 1].map((cost, i) => spend(String(i), i, cost, `m${cost}`))
  assert.deepEqual(computeModels(entries), [
    { model: "m5", cost: 5 },
    { model: "m4", cost: 4 },
    { model: "m3", cost: 3 },
    { model: "2 others", cost: 3 },
  ])
})

test("modelLabel drops the provider prefix and the default variant", () => {
  assert.equal(modelLabel("anthropic/claude-opus-5.5", "max"), "claude-opus-5.5 max")
  assert.equal(modelLabel("anthropic/claude-opus-5.5", "default"), "claude-opus-5.5")
  assert.equal(modelLabel("gpt-5"), "gpt-5")
})
