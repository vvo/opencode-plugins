---
"opencode-prs": patch
---

Fix the copy buttons pasting plain `*bold*` and `<url|text>` markup into Slack. The clipboard payload now reaches `osascript` through stdin: passed as arguments, a list starting with `- ` was read as a command line option and anything over about 1 KB killed the process, so the copy silently fell back to plain text.
