# opencode-prs

## 0.5.2

### Patch Changes

- 8f87d79: Drop the `pending` status word, since `◌` already shows running checks. Status words now share one color, so no state depends on telling colors apart. On a narrow sidebar the repository name shortens first, so comment counts are no longer cut off.

## 0.5.1

### Patch Changes

- 191bb10: Show `conflicts` in red as the status of a PR with merge conflicts, keep `×` for failing checks only, and show `approved · pending` instead of `approved · blocked` while required checks run.
- c8bd3f9: Show when an approved pull request is blocked from merging or still has pending checks.
- 251c581: Show a red × on PRs with merge conflicts, and a "merge conflicts" line in the /prs panel.

## 0.5.0

### Minor Changes

- 08e2351: Fold merged pull requests behind a one-line `▸ N merged` summary under the open ones. Click it to expand them. Open and draft PRs keep their two-line rows and are never pushed out of the ten visible rows by merged ones. The header count and the `⧉` copy button cover the open and draft PRs only.
- 9cdb1ca: Add a pull requests panel on opencode 2. `/prs`, the command palette, or a click on the sidebar `PRs` header opens a pane beside the conversation listing every PR of the session at full width, with failing and running checks by name and a passing count. `j`/`k` move, `enter` opens in the browser, `c` copies for Slack, `C` copies the open ones, `r` refreshes, `f` toggles full screen, `q` closes. The sidebar checks indicator now comes from GitHub's rollup state, which covers every check instead of the first 100.

## 0.4.1

### Patch Changes

- 6d5d6d2: Fix the copy buttons pasting plain `*bold*` and `<url|text>` markup into Slack. The clipboard payload now reaches `osascript` through stdin: passed as arguments, a list starting with `- ` was read as a command line option and anything over about 1 KB killed the process, so the copy silently fell back to plain text.
- 6d5d6d2: Render again on OpenCode 2.0.12 and later. The theme renamed `text.default` to `text.base`, `text.subdued` to `text.muted` and `feedback.*.default` to `feedback.*.base`; the old tokens resolved to `undefined`, which drew every plugin line in white.

## 0.4.0

### Minor Changes

- 56668c8: Fetch every pull request of a session in one GraphQL request instead of two `gh` calls per pull request, refresh the active tab every 30 seconds instead of 10, and fall back to the REST API when GraphQL fails. A session with 12 pull requests went from about 8,600 GitHub requests an hour to 120, so the sidebar no longer exhausts the GraphQL rate limit and shows "GitHub unavailable".

### Patch Changes

- 562c8b3: Forked sessions only list pull requests created after the fork. Messages inherited from the parent session are skipped, and history pagination stops once it reaches them.

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
