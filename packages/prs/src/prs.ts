export type PullRequestRef = { owner: string; repo: string; number: number; url: string }
export type PullRequest = PullRequestRef & {
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null
  unresolvedThreads: number
  checks: "passing" | "failing" | "pending" | "none"
  createdAt: string
  mergedAt: string | null
  additions: number
  deletions: number
}

export type StatusCheck = { status?: string | null; conclusion?: string | null; state?: string | null }

const FAILED_CHECKS = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"]

export type PullRequestNode = Pick<PullRequest, "title" | "state" | "url" | "number" | "isDraft" | "reviewDecision" | "createdAt" | "mergedAt" | "additions" | "deletions"> & {
  reviewThreads: { nodes: { isResolved: boolean }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
  commits: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: StatusCheck[] } } | null } }[] }
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

const PULL_REQUEST_FIELDS = [
  "title state url number isDraft reviewDecision createdAt mergedAt additions deletions",
  "reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }",
  "commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { ... on CheckRun { status conclusion } ... on StatusContext { state } } } } } } }",
].join(" ")

export function pullRequestsQuery(refs: PullRequestRef[]): string {
  const selections = refs.map((ref, index) => (
    `pr${index}: repository(owner: "${ref.owner}", name: "${ref.repo}") { pullRequest(number: ${ref.number}) { ...fields } }`
  ))
  return `query { ${selections.join(" ")} } fragment fields on PullRequest { ${PULL_REQUEST_FIELDS} }`
}

export function pullRequestFromNode(ref: PullRequestRef, node: PullRequestNode): PullRequest {
  const { reviewThreads, commits, ...fields } = node
  const contexts = commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []
  return {
    ...ref,
    ...fields,
    unresolvedThreads: reviewThreads.nodes.filter((thread) => !thread.isResolved).length,
    checks: pullRequestChecks(contexts),
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
    unresolvedThreads: cached?.unresolvedThreads ?? 0,
    checks: cached?.checks ?? "none",
  }
}

export function pullRequestChecks(checks: StatusCheck[]): PullRequest["checks"] {
  const results = checks.map((check) => check.conclusion ?? check.state ?? "")
  if (results.some((result) => FAILED_CHECKS.includes(result))) return "failing"
  if (checks.some((check) => check.status && check.status !== "COMPLETED") || results.includes("PENDING") || results.includes("EXPECTED")) return "pending"
  if (results.includes("SUCCESS")) return "passing"
  return "none"
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
