---
"opencode-prs": minor
---

Fetch every pull request of a session in one GraphQL request instead of two `gh` calls per pull request, refresh the active tab every 30 seconds instead of 10, and fall back to the REST API when GraphQL fails. A session with 12 pull requests went from about 8,600 GitHub requests an hour to 120, so the sidebar no longer exhausts the GraphQL rate limit and shows "GitHub unavailable".
