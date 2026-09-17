import assert from "node:assert/strict"
import { test } from "node:test"
import { extractCreatedPullRequests, extractPullRequests, marquee, pullRequestChecks, pullRequestChecksIndicator, pullRequestCommentsLabel, pullRequestLabel, pullRequestStatus, pullRequestStatusLabel, slackPullRequest, slackPullRequestHtml, slackPullRequests, slackPullRequestsHtml, slackPullRequestsTexty, sortPullRequests, truncate, uniquePullRequests } from "../dist/prs.js"

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

test("truncates long titles", () => assert.equal(truncate("a long title", 8), "a long …"))

test("labels pull request states", () => {
  assert.equal(pullRequestStatus({ state: "OPEN", isDraft: true }), "draft")
  assert.equal(pullRequestStatus({ state: "OPEN", isDraft: false }), "open")
  assert.equal(pullRequestStatus({ state: "MERGED", isDraft: false }), "merged")
})

test("labels review state with words", () => {
  assert.equal(pullRequestStatusLabel({ state: "OPEN", isDraft: false, reviewDecision: "APPROVED" }), "approved")
  assert.equal(pullRequestStatusLabel({ state: "OPEN", isDraft: false, reviewDecision: "CHANGES_REQUESTED" }), "changes requested")
  assert.equal(pullRequestStatusLabel({ state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED" }), "waiting")
  assert.equal(pullRequestStatusLabel({ state: "OPEN", isDraft: false, reviewDecision: "" }), "waiting")
  assert.equal(pullRequestStatusLabel({ state: "OPEN", isDraft: true, reviewDecision: "APPROVED" }), "draft")
  assert.equal(pullRequestStatusLabel({ state: "MERGED", isDraft: false, reviewDecision: "APPROVED" }), "merged")
})

test("counts unresolved review threads", () => {
  assert.equal(pullRequestCommentsLabel({ state: "OPEN", unresolvedThreads: 0 }), undefined)
  assert.equal(pullRequestCommentsLabel({ state: "OPEN", unresolvedThreads: 1 }), "1 comment")
  assert.equal(pullRequestCommentsLabel({ state: "OPEN", unresolvedThreads: 3 }), "3 comments")
  assert.equal(pullRequestCommentsLabel({ state: "MERGED", unresolvedThreads: 3 }), undefined)
})

test("summarizes status checks", () => {
  assert.equal(pullRequestChecks([]), "none")
  assert.equal(pullRequestChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }, { state: "SUCCESS" }]), "passing")
  assert.equal(pullRequestChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "failing")
  assert.equal(pullRequestChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS", conclusion: null }]), "pending")
  assert.equal(pullRequestChecks([{ state: "PENDING" }]), "pending")
  assert.equal(pullRequestChecks([{ status: "COMPLETED", conclusion: "SKIPPED" }]), "none")
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "passing" }), "✓")
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "failing" }), "×")
  assert.equal(pullRequestChecksIndicator({ state: "OPEN", checks: "pending" }), undefined)
  assert.equal(pullRequestChecksIndicator({ state: "MERGED", checks: "passing" }), undefined)
})

test("labels pull requests with their repository", () => {
  assert.equal(pullRequestLabel({
    owner: "vercel", repo: "front", number: 90443,
    url: "https://github.com/vercel/front/pull/90443",
  }), "vercel/front#90443")
})

test("only extracts pull requests created by gh", () => {
  const url = "https://github.com/vvo/opencode-plugins/pull/7"
  assert.equal(extractCreatedPullRequests("gh pr view 7", url).length, 0)
  assert.equal(extractCreatedPullRequests("gh pr create --draft", url)[0].url, url)
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
