import assert from "node:assert/strict"
import { test } from "node:test"
import { ACTIVE_REFRESH_MS, IDLE_REFRESH_MS, checkSuiteIdsNeedingRuns, checkSuiteRunsQuery, descendantPullRequests, extractCreatedPullRequests, isSettled, refreshInterval, extractPullRequests, fitPullRequestLabel, groupPullRequests, marquee, predatesSession, pullRequestChecksIndicator, pullRequestCommentsLabel, pullRequestFromNode, pullRequestFromRest, pullRequestLabel, pullRequestStatus, pullRequestStatusLabel, pullRequestsQuery, checksState, slackPullRequest, slackPullRequestHtml, slackPullRequests, slackPullRequestsHtml, slackPullRequestsTexty, sortPullRequests, summarizeChecks, truncate, uniquePullRequests } from "../dist/prs.js"

test("extracts and normalizes GitHub pull request links", () => {
  assert.deepEqual(extractPullRequests("See https://github.com/vvo/opencode-plugins/pull/12/files"), [{
    owner: "vvo", repo: "opencode-plugins", number: 12,
    url: "https://github.com/vvo/opencode-plugins/pull/12",
  }])
})

test("removes duplicate pull requests", () => {
  const refs = extractPullRequests("https://github.com/vvo/repo/pull/1 https://github.com/vvo/repo/pull/1")
  assert.equal(uniquePullRequests(refs).length, 1)
})

test("flags messages inherited from a forked parent", () => {
  assert.equal(predatesSession({ time: { created: 999 } }, 1000), true)
  assert.equal(predatesSession({ time: { created: 1000 } }, 1000), false)
  assert.equal(predatesSession({ time: { created: 1001 } }, 1000), false)
  assert.equal(predatesSession({ time: { created: 999 } }, undefined), false)
  assert.equal(predatesSession({}, 1000), false)
})

test("finds PRs created by subagents and grandchildren, re-reading only sessions that changed", async () => {
  const pr = (number) => ({ owner: "vvo", repo: "repo", number, url: `https://github.com/vvo/repo/pull/${number}` })
  const tree = { root: [{ id: "a", updated: 1 }, { id: "b", updated: 1 }], a: [{ id: "a1", updated: 1 }], b: [], a1: [] }
  const created = { a: [pr(1)], b: [], a1: [pr(2)] }
  const reads = []
  const load = {
    children: async (id) => tree[id],
    refs: async (child) => {
      reads.push(child.id)
      return created[child.id]
    },
  }
  const known = new Map()
  const numbers = async () => (await descendantPullRequests("root", known, load)).map((ref) => ref.number).sort()
  assert.deepEqual(await numbers(), [1, 2])
  assert.deepEqual(reads.sort(), ["a", "a1", "b"])

  reads.length = 0
  assert.deepEqual(await numbers(), [1, 2])
  assert.deepEqual(reads, [])

  tree.root[1] = { id: "b", updated: 2 }
  created.b = [pr(3)]
  assert.deepEqual(await numbers(), [1, 2, 3])
  assert.deepEqual(reads, ["b"])
})

const ref = { owner: "vvo", repo: "opencode-plugins", number: 42, url: "https://github.com/vvo/opencode-plugins/pull/42" }
const counts = (states) => Object.entries(states).map(([state, count]) => ({ state, count }))
const rollup = (statuses = {}, checkRuns = {}) => ({
  contexts: { checkRunCountsByState: counts(checkRuns), statusContextCountsByState: counts(statuses) },
})
const names = (list) => list.map((name) => ({ name }))
const suite = (id, { status = "COMPLETED", conclusion = "SUCCESS", workflowRun = null } = {}) => ({ id, status, conclusion, workflowRun })
const suiteRuns = (id, { failing = [], running = [], failed = failing.length, pending = running.length } = {}) => ({
  id,
  failing: { totalCount: failed, nodes: names(failing) },
  running: { totalCount: pending, nodes: names(running) },
})
const runsOf = (...list) => new Map(list.map((runs) => [runs.id, runs]))
const run = (workflow, runNumber) => ({ runNumber, workflow: { id: workflow } })
const node = (fields, commit) => ({
  title: "PR", state: "OPEN", url: ref.url, number: 42, isDraft: false, reviewDecision: null, mergeStateStatus: "CLEAN",
  createdAt: "2026-09-21T14:08:09Z", mergedAt: null, additions: 1, deletions: 1,
  reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: rollup(), checkSuites: { nodes: [] }, ...commit } }] },
  ...fields,
})

test("batches every pull request into one GraphQL query without listing check runs", () => {
  const query = pullRequestsQuery([ref, { ...ref, owner: "vercel", repo: "api", number: 7 }])
  assert.match(query, /pr0: repository\(owner: "vvo", name: "opencode-plugins"\) \{ pullRequest\(number: 42\) \{ \.\.\.fields \} \}/)
  assert.match(query, /pr1: repository\(owner: "vercel", name: "api"\) \{ pullRequest\(number: 7\)/)
  assert.match(query, /fragment fields on PullRequest \{ title state url number isDraft reviewDecision mergeStateStatus/)
  assert.doesNotMatch(query, /checkRuns/)
})

test("lists runs only for the suites that asked for them", () => {
  assert.match(checkSuiteRunsQuery(["CS_1", "CS_2"]), /^query \{ nodes\(ids: \["CS_1","CS_2"\]\) \{ \.\.\. on CheckSuite \{ id failing: checkRuns/)
})

test("asks for runs of current suites that run or failed, on open PRs only", () => {
  const open = node({}, { checkSuites: { nodes: [
    suite("green"),
    suite("red", { conclusion: "FAILURE" }),
    suite("cancelled", { conclusion: "CANCELLED" }),
    suite("busy", { status: "IN_PROGRESS", conclusion: null }),
    suite("replaced", { conclusion: "FAILURE", workflowRun: run("ci", 1) }),
    suite("replacement", { workflowRun: run("ci", 2) }),
  ] } })
  const merged = node({ state: "MERGED" }, { checkSuites: { nodes: [suite("old", { conclusion: "FAILURE" })] } })
  assert.deepEqual(checkSuiteIdsNeedingRuns([open, merged, null, undefined]), ["red", "cancelled", "busy"])
})

test("builds a pull request from a GraphQL node", () => {
  const pr = pullRequestFromNode(ref, node({
    title: "Batch", reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED", additions: 51, deletions: 9,
    reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] },
  }, { statusCheckRollup: rollup({}, { SUCCESS: 1 }), checkSuites: { nodes: [suite("green")] } }))
  assert.equal(pr.owner, "vvo")
  assert.equal(pr.unresolvedThreads, 2)
  assert.equal(pr.checks, "passing")
  assert.equal(pr.reviewDecision, "APPROVED")
  assert.equal(pr.mergeStateStatus, "BLOCKED")
  assert.equal(pullRequestStatusLabel(pr), "approved · blocked")
  assert.equal("reviewThreads" in pr, false)
  assert.equal("commits" in pr, false)
})

test("summarizes checks from GitHub's counts, naming only what needs attention", () => {
  const summary = summarizeChecks(
    rollup({ SUCCESS: 4 }, { SUCCESS: 391, SKIPPED: 50, NEUTRAL: 6, FAILURE: 7, IN_PROGRESS: 3 }),
    [suite("tests", { status: "IN_PROGRESS", conclusion: null }), suite("hive", { conclusion: "FAILURE" }), suite("lint")],
    runsOf(
      suiteRuns("tests", { failing: ["Test / iam (shard: 3/4)", "Test / observability"], failed: 6, running: ["Test / growth"], pending: 3 }),
      suiteRuns("hive", { failing: ["Test / hive"] }),
    ),
  )
  assert.equal(checksState(summary), "failing")
  assert.deepEqual(summary, {
    failing: ["Test / iam (shard: 3/4)", "Test / observability", "Test / hive", "4 more"],
    running: ["Test / growth", "2 more"],
    passing: 395,
    skipped: 56,
    total: 461,
  })
})

test("ignores a workflow run replaced by a newer run of the same workflow", () => {
  const summary = summarizeChecks(rollup({}, { SUCCESS: 3, SKIPPED: 1, CANCELLED: 4 }), [
    suite("old", { conclusion: "CANCELLED", workflowRun: run("quality", 7) }),
    suite("new", { workflowRun: run("quality", 8) }),
    suite("owners", { status: "QUEUED", conclusion: null }),
  ], runsOf(suiteRuns("owners", { running: ["Vercel – Code Owners"] })))
  assert.deepEqual(summary, { failing: [], running: ["Vercel – Code Owners"], passing: 3, skipped: 1, total: 5 })
  assert.equal(checksState(summary), "pending")
  assert.equal(checksState({ ...summary, running: [] }), "passing")
})

test("ignores a queued suite that never started a run", () => {
  const summary = summarizeChecks(rollup({}, { SUCCESS: 2 }), [suite("ci"), suite("ghost", { status: "QUEUED", conclusion: null })], runsOf(suiteRuns("ghost")))
  assert.equal(checksState(summary), "passing")
})

test("still flags a suite whose runs could not be listed", () => {
  const suites = [suite("red", { conclusion: "FAILURE" }), suite("busy", { status: "IN_PROGRESS", conclusion: null })]
  assert.deepEqual(summarizeChecks(rollup(), suites, new Map()), { failing: ["1 more"], running: ["1 more"], passing: 0, skipped: 0, total: 2 })
})

test("counts a pending legacy status even though it has no name", () => {
  assert.deepEqual(summarizeChecks(rollup({ SUCCESS: 1, PENDING: 1 }, { SUCCESS: 1 }), [suite("ci")], new Map()), { failing: [], running: ["1 more"], passing: 2, skipped: 0, total: 3 })
  assert.deepEqual(summarizeChecks(null, [], new Map()), { failing: [], running: [], passing: 0, skipped: 0, total: 0 })
})

test("treats a missing check rollup as no checks", () => {
  const empty = node({ isDraft: true }, { statusCheckRollup: null })
  assert.equal(pullRequestFromNode(ref, empty).checks, "none")
  assert.equal(pullRequestFromNode(ref, { ...empty, commits: { nodes: [] } }).checks, "none")
  assert.equal(pullRequestFromNode(ref, empty).checkSummary.total, 0)
})

test("polls fast only while something is about to change", () => {
  const now = Date.parse("2026-10-09T12:00:00Z")
  const idle = { state: "OPEN", checks: "passing", mergeStateStatus: "CLEAN", createdAt: "2026-10-09T10:00:00Z" }
  assert.equal(refreshInterval([idle], now), IDLE_REFRESH_MS)
  assert.equal(refreshInterval([], now), IDLE_REFRESH_MS)
  assert.equal(refreshInterval([idle, { ...idle, checks: "pending" }], now), ACTIVE_REFRESH_MS)
  assert.equal(refreshInterval([{ ...idle, mergeStateStatus: "UNKNOWN" }], now), ACTIVE_REFRESH_MS)
  assert.equal(refreshInterval([{ ...idle, createdAt: "2026-10-09T11:58:00Z" }], now), ACTIVE_REFRESH_MS)
  assert.equal(refreshInterval([{ ...idle, state: "MERGED", checks: "pending" }], now), IDLE_REFRESH_MS)
})

test("settles merged and closed pull requests", () => {
  assert.equal(isSettled({ state: "OPEN" }), false)
  assert.equal(isSettled({ state: "MERGED" }), true)
  assert.equal(isSettled({ state: "CLOSED" }), true)
})

test("builds a pull request from the REST API and keeps cached review data", () => {
  const rest = { title: "Rest", state: "open", draft: false, created_at: "2026-09-21T14:08:09Z", merged_at: null, additions: 3, deletions: 2 }
  const fresh = pullRequestFromRest(ref, rest, undefined)
  assert.equal(fresh.state, "OPEN")
  assert.equal(fresh.reviewDecision, null)
  assert.equal(fresh.mergeStateStatus, null)
  assert.equal(fresh.unresolvedThreads, 0)
  assert.equal(fresh.checks, "none")
  const cached = pullRequestFromRest(ref, rest, { ...fresh, reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED", unresolvedThreads: 2, checks: "failing" })
  assert.equal(cached.reviewDecision, "APPROVED")
  assert.equal(cached.mergeStateStatus, "BLOCKED")
  assert.equal(cached.unresolvedThreads, 2)
  assert.equal(cached.checks, "failing")
  assert.equal(pullRequestFromRest(ref, { ...rest, state: "closed", merged_at: "2026-09-21T15:00:00Z" }, undefined).state, "MERGED")
  assert.equal(pullRequestFromRest(ref, { ...rest, state: "closed" }, undefined).state, "CLOSED")
})

test("truncates long titles", () => assert.equal(truncate("a long title", 8), "a long …"))

test("labels pull request states", () => {
  assert.equal(pullRequestStatus({ state: "OPEN", isDraft: true }), "draft")
  assert.equal(pullRequestStatus({ state: "OPEN", isDraft: false }), "open")
  assert.equal(pullRequestStatus({ state: "MERGED", isDraft: false }), "merged")
})

test("labels review state with words", () => {
  const approved = { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", checks: "passing" }
  assert.equal(pullRequestStatusLabel(approved), "approved")
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: "BLOCKED" }), "approved · blocked")
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: "BLOCKED", checks: "pending" }), "approved")
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: "UNKNOWN", checks: "pending" }), "approved")
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: "UNSTABLE", checks: "failing" }), "approved")
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: null }), "approved")
  assert.equal(pullRequestStatusLabel({ ...approved, reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" }), "waiting")
  assert.equal(pullRequestStatusLabel({ ...approved, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" }), "waiting")
  assert.equal(pullRequestStatusLabel({ ...approved, reviewDecision: "" }), "waiting")
  assert.equal(pullRequestStatusLabel({ ...approved, isDraft: true, mergeStateStatus: "BLOCKED" }), "draft")
  assert.equal(pullRequestStatusLabel({ ...approved, state: "MERGED", mergeStateStatus: "BLOCKED" }), "merged")
})

test("counts unresolved review threads", () => {
  assert.equal(pullRequestCommentsLabel({ state: "OPEN", reviewDecision: "APPROVED", unresolvedThreads: 0 }), undefined)
  assert.equal(pullRequestCommentsLabel({ state: "OPEN", reviewDecision: "APPROVED", unresolvedThreads: 1 }), "1 comment")
  assert.equal(pullRequestCommentsLabel({ state: "OPEN", reviewDecision: "REVIEW_REQUIRED", unresolvedThreads: 3 }), "3 comments")
  assert.equal(pullRequestCommentsLabel({ state: "OPEN", reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 0 }), "1 comment")
  assert.equal(pullRequestCommentsLabel({ state: "OPEN", reviewDecision: "CHANGES_REQUESTED", unresolvedThreads: 2 }), "2 comments")
  assert.equal(pullRequestCommentsLabel({ state: "MERGED", reviewDecision: "APPROVED", unresolvedThreads: 3 }), undefined)
})

test("maps the checks rollup to an indicator", () => {
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "passing" }), "✓")
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "failing" }), "×")
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "pending" }), "◌")
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "none" }), undefined)
  assert.equal(pullRequestChecksIndicator({ state: "MERGED", checks: "passing" }), undefined)
})

test("labels a conflicting PR as conflicts and leaves the checks indicator alone", () => {
  const conflicting = { state: "OPEN", isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "DIRTY", checks: "passing" }
  assert.equal(pullRequestStatusLabel(conflicting), "conflicts")
  assert.equal(pullRequestStatusLabel({ ...conflicting, isDraft: true }), "conflicts")
  assert.equal(pullRequestStatusLabel({ ...conflicting, reviewDecision: "REVIEW_REQUIRED" }), "conflicts")
  assert.equal(pullRequestStatusLabel({ ...conflicting, state: "MERGED" }), "merged")
  assert.equal(pullRequestChecksIndicator(conflicting), "✓")
})

test("labels pull requests with their repository", () => {
  assert.equal(pullRequestLabel({
    owner: "vercel", repo: "front", number: 90443,
    url: "https://github.com/vercel/front/pull/90443",
  }), "front#90443")
})

test("shortens the repository before the PR number", () => {
  const pr = { owner: "vvo", repo: "opencode-plugins", number: 37, url: "https://github.com/vvo/opencode-plugins/pull/37" }
  assert.equal(fitPullRequestLabel(pr, 40), "opencode-plugins#37")
  assert.equal(fitPullRequestLabel(pr, 10), "openco…#37")
  assert.equal(fitPullRequestLabel(pr, 4), "#37")
})

test("only extracts pull requests created by gh", () => {
  const url = "https://github.com/vvo/opencode-plugins/pull/7"
  assert.equal(extractCreatedPullRequests("gh pr view 7", url).length, 0)
  assert.equal(extractCreatedPullRequests("gh pr create --draft", url)[0].url, url)
})

test("extracts pull requests created through the REST API", () => {
  const url = "https://github.com/vercel/api/pull/92184"
  const created = (command) => extractCreatedPullRequests(command, `${url} draft=true #92184\n`).length
  assert.equal(created(`gh api repos/vercel/api/pulls -X POST -f title="[tinybird] Delete pipe" -f head=branch -f base=main -F draft=true --jq '.html_url' 2>&1 | tail -1`), 1)
  assert.equal(created("gh api --method POST /repos/vercel/api/pulls -f title=t -f head=h -f base=main"), 1)
  assert.equal(created("gh api repos/vercel/api/pulls -f title=t -f head=h -f base=main"), 1)
  assert.equal(created("gh api repos/vercel/api/pulls --input body.json"), 1)
  assert.equal(created("git push -u origin branch && gh api 'repos/{owner}/{repo}/pulls' -X POST -f title=t -f head=h -f base=main"), 1)
  assert.equal(created("gh api repos/vercel/api/pulls"), 0)
  assert.equal(created("gh api repos/vercel/api/pulls -X GET -f state=open"), 0)
  assert.equal(created("gh api repos/vercel/api/pulls/92184 -X PATCH -f body=updated"), 0)
  assert.equal(created("gh api repos/vercel/api/pulls/92184/requested_reviewers -X POST -f 'reviewers[]=sage'"), 0)
  assert.equal(created("gh api repos/vercel/api/issues -X POST -f title=t"), 0)
})

test("scrolls long titles", () => {
  assert.equal(marquee("abcdef", 4, 0), "abcd")
  assert.equal(marquee("abcdef", 4, 2), "cdef")
  assert.equal(marquee("abc", 4, 2), "abc")
})

test("sorts open, draft, and merged PRs by recency", () => {
  const pr = (number, state, isDraft, createdAt, mergedAt = null) => ({
    owner: "vvo", repo: "repo", number, url: `https://github.com/vvo/repo/pull/${number}`,
    title: String(number), state, isDraft, reviewDecision: null, unresolvedThreads: 0, checks: "none", createdAt, mergedAt, additions: 4, deletions: 2,
  })
  const sorted = sortPullRequests([
    pr(1, "MERGED", false, "2026-09-04T10:00:00Z", "2026-09-05T10:00:00Z"),
    pr(2, "OPEN", true, "2026-09-04T12:00:00Z"),
    pr(3, "OPEN", false, "2026-09-04T09:00:00Z"),
    pr(4, "OPEN", false, "2026-09-04T11:00:00Z"),
    pr(5, "MERGED", false, "2026-09-04T13:00:00Z", "2026-09-04T14:00:00Z"),
  ])
  assert.deepEqual(sorted.map(({ number }) => number), [4, 3, 2, 1, 5])
})

test("groups merged PRs behind the active ones", () => {
  const pr = (number, state, isDraft, createdAt, mergedAt = null) => ({
    owner: "vvo", repo: "repo", number, url: `https://github.com/vvo/repo/pull/${number}`,
    title: String(number), state, isDraft, reviewDecision: null, unresolvedThreads: 0, checks: "none", createdAt, mergedAt, additions: 4, deletions: 2,
  })
  const groups = groupPullRequests([
    pr(1, "MERGED", false, "2026-09-04T10:00:00Z", "2026-09-05T10:00:00Z"),
    pr(2, "OPEN", true, "2026-09-04T12:00:00Z"),
    pr(3, "OPEN", false, "2026-09-04T09:00:00Z"),
    pr(5, "MERGED", false, "2026-09-04T13:00:00Z", "2026-09-04T14:00:00Z"),
  ])
  assert.deepEqual(groups.active.map(({ number }) => number), [3, 2])
  assert.deepEqual(groups.merged.map(({ number }) => number), [1, 5])
  assert.deepEqual(groupPullRequests([]), { active: [], merged: [] })
})

test("formats a PR for Slack", () => {
  const pr = {
    owner: "vvo", repo: "opencode-plugins", number: 22,
    url: "https://github.com/vvo/opencode-plugins/pull/22",
    title: "lower the cursor", state: "MERGED", isDraft: false, reviewDecision: "APPROVED", unresolvedThreads: 0, checks: "passing",
    createdAt: "2026-09-04T10:00:00Z", mergedAt: "2026-09-04T11:00:00Z", additions: 4, deletions: 4,
  }
  assert.equal(slackPullRequest(pr), ":pr: *vvo/opencode-plugins* · <https://github.com/vvo/opencode-plugins/pull/22|lower the cursor (#22)> +4/-4")
  assert.equal(
    slackPullRequestHtml(pr),
    `<meta charset='utf-8'><html><head></head><body>:pr: <b>vvo/opencode-plugins</b> · <a href="https://github.com/vvo/opencode-plugins/pull/22">lower the cursor (#22)</a> +4/-4</body></html>`,
  )
  assert.equal(slackPullRequests([pr]), slackPullRequest(pr))
  assert.equal(slackPullRequests([pr, pr]), `- ${slackPullRequest(pr)}\n- ${slackPullRequest(pr)}`)
  assert.match(slackPullRequestsHtml([pr, pr]), /<ul><li>/)
  assert.equal(slackPullRequestsTexty([pr]), undefined)
  assert.deepEqual(JSON.parse(slackPullRequestsTexty([pr, pr])).ops.at(-1), { attributes: { list: "bullet" }, insert: "\n" })
})
