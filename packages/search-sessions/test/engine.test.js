import assert from "node:assert/strict"
import { join } from "node:path"
import { after, before, describe, test } from "node:test"
import { Engine } from "../dist/engine.js"
import { DAY, NOW, temp, v1Database, v2Database } from "./fixture.js"

const ids = (output) => output.hits.map((hit) => hit.sessionID)
const marked = (segments) => segments.map((segment) => (segment.hit ? `[${segment.text}]` : segment.text)).join("")

describe("searching an OpenCode 2 database", () => {
  let engine
  before(async () => {
    const dir = temp()
    const source = v2Database(dir)
      .project("project_app", "/repo/app")
      .project("project_site", "/repo/site")
      .session("ses_count", { title: "Fix the PR count in the sidebar", project: "project_app", directory: "/repo/app", updated: NOW - 2 * DAY })
      .message("ses_count", "user", "The sidebar shows the wrong number of pull requests")
      .message("ses_count", "assistant", [
        { type: "reasoning", text: "Maybe the zebrafish cache is stale." },
        { type: "text", text: "The count comes from the GraphQL query, which skips drafts." },
        { type: "tool", name: "shell", state: { status: "completed", input: { command: "gh pr list" } } },
      ])
      .message("ses_count", "user", "Ship it to production")
      .session("ses_deploy", { title: "Deploy preview builds", project: "project_site", directory: "/repo/site", updated: NOW - 3 * DAY })
      .message("ses_deploy", "user", "How do we ship previews?")
      .message("ses_deploy", "assistant", "Run pnpm dev:link first, then deploy with the CLI.")
      .session("ses_chores", { title: "Weekly chores", project: "project_app", directory: "/repo/app", updated: NOW - 4 * DAY })
      // A fork carries copies of its parent's messages, with their original times.
      .session("ses_fork", { title: "Fix the PR count in the sidebar (fork #1)", project: "project_app", directory: "/repo/app", created: NOW - DAY / 2 })
      .message("ses_fork", "user", "The sidebar shows the wrong number of pull requests", { created: NOW - DAY + 1 })
      .message("ses_fork", "user", "After the fork we renamed the flamingo flag", { created: NOW - DAY / 4 })
      .session("ses_child", { title: "Explore the code", parent: "ses_count" })
      .message("ses_child", "user", "Look for the narwhal module")
      .session("ses_typo", { title: "Typo heavy", updated: NOW - DAY + 5_000 })
      .message("ses_typo", "user", "the sesion list is slow")
      .session("ses_restore", { title: "Restore tabs", updated: NOW - DAY + 4_000 })
    for (let index = 0; index < 10; index++) source.message("ses_restore", "assistant", `The session comes back after restart ${index}`)
    // A busy session that mentions a word in every reply, against one titled with it.
    for (let index = 0; index < 60; index++) source.message("ses_chores", "assistant", `deploy the cron job ${index}, then deploy again`)
    source
      .session("ses_pr_short", { title: "Review queue", updated: NOW - 30 * DAY })
      .message("ses_pr_short", "assistant", "Opened [api#103726](https://example.test/x) and front#62")
      .session("ses_pr_url", { title: "Merged work", updated: NOW - 31 * DAY })
      .message("ses_pr_url", "user", "did https://github.com/acme/api/pull/103726/files land?")
      .session("ses_pr_bare", { title: "Checks", updated: NOW - 32 * DAY })
      .message("ses_pr_bare", "assistant", "CI on #103726 is green, and api#62 too")
      .session("ses_pr_tool", { title: "Open the PR", updated: NOW - 33 * DAY })
      .message("ses_pr_tool", "assistant", [
        { type: "text", text: "Opening it now." },
        { type: "tool", name: "shell", state: { status: "completed", input: { command: "gh pr create --draft" }, content: [{ type: "text", text: "https://github.com/acme/infra/pull/38087\n" }] } },
      ])
    source.close()
    engine = await Engine.open({ database: source.file, index: join(dir, "index.sqlite"), flavor: "v2" })
    await engine.sync()
  })
  after(() => engine.close())

  test("finds a session by any word of its prompts and replies", () => {
    const output = engine.search({ query: "graphql" })
    assert.deepEqual(ids(output), ["ses_count"])
    assert.equal(output.hits[0].role, "assistant")
    assert.equal(marked(output.hits[0].snippet), "The count comes from the [GraphQL] query, which skips drafts.")
  })

  test("leaves out reasoning, tool calls and subagent sessions", () => {
    assert.equal(engine.search({ query: "zebrafish" }).total, 0)
    assert.equal(engine.search({ query: "gh pr list" }).total, 0)
    assert.equal(engine.search({ query: "narwhal" }).total, 0)
  })

  test("tolerates typos and unfinished words", () => {
    const typo = engine.search({ query: "grpahql " })
    assert.deepEqual(ids(typo), ["ses_count"])
    assert.equal(marked(typo.hits[0].snippet), "The count comes from the [GraphQL] query, which skips drafts.")
    assert.deepEqual(ids(engine.search({ query: "graph" })), ["ses_count"])
    // The misspelling exists in one prompt, the real word in ten replies: both are found.
    assert.deepEqual(ids(engine.search({ query: "sesion" })).sort(), ["ses_restore", "ses_typo"])
  })

  test("matches punctuated terms as a phrase", () => {
    const output = engine.search({ query: "dev:link" })
    assert.deepEqual(ids(output), ["ses_deploy"])
    assert.match(marked(output.hits[0].snippet), /\[dev:link\]/)
  })

  test("finds a pull request however it was written", () => {
    const everywhere = ["ses_pr_bare", "ses_pr_short", "ses_pr_url"]
    for (const query of ["https://github.com/acme/api/pull/103726", "acme/api#103726", "api#103726"]) {
      assert.deepEqual(ids(engine.search({ query })).sort(), everywhere, query)
    }
    const url = engine.search({ query: "https://github.com/acme/api/pull/103726" })
    const hit = url.hits.find((item) => item.sessionID === "ses_pr_url")
    assert.match(marked(hit.snippet), /\[api\/pull\/103726\]/)
    // Short numbers are common, so they need the repository.
    assert.deepEqual(ids(engine.search({ query: "api#62" })), ["ses_pr_bare"])
    assert.deepEqual(ids(engine.search({ query: "https://github.com/acme/front/pull/62" })), ["ses_pr_short"])
    // A link only a tool call printed, like `gh pr create`.
    const created = engine.search({ query: "infra#38087" })
    assert.deepEqual(ids(created), ["ses_pr_tool"])
    assert.match(marked(created.hits[0].snippet), /\[infra\/pull\/38087\]/)
  })

  test("ranks a title match above repeated mentions", () => {
    const output = engine.search({ query: "deploy" })
    assert.deepEqual(ids(output), ["ses_deploy", "ses_chores"])
    assert.equal(marked(output.hits[0].title), "[Deploy] preview builds")
  })

  test("finds a session whose words are spread over several messages", () => {
    assert.deepEqual(ids(engine.search({ query: "pull production" })), ["ses_count"])
  })

  test("shows a fork once, for what it added after the fork", () => {
    assert.deepEqual(ids(engine.search({ query: "wrong number" })), ["ses_count"])
    assert.deepEqual(ids(engine.search({ query: "flamingo" })), ["ses_fork"])
  })

  test("limits results to the current project", () => {
    assert.deepEqual(ids(engine.search({ query: "deploy", directory: "/repo/app" })), ["ses_chores"])
    // A worktree no session used yet, scoped by the project the host resolved for it.
    const worktree = engine.search({ query: "deploy", directory: "/repo/site-worktree", projectID: "project_site" })
    assert.deepEqual(ids(worktree), ["ses_deploy"])
    assert.equal(worktree.scope, "site")
  })

  test("lists recent sessions with their first prompt when the query is empty", () => {
    const output = engine.search({ query: "" })
    assert.deepEqual(ids(output), ["ses_fork", "ses_typo", "ses_restore", "ses_count", "ses_deploy", "ses_chores", "ses_pr_short", "ses_pr_url", "ses_pr_bare", "ses_pr_tool"])
    assert.equal(marked(output.hits[3].snippet), "The sidebar shows the wrong number of pull requests")
    assert.equal(output.hits[3].role, "user")
  })
})

describe("keeping the index current", () => {
  test("indexes new, edited, renamed and deleted sessions", async () => {
    const dir = temp()
    const source = v2Database(dir)
      .session("ses_notes", { title: "Animal notes" })
      .message("ses_notes", "assistant", "draft about otters", { id: "msg_draft" })
    const engine = await Engine.open({ database: source.file, index: join(dir, "index.sqlite"), flavor: "v2" })
    await engine.sync()
    assert.deepEqual(ids(engine.search({ query: "otters" })), ["ses_notes"])

    // A reply that finished streaming changes the message but not always the session row.
    source.run(
      "UPDATE session_message SET data = ?, time_updated = ? WHERE id = 'msg_draft'",
      JSON.stringify({ content: [{ type: "text", text: "final notes about beavers" }] }),
      NOW,
    )
    await engine.sync({ hints: ["ses_notes"] })
    assert.equal(engine.search({ query: "otters" }).total, 0)
    assert.deepEqual(ids(engine.search({ query: "beavers" })), ["ses_notes"])

    source.message("ses_notes", "user", "add the walrus section", { created: NOW })
    source.run("UPDATE session_v2 SET title = 'Marine mammals', time_updated = ? WHERE id = 'ses_notes'", NOW)
    await engine.sync()
    assert.deepEqual(ids(engine.search({ query: "walrus" })), ["ses_notes"])
    assert.deepEqual(ids(engine.search({ query: "marine" })), ["ses_notes"])
    assert.equal(engine.search({ query: "animal" }).total, 0)

    source.run("DELETE FROM session_message WHERE session_id = 'ses_notes'").run("DELETE FROM session_v2 WHERE id = 'ses_notes'")
    await engine.sync()
    assert.equal(engine.search({ query: "" }).total, 0)
    engine.close()
    source.close()
  })
})

test("reads OpenCode 1 sessions from their text parts", async () => {
  const dir = temp()
  const source = v1Database(dir)
    .session("ses_old", "Legacy session")
    .message("ses_old", "user", [
      { type: "text", text: "Where is the heron config?" },
      { type: "text", text: "contents of an attached file mentioning pelicans", synthetic: true },
    ])
    .message("ses_old", "assistant", [
      { type: "reasoning", text: "cormorant" },
      { type: "text", text: "The heron config lives in settings.toml" },
    ])
  source.close()
  const engine = await Engine.open({ database: source.file, index: join(dir, "index.sqlite"), flavor: "v1" })
  await engine.sync()
  const output = engine.search({ query: "heron config" })
  assert.deepEqual(ids(output), ["ses_old"])
  assert.equal(engine.search({ query: "pelicans" }).total, 0)
  assert.equal(engine.search({ query: "cormorant" }).total, 0)
  engine.close()
})
