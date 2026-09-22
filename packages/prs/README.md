# opencode-prs

[OpenCode](https://opencode.ai) TUI plugin that lists GitHub pull requests opened by the current session.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../assets/prs-hover-dark-v4.gif">
  <img src="../../assets/prs-hover-light-v4.gif" alt="Pull request titles scrolling on hover in the OpenCode sidebar" width="640">
</picture>

The sidebar section is collapsible. Each pull request uses a full-width linked title with its muted `repository#number` and colored status below: `approved` or `waiting` for open pull requests, `draft`, or `merged`. Open pull requests also show unresolved review comments and a checks indicator: `✓` passing, `×` failing, `◌` pending. Merged pull requests fold into one `▸ 3 merged` line under the open ones; click it to list them in subdued colors, so open work stays prominent. Hover a clipped title to scroll through its full text once. Click a status line to copy that PR as a Slack-ready summary, or `⧉` in the header to copy the whole list, confirmed with a toast.

## Install

OpenCode 2, in `~/.config/opencode/cli.json`:

```json
{ "plugins": ["opencode-prs"] }
```

OpenCode 1, in `~/.config/opencode/tui.json`:

```json
{ "plugin": ["opencode-prs"] }
```

Then restart OpenCode. The plugin requires an installed and authenticated [GitHub CLI](https://cli.github.com/).

## How it works

The plugin finds successful `gh pr create` calls made by the session, plus REST fallbacks that POST to `gh api repos/<owner>/<repo>/pulls`. It fetches every pull request of a session in one GraphQL request through `gh`, and falls back to the REST API per pull request when GraphQL fails, for example when its rate limit is exhausted. Closed pull requests are hidden, while merged pull requests remain visible behind the fold. The sidebar shows up to ten pull requests, ordered by open, draft, then merged, with the newest first in each group; merged ones only take the rows the active ones leave free.

A forked session only lists pull requests created after the fork. Messages copied from the parent keep their original timestamps, so anything older than the fork itself is skipped.

Results are cached by session. Switching tabs shows the previous result immediately and revalidates GitHub data in the background. The active tab refreshes statuses every thirty seconds without replacing unchanged rows.

One published package supports OpenCode 1 and OpenCode 2.

## Development

```sh
pnpm typecheck
pnpm test
```
