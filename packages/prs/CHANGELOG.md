# opencode-prs

## 0.3.1

### Patch Changes

- aaae95d: Fade merged pull requests further so open work stands out more.

## 0.3.0

### Minor Changes

- 1ec9492: Show review state as words (waiting, approved), count unresolved review threads and requested changes as comments, mark passing, failing or running checks, copy a pull request by clicking its status line, drop the owner from the sidebar label, sort merged pull requests by merge time, and copy the full list with native Slack and portable bullet formats.
- c062295: Refresh pull requests every ten seconds on the active tab and use the updated Slack review format when copying a pull request.

### Patch Changes

- e1144dd: Detect pull requests created with `gh api repos/<owner>/<repo>/pulls` (POST), not only `gh pr create`.

## 0.2.0

### Minor Changes

- 99a558a: Mark open pull requests as approved or waiting for review in the sidebar.

### Patch Changes

- ea6be40: Show each pull request as `owner/repository#number` in the sidebar.

## 0.1.7

### Patch Changes

- 4a68d78: Revalidate session history and pull requests when their tab regains focus.
- 55f2444: Use subdued colors for merged pull requests.

## 0.1.6

### Patch Changes

- 76fb27e: Write Slack-compatible HTML to the macOS clipboard so copied PR titles paste as rich links.

## 0.1.5

### Patch Changes

- a759043: Copy PR summaries as rich links that paste correctly in Slack.

## 0.1.4

### Patch Changes

- ecd9b53: Add a copy action for Slack-ready PR summaries with status, diff counts, and confirmation feedback.

## 0.1.3

### Patch Changes

- a1422c7: Refresh PR statuses every minute while a session tab remains active.

## 0.1.2

### Patch Changes

- a4903bc: Restore PR numbers, separate link and status colors, and update screenshots from the actual TUI.
- 6dceca5: Show up to ten PRs, ordered by open, draft, then merged and newest first within each group.
- 2fbc1f7: Give PR titles a full row, align metadata below, and scroll long titles once per hover.

## 0.1.1

### Patch Changes

- 7c6edb7: Show compact draft, open, and merged rows for pull requests opened by the session, with stale-while-revalidate caching on tab focus.

## 0.1.0

### Minor Changes

- 1a0976e: Show open GitHub pull requests referenced by the current OpenCode session.
