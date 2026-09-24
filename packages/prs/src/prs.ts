export type PullRequestRef = { owner: string; repo: string; number: number; url: string }
export type PullRequest = PullRequestRef & {
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null
  unresolvedThreads: number
  checks: "passing" | "failing" | "pending" | "none"
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"
  /** Checks on the head commit, for the panel. The sidebar only reads `checks`. */
  checkSummary: CheckSummary
  createdAt: string
  mergedAt: string | null
  additions: number
  deletions: number
}

/** Names for what needs attention, counts for the rest: a vercel/api PR runs 460 checks. */
export type CheckSummary = {
  failing: string[]
  running: string[]
  passing: number
  skipped: number
  total: number
}

export const EMPTY_CHECKS: CheckSummary = { failing: [], running: [], passing: 0, skipped: 0, total: 0 }

export type RollupState = "SUCCESS" | "FAILURE" | "ERROR" | "PENDING" | "EXPECTED"

type StateCount = { state: string; count: number }

export type StatusCheckRollup = {
  state: RollupState
  contexts: { totalCount: number; checkRunCountsByState: StateCount[]; statusContextCountsByState: StateCount[] }
}

export type CheckSuiteNode = {
  failing: { nodes: { name: string }[] }
  running: { nodes: { name: string }[] }
}

export type PullRequestNode = Pick<PullRequest, "title" | "state" | "url" | "number" | "isDraft" | "reviewDecision" | "mergeable" | "createdAt" | "mergedAt" | "additions" | "deletions"> & {
  reviewThreads: { nodes: { isResolved: boolean }[] }
  commits: { nodes: { commit: { statusCheckRollup: StatusCheckRollup | null; checkSuites: { nodes: CheckSuiteNode[] } } }[] }
}

/** GitHub's own verdict over every check, not just the ones we list. */
export function rollupChecks(state: RollupState | undefined): PullRequest["checks"] {
  if (state === "FAILURE" || state === "ERROR") return "failing"
  if (state === "PENDING" || state === "EXPECTED") return "pending"
  if (state === "SUCCESS") return "passing"
  return "none"
}

const FAILED_STATES = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]
const PASSED_STATES = ["SUCCESS"]
const RUNNING_STATES = ["QUEUED", "IN_PROGRESS", "PENDING", "WAITING", "REQUESTED", "EXPECTED"]

export function summarizeChecks(rollup: StatusCheckRollup | null | undefined, suites: CheckSuiteNode[]): CheckSummary {
  if (!rollup) return EMPTY_CHECKS
  const counts = [...rollup.contexts.checkRunCountsByState, ...rollup.contexts.statusContextCountsByState]
  const count = (states: string[]) => counts.filter((entry) => states.includes(entry.state)).reduce((total, entry) => total + entry.count, 0)
  const failed = count(FAILED_STATES)
  const running = count(RUNNING_STATES)
  const passing = count(PASSED_STATES)
  return {
    failing: withUnnamed(suites.flatMap((suite) => suite.failing.nodes.map((run) => run.name)), failed),
    running: withUnnamed(suites.flatMap((suite) => suite.running.nodes.map((run) => run.name)), running),
    passing,
    skipped: rollup.contexts.totalCount - failed - running - passing,
    total: rollup.contexts.totalCount,
  }
}

// Legacy status contexts have no name list, so a failing or pending one shows up in the count only.
function withUnnamed(names: string[], total: number): string[] {
  const unnamed = total - names.length
  return unnamed > 0 ? [...names, `${unnamed} more`] : names
}

export type RestPullRequest = {
  title: string
  state: "open" | "closed"
  draft: boolean
  mergeable: boolean | null
  created_at: string
  merged_at: string | null
  additions: number
  deletions: number
}

const PULL_REQUEST_FIELDS = [
  "title state url number isDraft reviewDecision mergeable createdAt mergedAt additions deletions",
  "reviewThreads(first: 100) { nodes { isResolved } }",
  "commits(last: 1) { nodes { commit {",
  "statusCheckRollup { state contexts(first: 1) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } } }",
  "checkSuites(first: 100) { nodes {",
  "failing: checkRuns(first: 20, filterBy: { checkType: LATEST, conclusions: [FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE] }) { nodes { name } }",
  "running: checkRuns(first: 20, filterBy: { checkType: LATEST, status: IN_PROGRESS }) { nodes { name } }",
  "} } } } }",
].join(" ")

// One aliased selection per PR so a session fetches all of them in a single request.
export function pullRequestsQuery(refs: PullRequestRef[]): string {
  const selections = refs.map((ref, index) => (
    `pr${index}: repository(owner: "${ref.owner}", name: "${ref.repo}") { pullRequest(number: ${ref.number}) { ...fields } }`
  ))
  return `query { ${selections.join(" ")} } fragment fields on PullRequest { ${PULL_REQUEST_FIELDS} }`
}

export function pullRequestFromNode(ref: PullRequestRef, node: PullRequestNode): PullRequest {
  const { reviewThreads, commits, ...fields } = node
  const commit = commits.nodes[0]?.commit
  return {
    ...ref,
    ...fields,
    unresolvedThreads: reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    checks: rollupChecks(commit?.statusCheckRollup?.state),
    checkSummary: summarizeChecks(commit?.statusCheckRollup, commit?.checkSuites.nodes ?? []),
  }
}

function restState(data: RestPullRequest): PullRequest["state"] {
  if (data.merged_at) return "MERGED"
  return data.state === "open" ? "OPEN" : "CLOSED"
}

// REST reports null while GitHub is still computing mergeability.
function restMergeable(mergeable: boolean | null): PullRequest["mergeable"] {
  if (mergeable === null) return "UNKNOWN"
  return mergeable ? "MERGEABLE" : "CONFLICTING"
}

// REST has no review decision, thread resolution or check rollup, so those keep their last GraphQL values.
export function pullRequestFromRest(ref: PullRequestRef, data: RestPullRequest, cached: PullRequest | undefined): PullRequest {
  return {
    ...ref,
    title: data.title,
    state: restState(data),
    isDraft: data.draft,
    createdAt: data.created_at,
    mergedAt: data.merged_at,
    additions: data.additions,
    deletions: data.deletions,
    reviewDecision: cached?.reviewDecision ?? null,
    mergeable: restMergeable(data.mergeable),
    unresolvedThreads: cached?.unresolvedThreads ?? 0,
    checks: cached?.checks ?? "none",
    checkSummary: cached?.checkSummary ?? EMPTY_CHECKS,
  }
}

export type ChecksIndicator = "✓" | "×" | "◌"
// GitHub stops running checks on a conflicting branch, so a green rollup would hide that the PR cannot merge.
export function pullRequestChecksIndicator(pr: Pick<PullRequest, "state" | "checks" | "mergeable">): ChecksIndicator | undefined {
  if (pr.state !== "OPEN") return undefined
  if (pr.mergeable === "CONFLICTING") return "×"
  if (pr.checks === "passing") return "✓"
  if (pr.checks === "failing") return "×"
  if (pr.checks === "pending") return "◌"
  return undefined
}

export function pullRequestStatus(pr: Pick<PullRequest, "state" | "isDraft">): "draft" | "open" | "merged" | "closed" {
  if (pr.state === "MERGED") return "merged"
  if (pr.state === "CLOSED") return "closed"
  return pr.isDraft ? "draft" : "open"
}

export function pullRequestStatusLabel(pr: Pick<PullRequest, "state" | "isDraft" | "reviewDecision">): string {
  const status = pullRequestStatus(pr)
  if (status !== "open") return status
  return pr.reviewDecision === "APPROVED" ? "approved" : "waiting"
}

export function pullRequestCommentsLabel(pr: Pick<PullRequest, "state" | "reviewDecision" | "unresolvedThreads">): string | undefined {
  if (pr.state !== "OPEN") return undefined
  const count = Math.max(pr.unresolvedThreads, pr.reviewDecision === "CHANGES_REQUESTED" ? 1 : 0)
  if (count === 0) return undefined
  return count === 1 ? "1 comment" : `${count} comments`
}

export function pullRequestLabel(pr: PullRequestRef): string {
  return `${pr.repo}#${pr.number}`
}

export function sortPullRequests(prs: PullRequest[]): PullRequest[] {
  const rank = { open: 0, draft: 1, merged: 2, closed: 3 }
  return [...prs].sort((left, right) => {
    const status = rank[pullRequestStatus(left)] - rank[pullRequestStatus(right)]
    if (status !== 0) return status
    const leftDate = left.state === "MERGED" ? left.mergedAt ?? left.createdAt : left.createdAt
    const rightDate = right.state === "MERGED" ? right.mergedAt ?? right.createdAt : right.createdAt
    return Date.parse(rightDate) - Date.parse(leftDate)
  })
}

/** Sorted PRs split so merged ones can fold behind a one-line summary and never push open work out of view. */
export function groupPullRequests(prs: PullRequest[]): { active: PullRequest[]; merged: PullRequest[] } {
  const sorted = sortPullRequests(prs)
  return {
    active: sorted.filter((pr) => pr.state !== "MERGED"),
    merged: sorted.filter((pr) => pr.state === "MERGED"),
  }
}

export function slackPullRequest(pr: PullRequest): string {
  return `:pr: *${pr.owner}/${pr.repo}* · <${pr.url}|${pr.title} (#${pr.number})> +${pr.additions}/-${pr.deletions}`
}

export function slackPullRequests(prs: PullRequest[]): string {
  if (prs.length === 1) return slackPullRequest(prs[0])
  return prs.map((pr) => `- ${slackPullRequest(pr)}`).join("\n")
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

export function slackPullRequestHtml(pr: PullRequest): string {
  const repository = escapeHtml(`${pr.owner}/${pr.repo}`)
  const url = escapeHtml(pr.url)
  const title = escapeHtml(`${pr.title} (#${pr.number})`)
  return `<meta charset='utf-8'><html><head></head><body>:pr: <b>${repository}</b> · <a href="${url}">${title}</a> +${pr.additions}/-${pr.deletions}</body></html>`
}

export function slackPullRequestsHtml(prs: PullRequest[]): string {
  if (prs.length === 1) return slackPullRequestHtml(prs[0])
  const items = prs.map((pr) => slackPullRequestHtml(pr).replace(/^.*<body>|<\/body><\/html>$/g, ""))
  return `<meta charset='utf-8'><html><head></head><body><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul></body></html>`
}

export function slackPullRequestsTexty(prs: PullRequest[]): string | undefined {
  if (prs.length < 2) return undefined
  const ops = prs.flatMap((pr) => [
    { insert: { slackemoji: { text: ":pr:" } } },
    { insert: " " },
    { attributes: { bold: true }, insert: `${pr.owner}/${pr.repo}` },
    { insert: " · " },
    { attributes: { link: pr.url }, insert: `${pr.title} (#${pr.number})` },
    { insert: ` +${pr.additions}/-${pr.deletions}` },
    { attributes: { list: "bullet" }, insert: "\n" },
  ])
  return JSON.stringify({ ops })
}

const GITHUB_PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\b|\/)/g

export function extractPullRequests(text: string): PullRequestRef[] {
  const refs = new Map<string, PullRequestRef>()
  for (const match of text.matchAll(GITHUB_PR_URL)) {
    const [, owner, repo, value] = match
    const number = Number(value)
    const url = `https://github.com/${owner}/${repo}/pull/${number}`
    refs.set(url, { owner, repo, number, url })
  }
  return [...refs.values()]
}

const GH_PR_CREATE = /(?:^|[;&|\s])gh\s+pr\s+create(?:\s|$)/
const GH_API = /(?:^|[;&|\s])gh\s+api\s/
const GH_API_PULLS = /\s["']?(?:https:\/\/api\.github\.com)?\/?repos\/[^\s\/"']+\/[^\s\/"']+\/pulls["']?(?=\s|$)/
const GH_API_METHOD = /\s(?:-X|--method)(?:=|\s+)?["']?(\w+)/
const GH_API_BODY = /\s(?:-[fF]|--field|--raw-field|--input)(?:=|\s|$)/

function createsPullRequest(command: string): boolean {
  if (GH_PR_CREATE.test(command)) return true
  const start = command.search(GH_API)
  if (start === -1) return false
  const call = command.slice(start)
  if (!GH_API_PULLS.test(call)) return false
  const method = GH_API_METHOD.exec(call)?.[1]
  if (method) return method.toUpperCase() === "POST"
  // gh api switches to POST when a request body is passed
  return GH_API_BODY.test(call)
}

export function extractCreatedPullRequests(command: string, output: string): PullRequestRef[] {
  if (!createsPullRequest(command)) return []
  return extractPullRequests(output)
}

export function uniquePullRequests(refs: Iterable<PullRequestRef>): PullRequestRef[] {
  return [...new Map([...refs].map((ref) => [ref.url, ref])).values()]
}

// Forks copy parent messages with their original timestamps, so anything older than the session came from the parent.
export function predatesSession(message: { time?: { created?: number } }, sessionCreated: number | undefined): boolean {
  const created = message.time?.created
  return sessionCreated !== undefined && created !== undefined && created < sessionCreated
}

export function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

export function marquee(value: string, width: number, offset: number): string {
  if (width <= 0) return ""
  if (value.length <= width) return value
  const loop = `${value}   `
  return Array.from({ length: width }, (_, index) => loop[(offset + index) % loop.length]).join("")
}
