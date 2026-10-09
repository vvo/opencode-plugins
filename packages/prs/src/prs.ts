export type PullRequestRef = { owner: string; repo: string; number: number; url: string }
export type PullRequest = PullRequestRef & {
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null
  mergeStateStatus: "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE" | null
  unresolvedThreads: number
  checks: "passing" | "failing" | "pending" | "none"
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

type StateCount = { state: string; count: number }

/** Counts only: passing and skipped totals. Failing and running runs come from their suites. */
export type StatusCheckRollup = {
  contexts: { checkRunCountsByState: StateCount[]; statusContextCountsByState: StateCount[] }
}

export type CheckSuiteNode = {
  id: string
  status: string
  conclusion: string | null
  workflowRun: { runNumber: number; workflow: { id: string } } | null
}

/** Failing and running runs of one suite, fetched only for suites that are not green. */
export type CheckSuiteRuns = {
  id: string
  failing: { totalCount: number; nodes: { name: string }[] }
  running: { totalCount: number; nodes: { name: string }[] }
}

export type PullRequestNode = Pick<PullRequest, "title" | "state" | "url" | "number" | "isDraft" | "reviewDecision" | "mergeStateStatus" | "createdAt" | "mergedAt" | "additions" | "deletions"> & {
  reviewThreads: { nodes: { isResolved: boolean }[] }
  commits: { nodes: { commit: { statusCheckRollup: StatusCheckRollup | null; checkSuites: { nodes: CheckSuiteNode[] } } }[] }
}

/** Derived from the summary, not GitHub's rollup state: the rollup still counts runs a newer run of the same workflow replaced. */
export function checksState(summary: CheckSummary): PullRequest["checks"] {
  if (summary.failing.length > 0) return "failing"
  if (summary.running.length > 0) return "pending"
  if (summary.total > 0) return "passing"
  return "none"
}

// A cancelled run stays attached to the commit after a newer run of the same workflow replaces it. The PR page hides it.
export function currentSuites(suites: CheckSuiteNode[]): CheckSuiteNode[] {
  const latest = new Map<string, number>()
  for (const { workflowRun } of suites) {
    if (workflowRun) latest.set(workflowRun.workflow.id, Math.max(latest.get(workflowRun.workflow.id) ?? 0, workflowRun.runNumber))
  }
  return suites.filter(({ workflowRun }) => !workflowRun || latest.get(workflowRun.workflow.id) === workflowRun.runNumber)
}

const FAILED_STATES = ["FAILURE", "ERROR"]
const PASSED_STATES = ["SUCCESS"]
const RUNNING_STATES = ["PENDING", "EXPECTED"]
const FAILED_CONCLUSIONS = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]
const RUNNING_STATUSES = ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"]
const SKIPPED_CONCLUSIONS = ["SKIPPED", "NEUTRAL"]

/** Current suites still running or failed. Green suites never need their runs listed. */
export function suitesNeedingRuns(suites: CheckSuiteNode[]): CheckSuiteNode[] {
  return currentSuites(suites).filter((suite) => suite.status !== "COMPLETED" || FAILED_CONCLUSIONS.includes(suite.conclusion ?? ""))
}

export function summarizeChecks(
  rollup: StatusCheckRollup | null | undefined,
  allSuites: CheckSuiteNode[],
  runs: ReadonlyMap<string, CheckSuiteRuns>,
): CheckSummary {
  if (!rollup) return EMPTY_CHECKS
  const count = (entries: StateCount[], states: string[]) => entries.filter((entry) => states.includes(entry.state)).reduce((total, entry) => total + entry.count, 0)
  const statuses = rollup.contexts.statusContextCountsByState
  const checkRuns = rollup.contexts.checkRunCountsByState
  const failingNames: string[] = []
  const runningNames: string[] = []
  let failed = count(statuses, FAILED_STATES)
  let running = count(statuses, RUNNING_STATES)
  for (const suite of suitesNeedingRuns(allSuites)) {
    const suiteRuns = runs.get(suite.id)
    if (suiteRuns) {
      failed += suiteRuns.failing.totalCount
      running += suiteRuns.running.totalCount
      failingNames.push(...suiteRuns.failing.nodes.map((run) => run.name))
      runningNames.push(...suiteRuns.running.nodes.map((run) => run.name))
    } else if (suite.status === "COMPLETED") {
      failed++
    } else {
      running++
    }
  }
  const passing = count(statuses, PASSED_STATES) + count(checkRuns, PASSED_STATES)
  const skipped = count(checkRuns, SKIPPED_CONCLUSIONS)
  return {
    failing: withUnnamed(failingNames, failed),
    running: withUnnamed(runningNames, running),
    passing,
    skipped,
    total: failed + running + passing + skipped,
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
  created_at: string
  merged_at: string | null
  additions: number
  deletions: number
}

// GitHub prices a query by the connections it could return. Check runs nested in 100 suites cost
// 100 requests each, so runs are only listed for the few suites suitesNeedingRuns picks.
const PULL_REQUEST_FIELDS = [
  "title state url number isDraft reviewDecision mergeStateStatus createdAt mergedAt additions deletions",
  "reviewThreads(first: 100) { nodes { isResolved } }",
  "commits(last: 1) { nodes { commit {",
  "statusCheckRollup { contexts(first: 1) { checkRunCountsByState { state count } statusContextCountsByState { state count } } }",
  "checkSuites(first: 100) { nodes { id status conclusion workflowRun { runNumber workflow { id } } } }",
  "} } }",
].join(" ")

const CHECK_SUITE_RUNS_FIELDS = [
  "id",
  `failing: checkRuns(first: 20, filterBy: { checkType: LATEST, conclusions: [${FAILED_CONCLUSIONS.join(", ")}] }) { totalCount nodes { name } }`,
  `running: checkRuns(first: 20, filterBy: { checkType: LATEST, statuses: [${RUNNING_STATUSES.join(", ")}] }) { totalCount nodes { name } }`,
].join(" ")

// One aliased selection per PR so a session fetches all of them in a single request.
export function pullRequestsQuery(refs: PullRequestRef[]): string {
  const selections = refs.map((ref, index) => (
    `pr${index}: repository(owner: "${ref.owner}", name: "${ref.repo}") { pullRequest(number: ${ref.number}) { ...fields } }`
  ))
  return `query { ${selections.join(" ")} } fragment fields on PullRequest { ${PULL_REQUEST_FIELDS} }`
}

export function checkSuiteRunsQuery(ids: string[]): string {
  return `query { nodes(ids: ${JSON.stringify(ids)}) { ... on CheckSuite { ${CHECK_SUITE_RUNS_FIELDS} } } }`
}

/** Suites whose runs the second query must list, across every PR node. */
export function checkSuiteIdsNeedingRuns(nodes: (PullRequestNode | null | undefined)[]): string[] {
  return nodes.flatMap((node) => (
    node?.state === "OPEN" ? suitesNeedingRuns(node.commits.nodes[0]?.commit.checkSuites.nodes ?? []).map((suite) => suite.id) : []
  ))
}

export function pullRequestFromNode(ref: PullRequestRef, node: PullRequestNode, runs: ReadonlyMap<string, CheckSuiteRuns> = new Map()): PullRequest {
  const { reviewThreads, commits, ...fields } = node
  const commit = commits.nodes[0]?.commit
  // Checks only show on open PRs, and checkSuiteIdsNeedingRuns skips the others.
  const checkSummary = node.state === "OPEN" ? summarizeChecks(commit?.statusCheckRollup, commit?.checkSuites.nodes ?? [], runs) : EMPTY_CHECKS
  return {
    ...ref,
    ...fields,
    unresolvedThreads: reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    checks: checksState(checkSummary),
    checkSummary,
  }
}

function restState(data: RestPullRequest): PullRequest["state"] {
  if (data.merged_at) return "MERGED"
  return data.state === "open" ? "OPEN" : "CLOSED"
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
    mergeStateStatus: cached?.mergeStateStatus ?? null,
    unresolvedThreads: cached?.unresolvedThreads ?? 0,
    checks: cached?.checks ?? "none",
    checkSummary: cached?.checkSummary ?? EMPTY_CHECKS,
  }
}

export const ACTIVE_REFRESH_MS = 30_000
export const IDLE_REFRESH_MS = 120_000
const NEW_PULL_REQUEST_MS = 5 * 60_000

/** Fast while something is about to change: checks running, mergeability being computed, or a PR whose checks may not have started yet. */
export function refreshInterval(prs: Pick<PullRequest, "state" | "checks" | "mergeStateStatus" | "createdAt">[], now = Date.now()): number {
  const active = prs.some((pr) => pr.state === "OPEN" && (
    pr.checks === "pending" || pr.mergeStateStatus === "UNKNOWN" || now - Date.parse(pr.createdAt) < NEW_PULL_REQUEST_MS
  ))
  return active ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS
}

/** Merged and closed PRs never change again, so they are fetched once. */
export function isSettled(pr: Pick<PullRequest, "state">): boolean {
  return pr.state !== "OPEN"
}

export type ChecksIndicator = "✓" | "×" | "◌"
export function pullRequestChecksIndicator(pr: Pick<PullRequest, "state" | "checks">): ChecksIndicator | undefined {
  if (pr.state !== "OPEN") return undefined
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

// GitHub stops running checks on a conflicting branch, so conflicts must show even when every check is green.
export function pullRequestHasConflicts(pr: Pick<PullRequest, "state" | "mergeStateStatus">): boolean {
  return pr.state === "OPEN" && pr.mergeStateStatus === "DIRTY"
}

// Running required checks also report BLOCKED; the ◌ indicator already says they are pending.
export function pullRequestStatusLabel(pr: Pick<PullRequest, "state" | "isDraft" | "reviewDecision" | "mergeStateStatus" | "checks">): string {
  if (pullRequestHasConflicts(pr)) return "conflicts"
  const status = pullRequestStatus(pr)
  if (status !== "open") return status
  if (pr.reviewDecision !== "APPROVED") return "waiting"
  if (pr.mergeStateStatus === "BLOCKED" && pr.checks !== "pending") return "approved · blocked"
  return "approved"
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

// The repository name gives way first so the number, status and comments stay readable.
export function fitPullRequestLabel(pr: PullRequestRef, width: number): string {
  const label = pullRequestLabel(pr)
  if (label.length <= width) return label
  const number = `#${pr.number}`
  const repoWidth = width - number.length
  if (repoWidth < 2) return number
  return `${truncate(pr.repo, repoWidth)}${number}`
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

export type ChildSession = { id: string; created?: number; updated?: number }
export type DescendantRefs = { updated?: number; refs: PullRequestRef[]; children: string[] }
export type DescendantLoader = {
  children(sessionID: string): Promise<ChildSession[]>
  refs(session: ChildSession): Promise<PullRequestRef[]>
}

/**
 * PRs created by subagent sessions, at any depth. Only the root's children are listed on every call:
 * a child whose `updated` time has not moved reuses its cached refs and children.
 */
export async function descendantPullRequests(
  sessionID: string,
  known: Map<string, DescendantRefs>,
  load: DescendantLoader,
): Promise<PullRequestRef[]> {
  const refs: PullRequestRef[] = []
  const seen = new Set([sessionID])
  const visit = async (child: ChildSession): Promise<void> => {
    if (seen.has(child.id)) return
    seen.add(child.id)
    let entry = known.get(child.id)
    if (!entry || entry.updated === undefined || entry.updated !== child.updated) {
      const [childRefs, children] = await Promise.all([load.refs(child), load.children(child.id)])
      entry = { updated: child.updated, refs: childRefs, children: children.map((grandchild) => grandchild.id) }
      known.set(child.id, entry)
      refs.push(...entry.refs)
      await Promise.all(children.map(visit))
      return
    }
    refs.push(...entry.refs)
    await Promise.all(entry.children.map((id) => visit({ id, updated: known.get(id)?.updated })))
  }
  await Promise.all((await load.children(sessionID)).map(visit))
  return refs
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
