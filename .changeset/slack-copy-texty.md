---
"opencode-prs": patch
---

Fix copied PRs pasting into Slack as `<url|title>` with an italic repository name. Slack now reads pasted plain text as Markdown and skips the HTML, so the copy also writes Slack's own clipboard format, which Slack desktop pastes as a linked title with a bold repository name and the `:pr:` emoji, for one PR or a list. The plain text is Markdown instead of Slack mrkdwn, so it also links correctly in GitHub, Linear and other editors.
