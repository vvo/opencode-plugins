export type PullRequestRef = { owner: string; repo: string; number: number; url: string }
export type PullRequest = PullRequestRef & {
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "" | null
  hasUnresolvedReviewThread: boolean
  createdAt: string
  mergedAt: string | null
  additions: number
  deletions: number
}

export function pullRequestReviewIndicator(pr: Pick<PullRequest, "state" | "isDraft" | "reviewDecision" | "hasUnresolvedReviewThread">): "✓" | "⏳" | "!" | undefined {
  if (pr.state !== "OPEN" || pr.isDraft) return undefined
  if (pr.reviewDecision === "CHANGES_REQUESTED" || pr.hasUnresolvedReviewThread) return "!"
  if (pr.reviewDecision === "APPROVED") return "✓"
  return "⏳"
}

export function pullRequestStatus(pr: Pick<PullRequest, "state" | "isDraft">): "draft" | "open" | "merged" | "closed" {
  if (pr.state === "MERGED") return "merged"
  if (pr.state === "CLOSED") return "closed"
  return pr.isDraft ? "draft" : "open"
}

export function pullRequestLabel(pr: PullRequestRef): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`
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
  return prs.map(slackPullRequest).join("\n")
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
  const items = prs.map((pr) => slackPullRequestHtml(pr).replace(/^.*<body>|<\/body><\/html>$/g, ""))
  return `<meta charset='utf-8'><html><head></head><body>${items.join("<br>")}</body></html>`
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

export function extractCreatedPullRequests(command: string, output: string): PullRequestRef[] {
  if (!/(?:^|[;&|\s])gh\s+pr\s+create(?:\s|$)/.test(command)) return []
  return extractPullRequests(output)
}

export function uniquePullRequests(refs: Iterable<PullRequestRef>): PullRequestRef[] {
  return [...new Map([...refs].map((ref) => [ref.url, ref])).values()]
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
