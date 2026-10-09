---
"opencode-prs": patch
---

Use far less of the GitHub API rate limit. Check runs are only listed for suites that are running or failed, merged and closed PRs are fetched once, PRs refresh every two minutes unless checks are running, and a terminal window in the background stops refreshing until you come back to it.
