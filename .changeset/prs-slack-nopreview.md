---
"opencode-prs": minor
---

Paste copied PRs into Slack without a link preview or GitHub card. The Slack link goes through `gh-nopreview.vercel.app`, a stateless redirect to github.com that gives Slack's link fetcher an empty page. Set the `slackPreviews` option to `true` to keep previews.
