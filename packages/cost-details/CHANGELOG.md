# opencode-cost-details

## 0.5.0

### Minor Changes

- 5ed440b: Show the day's total spend in the opencode 2 home screen footer, next to the MCP indicator. The figure comes from the server's session stats for sessions created since local midnight and refreshes after each usage event.

## 0.4.1

### Patch Changes

- 6d5d6d2: Render again on OpenCode 2.0.12 and later. The theme renamed `text.default` to `text.base`, `text.subdued` to `text.muted` and `feedback.*.default` to `feedback.*.base`; the old tokens resolved to `undefined`, which drew every plugin line in white.

## 0.4.0

### Minor Changes

- a978bab: Render the sidebar Context section instead of appending below it, so the turn costs sit directly under `spent` as a fourth line rather than under the MCP section.
  
  The token, percent, and spent figures are computed the way each host computes them and verified against the built-in section. On opencode 1 the plugin hides the built-in section itself. On opencode 2 that API no longer exists, so `-opencode.sidebar.context` has to be added to `cli.json`; see the README.

## 0.3.0

### Minor Changes

- 3f86107: Support opencode 2 alongside opencode 1 from a single package. The default export now carries both entrypoints (`tui` for opencode 1, `setup` for opencode 2), so the same version works on either host.
  
  The turn cost is now appended as one line under the built-in sidebar Context block instead of replacing that block, so tokens, percent used, and total spent stay exactly as opencode reports them. The plugin no longer deactivates the built-in section.
