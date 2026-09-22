---
"opencode-prs": minor
---

Add a pull requests panel on opencode 2. `/prs`, the command palette, or a click on the sidebar `PRs` header opens a pane beside the conversation listing every PR of the session at full width, with failing and running checks by name and a passing count. `j`/`k` move, `enter` opens in the browser, `c` copies for Slack, `C` copies the open ones, `r` refreshes, `f` toggles full screen, `q` closes. The sidebar checks indicator now comes from GitHub's rollup state, which covers every check instead of the first 100.
