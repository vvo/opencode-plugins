# opencode-find-sessions

## 0.1.1

### Patch Changes

- 4946b25: Sessions an automation started and tagged with `factory` in their metadata, like a review bot's runs, no longer show up in search.

## 0.1.0

### Minor Changes

- 011011e: New plugin: full-text search across every session's prompts and replies, typo tolerant, with highlighted excerpts. Open it with `ctrl+x f`, `/search`, the command palette or the search field under the home prompt. Pull request links, `owner/repo#123` and `repo#123` find each other, including links that only a tool call printed.
