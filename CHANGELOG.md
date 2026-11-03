# Changelog

## Unreleased

### Breaking

- **Published as `@zerosumstudio/spool`.** The repo moved to
  [zerosumstudio/spool](https://github.com/zerosumstudio/spool). New workspaces
  depend on `@zerosumstudio/spool` and the shared state addon uses
  `@zerosumstudio/clutch`. Existing workspaces keep working on the old names, and the
  README has the swap steps.

### Added

- The npm package ships its README.

## 4.0.0 - 2026-10-22

### Breaking

- **Remote names are typed.** `<Remote name>`, `onError` and `preloadRemote` take a
  `RemoteName`, so a typo no longer compiles, and neither does a plain `string`.
  Type route tables as `Record<string, RemoteName>`. See
  [Upgrading to 4](./README.md#upgrading-to-4).
- **React's `<Remote>` only catches load failures.** A remote that throws while
  rendering reaches your own error boundary, so add one around the host's routes. See
  [Upgrading to 4](./README.md#upgrading-to-4).

### Added

- **`isRemoteName(name)`** narrows a runtime string to a `RemoteName`.
- **`matchRoute` is generic.** A `Record<string, RemoteName>` gives back a
  `RemoteName`.
- A generated composed host types its route table with `RemoteName`.

### Fixed

- A shell and a nested host no longer re-register a remote the other loaded.
- Clicking "Try again" twice no longer loads a remote twice.
- One failed expose no longer tears down a remote that works.
- A host with no remotes no longer gets an unused `loadRemote` import in `remotes.ts`.
- `spool upgrade` refreshes the navigation addon's files, asking first about any you
  edited.

## 3.1.1 - 2026-10-21

### Fixed

- "Try again" recovers a remote that failed to load, without a page reload. Run
  `spool upgrade`. If you edited `src/federation/remotes.ts`, take the new one
  and move your edits onto it, or the bug stays.
- Retry works for an expose such as `assessments/NewAssessment`.
- A failed `preloadRemote` no longer breaks the mount that follows it.
- A remote that failed in WebKit is retried from a fresh `remoteEntry.js` url.

## 3.1.0 - 2026-10-21

- **`server.fs.allow` in `spool.json`** lets the dev server serve folders outside the
  workspace, such as a sibling checkout linked with `link:`. `preview` is unaffected.
- The manifest rejects an empty `fs.allow` entry or the filesystem root. `spool
  doctor` errors on an entry that climbs to the root and warns about a missing folder.
- `spool dev` and `spool doctor` warn when `spool.vite.ts` predates `fs.allow`. Run
  `spool upgrade` to regenerate it.

## 3.0.1 - 2026-09-21

### Fixed

- Remote overrides apply. `setRemoteOverride` and `<Remote>` retry match a remote by
  its alias.
- `<Remote props>` accepts an `interface`.
- The playwright addon follows the federation addon, and walks each route of a routed
  shell.
- The lint addon passes on spool's own generated files.
- `<pm> run test` passes for an app without a test file.
- A fresh checkout passes type-check in CI, because the root `type-check` script runs
  `spool types` first.
- `spool ci` uses the node major only, since pnpm 11 refuses `22.12.0`, and the
  engines floor is `>=22.13.0`. The deploy step passes `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID`.

## 3.0.0 - 2026-09-09

See [Upgrading to 3](./README.md#upgrading-to-3).

### Breaking

- **Production builds minify.**
- **Every app gets a generated `public/_headers`** with `nosniff`, a
  `frame-ancestors 'self'` CSP and cache headers. Change them with
  `apps.<name>.frameAncestors` or `apps.<name>.headers`, and `["edge"]` writes no CSP.
- **`<Remote>` is generic and takes `props`.** `RemoteProps` gains a type parameter.
- **`spool.json` is validated at load**, rejecting self-referencing remotes, cycles,
  bad `exposes` keys and sources, and absolute or `..` app paths.
- **`addons` is a closed list.** `shell` still works and means `navigation` +
  `federation`, with one warning.
- **Dev and preview servers answer cross-origin requests only from the other apps in
  the manifest.** `server.cors` overrides it.
- **`devAll` and `previewAll` take an options object.**

### Added

- **`spool dev --only <list> --rest built|<env>`** runs the apps you work on and takes
  the remotes they need from `dist/` or their deployed url.
- **`spool types`** emits declarations for every expose into `.spool/types`. `dev` and
  `build` run it first.
- **`setRemoteOverride(name, url)`** from `@/federation` points a remote at another
  manifest. On in dev and preview, and production needs `"overrides": true`.
- **`preloadRemote(name)`** from `@/federation` warms a remote before it is shown.
- **`spool deploy --env <env>`** records deploys in `.spool/deploys.json` and refuses
  one whose shared versions another deployed app can't load. `spool promote` and
  `spool rollback` re-run a recorded deploy.
- **`spool graph`, `spool affected --since <ref>` and `spool eject`.**
- `spool doctor` checks ports in use, drift from `.spool/generated.json`, untracked
  generated files, registry and typings against `exposes`, unused shared entries, a
  missing `VITE_SENTRY_DSN` and stale `.spool/types`. `--json` prints the problems.
- `spool build --json` and `spool deploy --json` print one line per app.
- `--timeout <seconds>` and `--no-ladle` on `spool dev`.
- `spool ci --pin` resolves actions to commit shas. Generated workflows are
  least-privilege, with path filters and the node version from `engines`.
- Scaffolds gain `.gitattributes`, an `.env.example` per app with the sentry addon, and
  a `.gitignore` that keeps `.env.example`.
- Generated vite and vitest configs dedupe the framework runtime.
- Every file spool writes is recorded in `.spool/generated.json`.
- `spool.json` keeps your key order and gains no defaults you didn't write.
- Sentry builds upload hidden source maps and tag `environment` and `release`.
- Vitest wiring for any app with `remotes`, including nested exposes.

### Fixed

- `spool dev` no longer leaves vite processes behind, and `spool dev --kill` and
  `preview --kill` stop a run from another shell.
- `<Remote>` retry recovers from a failed `mf-manifest.json` or `remoteEntry.js`.
- `spool upgrade` and `spool add` offer an edited `src/federation/*` file instead of
  overwriting it, and `--force` overrides a file you chose to keep.
- `spool upgrade` ignores line endings, so a CRLF checkout isn't rewritten each run.
- `spool remove` unwires the app from every consumer, not only hosts.
- A child killed by a signal counts as a failure, and a remote that never reports
  ready no longer starts the hosts anyway.
- `spool add` and `spool addon sentry` wire sentry into the new app and
  `vite.config.ts`.
- `spool doctor --fix` writes into `packages/*` members.
- Alignment never writes a prerelease, a `>=` range or a `link:`, and `spool upgrade`
  leaves `link:`, `workspace:` and `file:` ranges alone.
- Sentry tells one app's errors from another's.

## 2.7.2 - 2026-09-03

- Remotes can expose more than their app. Every `exposes` key gets a registry row and
  a typing, so `<Remote name="dashboard/Panel" />` works.

## 2.7.1 - 2026-09-03

- Any app can consume remotes. Give it a `remotes` list and it gets the remotes map,
  `<Remote>`, the registry and `src/remotes.d.ts`.

## 2.7.0 - 2026-09-03

- The `shell` addon is split into `navigation` and `federation`, and `--addons shell`
  still works. Import from `@/navigation` and `@/federation`, and delete the old
  `src/shell`.

## 2.6.2 - 2026-09-02

- An unreachable remote no longer holds the page blank. Federation runs
  `shareStrategy: 'loaded-first'`, and `version-first` in `spool.json` restores the
  old behaviour.

## 2.6.1 - 2026-09-02

- `spool doctor` no longer asks a local package to declare the shared list.

## 2.6.0 - 2026-09-02

- New apps scaffold into `src/app/app.tsx` with a co-located `app.module.css`.
  Existing workspaces keep their layout.
- `spool doctor` and `spool upgrade` read every workspace member.
- `spool doctor` errors when an `exposes` path doesn't exist.
- Generated files follow the workspace's prettier config.
- `spool upgrade --force` takes paths.
- `spool addon <name> --only <apps>` writes per-app files into only those apps.
- `spool upgrade` names a generated file the first time it appears.

## 2.5.0 - 2026-09-02

- `spool upgrade` no longer downgrades dependencies, and `--pin` restores the old
  behaviour.
- `spool upgrade` offers files you edited instead of overwriting them. `--force`
  skips the asking, and with no terminal nothing is overwritten.
- **`spool doctor --fix`** adds missing shared deps and aligns versions. `--dry-run`
  shows the changes first.
- `spool doctor` reports drift in the deps spool writes itself.
- `spool build` fails when the version federation would load falls outside another
  app's range. Hosts emit a manifest, which needs `spool upgrade`.
- `<Remote>` isolates failures with a placeholder and retry. Pass `fallback`,
  `renderError` and `onError`.
- `spool ci` always writes a check workflow from the scripts your root package.json
  has.
- Apps in a tier build at once, and `--concurrency <n>` caps it.
- **New `lint`, `test` and `turbo` addons.**
- Every app gets a `type-check` script.
- **`spool.workspace.ts`** exports the app list with resolved paths.
- **`server` block in `spool.json`** for dev server settings such as a backend proxy.
  `${VAR}` and `${VAR:-fallback}` read the environment.
- `spool remove --files` asks before deleting the folder.
- Generated tsconfigs drop `baseUrl` for TypeScript 6.
- Toolchain moves to react 19.2.8, svelte 5.57.0, vue 3.5.42, typescript 6.0.3 and
  pnpm 11.25.0.

## 2.4.0 - 2026-08-13

- `url` and `urls` validate through zod 4's `z.url()`.
- An empty submit in `spool create` reports a validation message.

## 2.3.4 - 2026-08-12

- Every federation share is emitted with `singleton: true`. Run `spool upgrade` to
  pick it up.

## 2.2.0 - 2026-07-09

- **`spool preview`** serves every app's production build locally, remotes first.
- **Environments.** `"urls": { "staging": "https://..." }` on a remote and
  `spool build --env staging` select a manifest url. Order is `SPOOL_REMOTE_<NAME>`,
  the `urls` entry, `url`, then the local dev server.
- `spool deploy --env` passes `SPOOL_ENV` to your deploy commands, and
  `spool doctor --remote --env staging` probes those urls.
- An `--env` that matches no remote's `urls` warns.
- The manifest's `bundler: "rspack"` now errors, and `spool upgrade` removes it.
- Scaffolds gain a `preview` script, and dev and preview answer with CORS.

## 2.1.1 - 2026-07-09

- Scaffolds carry `@bkincz/spool` as a root dev dependency. `spool upgrade` adds it
  to older workspaces.
- `spool dev` prints one status panel with app, role, framework, url and ready time.
  Pipes and CI get it inline.
- A crash during startup dumps every app's buffered output.
- Extras picked together at create time compose, such as a state counter in every
  remote with the host showing the live count.

## 2.1.0 - 2026-07-08

- **`spool addon`** adds extras to an existing workspace, by name or from a prompt. It
  never overwrites existing files.
- The extras step in `spool create` asks unless `--addons` answers it. `--addons none`
  is explicit.

## 2.0.0 - 2026-07-08

- **Multi-framework workspaces.** Every app has a `framework` in `spool.json`, default
  `react`, and `react`, `svelte` and `vue` mix freely. `spool create` takes one per
  app.

  ```bash
  spool create acme --host shell:vue --remotes "dash:react, widget:svelte"
  ```

- React remotes expose their component, and svelte and vue remotes expose a mount
  function. Hosts consume each by its contract, and `spool add` prints a matching
  mount snippet.
- Sharing is per app: `shared` entries an app doesn't declare are dropped.
- `spool upgrade` regenerates each app for its own framework.
- `spool create` gains an extras step: Ladle, Playwright e2e and shared state through
  `@bkincz/clutch`.
- **`spool doctor --remote`** reports dead deployments, SPA fallbacks where
  `mf-manifest.json` should be, and missing CORS headers.
- Existing manifests are unchanged. Apps without a `framework` are react.

## 1.4.0 - 2026-07-06

- **`spool upgrade`** brings a workspace up to the installed spool version. Only
  spool-generated files are touched. `--dry-run` reports without writing.
- Scaffolded workspace READMEs list every command.

## 1.3.0 - 2026-07-06

- **`spool deploy`** runs each app's `deploy` command from `spool.json`, remotes before
  hosts. Apps without one are skipped with a warning.
- **`spool ci`** generates one path-filtered GitHub Actions workflow per deployable
  app. Rerun with `--force` after changing a deploy command.
- Scaffolded pnpm workspaces pin `packageManager`, and scaffolds use React 19.
- Scaffolds include `@types/node`, so `tsc --noEmit` passes on the vite config.
- `spool doctor` no longer flags subpath shares like `@bkincz/clutch/react`.

## 1.2.0 - 2026-07-06

- **`spool remove <name>`** drops an app from `spool.json` and unwires it from every
  host. The folder stays unless you pass `--files`.

## 1.1.0 - 2026-07-06

- A remote's `url` applies to production builds only, so `spool dev` keeps using local
  servers. `SPOOL_REMOTE_<NAME>` still overrides everywhere.
- New remotes ship a `public/_headers` with `Access-Control-Allow-Origin: *`.
- Regenerate `spool.vite.ts` and each app's `vite.config.ts` in existing workspaces.

## 1.0.1 - 2026-07-06

- Production builds of remotes emit `mf-manifest.json`, so a deployed host can resolve
  them. Existing workspaces set `manifest: true` in `spool.vite.ts`.

## 1.0.0 - 2026-07-06

- `spool create` scaffolds a Vite + React + TypeScript micro-frontend workspace over
  Module Federation, on pnpm, npm, or yarn.
- `spool dev` runs every app together, remotes first.
- `spool build` builds for production, remotes before hosts.
- `spool add` adds a host or remote to an existing workspace.
- `spool doctor` checks ports, app folders, federation wiring, and shared deps.
- All wiring lives in one `spool.json`.
- Remotes resolve through `SPOOL_REMOTE_<NAME>` env vars and a per-remote `url` field.
