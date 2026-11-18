---
"opencode-prs": minor
---

Show a line from other tools under each PR. A tool on your machine, like a review bot, writes a small JSON file in `~/.local/state/opencode-prs/notes/`, and the sidebar and the `/prs` panel show its note, for example `Theo is reviewing`, as one muted line under the PR's status. A file its tool has not updated for 15 minutes is ignored. The README's "Notes from other tools" section has the format.
