# OpenCode plugins

Small plugins for [OpenCode](https://opencode.ai). Each package supports OpenCode 1 and OpenCode 2.

## Plugins

### [opencode-cost-details](packages/cost-details)

Shows what the current and previous prompt turns cost in the sidebar Context section, and what each model spent in the session.

<a href="packages/cost-details">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/cost-details-dark-v1.gif">
    <img src="assets/cost-details-light-v1.gif" alt="A new turn on another model: the turn costs reset and a third model row appears" width="452">
  </picture>
</a>

```sh
opencode2 plugin add opencode-cost-details
```

### [opencode-prs](packages/prs)

Shows GitHub pull requests opened by the current session. Every title links to GitHub.

<a href="packages/prs">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/prs-hover-dark-v7.gif">
    <img src="assets/prs-hover-light-v7.gif" alt="Pull requests opened by an OpenCode session" width="640">
  </picture>
</a>

```sh
opencode2 plugin add opencode-prs
```

### [opencode-find-sessions](packages/search-sessions)

Searches every prompt and reply of every session, typos included. Open it with `ctrl+x f`, `/search` or the field under the home prompt.

<a href="packages/search-sessions">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/search-sessions-dark-v1.gif">
    <img src="assets/search-sessions-light-v1.gif" alt="Typing rate limit in the search dialog, results narrowing with the matching words highlighted" width="720">
  </picture>
</a>

```sh
opencode2 plugin add opencode-find-sessions
```

### [opencode-awake](packages/awake)

Keeps your computer awake while a session works, including with the laptop lid closed on macOS and Linux.

```sh
opencode2 plugin add opencode-awake
```

See each plugin README for OpenCode 1 installation and configuration.

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
```

Packages live under `packages/`. Each package builds its TypeScript and JSX into `dist/` before publishing because OpenCode loads published plugins from `node_modules`.

To use the plugins from this checkout:

```sh
pnpm dev:link
pnpm dev
```

`dev:link` configures the compiled plugin directories in `cli.json` and removes the published versions. `dev` rebuilds the plugins when their source changes. Restart the OpenCode client after a rebuild to load it.

Restore the published configuration with:

```sh
pnpm dev:unlink
```

## Releasing

Releases use [Changesets](https://changesets.dev) and npm trusted publishing. There is no npm token in the repository.

1. Run `pnpm changeset` in a feature branch and commit the generated file.
2. Merge the feature PR. CI opens or updates `release: version packages`.
3. Merge the release PR. CI publishes every changed package to npm and tags the release.

Each npm package must trust the `release.yml` workflow in `vvo/opencode-plugins`. The job that holds the npm token installs no dependencies: it publishes tarballs that an earlier job built and tested without access to npm.

## License

MIT
