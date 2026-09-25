import assert from "node:assert/strict"
import { test } from "node:test"
import { extractCreatedPullRequests, extractPullRequests, groupPullRequests, marquee, predatesSession, pullRequestChecksIndicator, pullRequestCommentsLabel, pullRequestFromNode, pullRequestFromRest, pullRequestLabel, pullRequestStatus, pullRequestStatusLabel, pullRequestStatusIsWarning, pullRequestsQuery, slackPullRequest, slackPullRequestHtml, slackPullRequests, slackPullRequestsHtml, slackPullRequestsTexty, sortPullRequests, summarizeChecks, truncate, uniquePullRequests } from "../dist/prs.js"

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

const ref = { owner: "vvo", repo: "opencode-plugins", number: 42, url: "https://github.com/vvo/opencode-plugins/pull/42" }
const counts = (entries) => Object.entries(entries).map(([state, count]) => ({ state, count }))
const rollup = (state, runs, statuses = {}) => ({
  state,
  contexts: {
    totalCount: Object.values(runs).reduce((a, b) => a + b, 0) + Object.values(statuses).reduce((a, b) => a + b, 0),
    checkRunCountsByState: counts(runs),
    statusContextCountsByState: counts(statuses),
  },
})
const suite = (failing = [], running = []) => ({ failing: { nodes: failing.map((name) => ({ name })) }, running: { nodes: running.map((name) => ({ name })) } })

test("batches every pull request into one GraphQL query", () => {
  const query = pullRequestsQuery([ref, { ...ref, owner: "vercel", repo: "api", number: 7 }])
  assert.match(query, /pr0: repository\(owner: "vvo", name: "opencode-plugins"\) \{ pullRequest\(number: 42\) \{ \.\.\.fields \} \}/)
  assert.match(query, /pr1: repository\(owner: "vercel", name: "api"\) \{ pullRequest\(number: 7\)/)
  assert.match(query, /fragment fields on PullRequest \{ title state url number isDraft reviewDecision mergeStateStatus/)
})

test("builds a pull request from a GraphQL node", () => {
  const pr = pullRequestFromNode(ref, {
    title: "Batch", state: "OPEN", url: ref.url, number: 42, isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "BLOCKED",
    createdAt: "2026-09-21T14:08:09Z", mergedAt: null, additions: 51, deletions: 9,
    reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }, { isResolved: false }] },
    commits: { nodes: [{ commit: { statusCheckRollup: rollup("SUCCESS", { SUCCESS: 1 }), checkSuites: { nodes: [suite()] } } }] },
  })
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
  const pr = pullRequestFromNode(ref, {
    title: "Checks", state: "OPEN", url: ref.url, number: 42, isDraft: false, reviewDecision: null,
    createdAt: "2026-09-21T14:08:09Z", mergedAt: null, additions: 1, deletions: 1,
    reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: {
      statusCheckRollup: rollup("FAILURE", { SUCCESS: 391, SKIPPED: 56, FAILURE: 7, IN_PROGRESS: 2, QUEUED: 1 }, { SUCCESS: 4 }),
      checkSuites: { nodes: [suite(["Test / iam (shard: 3/4)", "Test / observability"], ["Test / growth"]), suite(["Test / hive"])] },
    } }] },
  })
  assert.equal(pr.checks, "failing")
  assert.deepEqual(pr.checkSummary, {
    failing: ["Test / iam (shard: 3/4)", "Test / observability", "Test / hive", "4 more"],
    running: ["Test / growth", "2 more"],
    passing: 395,
    skipped: 56,
    total: 461,
  })
})

test("counts a pending legacy status even though it has no name", () => {
  assert.deepEqual(summarizeChecks(rollup("PENDING", { SUCCESS: 2 }, { PENDING: 1 }), []), { failing: [], running: ["1 more"], passing: 2, skipped: 0, total: 3 })
  assert.deepEqual(summarizeChecks(null, []), { failing: [], running: [], passing: 0, skipped: 0, total: 0 })
})

test("treats a missing check rollup as no checks", () => {
  const node = {
    title: "No checks", state: "OPEN", url: ref.url, number: 42, isDraft: true, reviewDecision: null,
    createdAt: "2026-09-21T14:08:09Z", mergedAt: null, additions: 1, deletions: 1,
    reviewThreads: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null, checkSuites: { nodes: [] } } }] },
  }
  assert.equal(pullRequestFromNode(ref, node).checks, "none")
  assert.equal(pullRequestFromNode(ref, { ...node, commits: { nodes: [] } }).checks, "none")
  assert.equal(pullRequestFromNode(ref, node).checkSummary.total, 0)
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
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: "BLOCKED", checks: "pending" }), "approved · blocked")
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: "UNKNOWN", checks: "pending" }), "approved · pending")
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: "UNSTABLE", checks: "pending" }), "approved · pending")
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: "UNSTABLE", checks: "failing" }), "approved")
  assert.equal(pullRequestStatusLabel({ ...approved, mergeStateStatus: null }), "approved")
  assert.equal(pullRequestStatusLabel({ ...approved, reviewDecision: "CHANGES_REQUESTED", mergeStateStatus: "BLOCKED" }), "waiting")
  assert.equal(pullRequestStatusLabel({ ...approved, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" }), "waiting")
  assert.equal(pullRequestStatusLabel({ ...approved, reviewDecision: "" }), "waiting")
  assert.equal(pullRequestStatusLabel({ ...approved, isDraft: true, mergeStateStatus: "BLOCKED" }), "draft")
  assert.equal(pullRequestStatusLabel({ ...approved, state: "MERGED", mergeStateStatus: "BLOCKED" }), "merged")
})

test("uses warning color for draft and approved PRs with merge blockers", () => {
  const approved = { isDraft: false, reviewDecision: "APPROVED", mergeStateStatus: "CLEAN", checks: "passing" }
  assert.equal(pullRequestStatusIsWarning({ ...approved, mergeStateStatus: "BLOCKED" }), true)
  assert.equal(pullRequestStatusIsWarning({ ...approved, mergeStateStatus: "UNKNOWN", checks: "pending" }), true)
  assert.equal(pullRequestStatusIsWarning(approved), false)
  assert.equal(pullRequestStatusIsWarning({ ...approved, reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED", checks: "pending" }), false)
  assert.equal(pullRequestStatusIsWarning({ ...approved, isDraft: true, mergeStateStatus: "UNKNOWN", checks: "none" }), true)
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

test("shows a conflicting PR as failing even when its checks passed", () => {
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "passing", mergeStateStatus: "DIRTY" }), "×")
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "none", mergeStateStatus: "DIRTY" }), "×")
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "passing", mergeStateStatus: "BLOCKED" }), "✓")
  assert.equal(pullRequestChecksIndicator({ state: "MERGED", checks: "passing", mergeStateStatus: "DIRTY" }), undefined)
})

test("labels pull requests with their repository", () => {
  assert.equal(pullRequestLabel({
    owner: "vercel", repo: "front", number: 90443,
    url: "https://github.com/vercel/front/pull/90443",
  }), "front#90443")
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
