import assert from "node:assert/strict"
import { test } from "node:test"
import { extractCreatedPullRequests, extractPullRequests, marquee, pullRequestStatus, slackPullRequest, slackPullRequestHtml, sortPullRequests, truncate, uniquePullRequests } from "../dist/prs.js"

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
  const pr = (number, state, isDraft, createdAt) => ({
    owner: "vvo", repo: "repo", number, url: `https://github.com/vvo/repo/pull/${number}`,
    title: String(number), state, isDraft, createdAt, additions: 4, deletions: 2,
  })
  const sorted = sortPullRequests([
    pr(1, "MERGED", false, "2026-09-04T10:00:00Z"),
    pr(2, "OPEN", true, "2026-09-04T12:00:00Z"),
    pr(3, "OPEN", false, "2026-09-04T09:00:00Z"),
    pr(4, "OPEN", false, "2026-09-04T11:00:00Z"),
  ])
  assert.deepEqual(sorted.map(({ number }) => number), [4, 3, 2, 1])
})

test("formats a PR for Slack", () => {
  const pr = {
    owner: "vvo", repo: "opencode-plugins", number: 22,
    url: "https://github.com/vvo/opencode-plugins/pull/22",
    title: "lower the cursor", state: "MERGED", isDraft: false,
    createdAt: "2026-09-04T10:00:00Z", additions: 4, deletions: 4,
  }
  assert.equal(slackPullRequest(pr), ":pr: vvo/opencode-plugins <https://github.com/vvo/opencode-plugins/pull/22|*lower the cursor*> +4 -4")
  assert.equal(
    slackPullRequestHtml(pr),
    `<meta charset='utf-8'><html><head></head><body>:pr: vvo/opencode-plugins <a href="https://github.com/vvo/opencode-plugins/pull/22"><b>lower the cursor</b></a> +4 -4</body></html>`,
  )
})
