import assert from "node:assert/strict"
import { test } from "node:test"
import { databasePath } from "../dist/client.js"
import { fitSegments } from "../dist/query.js"

const text = (segments) => segments.map((segment) => (segment.hit ? `[${segment.text}]` : segment.text)).join("")

test("fits an excerpt on one line and keeps the first match in view", () => {
  const short = [{ text: "the ", hit: false }, { text: "heron", hit: true }]
  assert.deepEqual(fitSegments(short, 40), short)

  const long = [
    { text: "Format understood: the plugin reads every message, then the ", hit: false },
    { text: "heron", hit: true },
    { text: " config lives in settings.toml next to the other options", hit: false },
  ]
  const line = text(fitSegments(long, 40))
  assert.equal(Array.from(line.replaceAll(/[[\]]/g, "")).length <= 40, true)
  assert.match(line, /^…\S/, "cut between words, not inside one")
  assert.match(line, /\[heron\]/)
  assert.match(line, /…$/)
})

test("finds the database the way the OpenCode CLI does", (context) => {
  const saved = { data: process.env.XDG_DATA_HOME, db: process.env.OPENCODE_DB }
  context.after(() => {
    for (const [key, value] of [["XDG_DATA_HOME", saved.data], ["OPENCODE_DB", saved.db]]) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  process.env.XDG_DATA_HOME = "/data"
  delete process.env.OPENCODE_DB
  assert.equal(databasePath("latest"), "/data/opencode/opencode.db")
  assert.equal(databasePath("local"), "/data/opencode/opencode-local.db")
  process.env.OPENCODE_DB = "/elsewhere/custom.db"
  assert.equal(databasePath("latest"), "/elsewhere/custom.db")
})
