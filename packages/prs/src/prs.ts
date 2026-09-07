export type PullRequestRef = { owner: string; repo: string; number: number; url: string }
export type PullRequest = PullRequestRef & {
  title: string
  state: "OPEN" | "CLOSED" | "MERGED"
  isDraft: boolean
  createdAt: string
  additions: number
  deletions: number
}

export function pullRequestStatus(pr: Pick<PullRequest, "state" | "isDraft">): "draft" | "open" | "merged" | "closed" {
  if (pr.state === "MERGED") return "merged"
  if (pr.state === "CLOSED") return "closed"
  return pr.isDraft ? "draft" : "open"
}

export function sortPullRequests(prs: PullRequest[]): PullRequest[] {
  const rank = { open: 0, draft: 1, merged: 2, closed: 3 }
  return [...prs].sort((left, right) => {
    const status = rank[pullRequestStatus(left)] - rank[pullRequestStatus(right)]
    if (status !== 0) return status
    return Date.parse(right.createdAt) - Date.parse(left.createdAt)
  })
}

export function slackPullRequest(pr: PullRequest): string {
  return `:pr: ${pr.owner}/${pr.repo} <${pr.url}|*${pr.title}*> +${pr.additions} -${pr.deletions}`
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")
}

export function slackPullRequestHtml(pr: PullRequest): string {
  const repository = escapeHtml(`${pr.owner}/${pr.repo}`)
  const url = escapeHtml(pr.url)
  const title = escapeHtml(pr.title)
  return `<meta charset='utf-8'><html><head></head><body>:pr: ${repository} <a href="${url}"><b>${title}</b></a> +${pr.additions} -${pr.deletions}</body></html>`
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
