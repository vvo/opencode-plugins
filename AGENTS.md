# OpenCode plugins

This repository publishes independent OpenCode TUI plugins from `packages/`.

## Commands

- Use pnpm for workspace commands.
- Run `pnpm typecheck` and `pnpm test` before committing.
- Add a Changeset for package behavior changes. Skip it for docs and tooling only.

## Local plugin development

- Run `pnpm dev:link` once from the checkout you are editing. It builds every package before replacing published or previously linked plugin entries in `~/.config/opencode/cli.json`.
- Run `pnpm dev` while editing. It rebuilds `dist/` after source changes.
- Restart the OpenCode client after each rebuild. OpenCode loads compiled JavaScript from `dist/` and does not hot reload plugins.
- Run `pnpm dev:unlink` to restore the plugin entries saved by `dev:link`.
- Do not run `pnpm install` in a worktree. Worktrees share the main checkout's `node_modules` unless created with isolated dependencies.

## Screenshots

- Update the light and dark `opencode-prs` screenshots and hover GIFs when its visible output changes.
- Keep `assets/prs-light.png`, `assets/prs-dark.png`, `assets/prs-hover-light-v2.gif`, and `assets/prs-hover-dark-v2.gif` in sync with the current UI.

## Plugin compatibility

- Every plugin supports OpenCode 1 and OpenCode 2 from one npm version.
- The default export keeps `{ id, tui, setup }`.
- `tui` is the OpenCode 1 adapter. `setup` is the OpenCode 2 adapter.
- Never import `@opencode-ai/plugin` at runtime. Type-only imports are safe.
- Keep `@opentui/solid` and `solid-js` as optional peers.
- Publish compiled JavaScript under `dist/`. OpenCode skips JSX transforms inside `node_modules`.

## Layout

- Put shared, host-independent logic in ordinary `.ts` modules.
- Keep host adapters and JSX in `src/tui.tsx`.
- Unit tests run against built files under `dist/`.
- Keep package-specific details in each package README.

## Releasing

Changesets publishes packages independently through npm trusted publishing. Each published package must configure `vvo/opencode-plugins`, workflow `release.yml`, as its trusted publisher.
