# <picture><source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/zerosumstudio/spool/main/.github/assets/zerosum-on-dark.png"><img src="https://raw.githubusercontent.com/zerosumstudio/spool/main/.github/assets/zerosum-on-light.png" alt="" height="32"></picture> spool

[![npm version](https://badge.fury.io/js/@zerosumstudio%2Fspool.svg)](https://badge.fury.io/js/@zerosumstudio%2Fspool)
[![Release](https://github.com/zerosumstudio/spool/actions/workflows/release.yml/badge.svg?branch=main)](https://github.com/zerosumstudio/spool/actions/workflows/release.yml)
[![codecov](https://codecov.io/gh/zerosumstudio/spool/branch/main/graph/badge.svg)](https://codecov.io/gh/zerosumstudio/spool)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

spool is a small CLI for building micro frontends. It scaffolds a monorepo of Module Federation apps on Vite, runs them together with one command, and keeps all the wiring in a single `spool.json`. Hosts mount remotes with a `<Remote>` component that behaves the same in React, Vue and Svelte, and a `./vite` export reads the manifest, so a workspace carries no copy of spool's own helper code.

Live demo: [spool-demo-shell.pages.dev](https://spool-demo-shell.pages.dev), a music UI where the browse view, search, and player bar are independently deployed remotes sharing one player state through [@zerosumstudio/clutch](https://github.com/zerosumstudio/clutch).

Coming from `@bkincz/spool` 4.0? See the [migration guide](https://github.com/zerosumstudio/spool/blob/main/docs/migration-1.0.md).

## Install

```bash
npm install -g @zerosumstudio/spool
```

Requires Node 26 or newer. Workspaces run on pnpm, npm or yarn.

Up to 4.0.0 this was published as `@bkincz/spool`. Run `npm uninstall -g @bkincz/spool` before installing the new name, since both provide the `spool` command.

## Quick start

```bash
spool create acme --host shell --remotes "dashboard, profile"
cd acme
spool dev
```

Open http://localhost:5173 to see the host with its remotes mounted. Run `spool create` with no arguments to be prompted instead.

```bash
spool build
spool preview
```

`build` compiles every app for production, remotes first. `preview` serves the built apps together on localhost.

## Commands

Every command takes `-h, --help`, and `spool -v` prints the version.

| Command                    | What it does                                                                     |
| -------------------------- | -------------------------------------------------------------------------------- |
| `spool create [dir]`       | Scaffold a workspace                                                             |
| `spool add <name>`         | Add an app and wire it in                                                        |
| `spool addon [addons...]`  | Add extras to an existing workspace                                              |
| `spool remove <name>`      | Remove an app and unwire it from every consumer                                  |
| `spool dev`                | Run all apps together, remotes first                                             |
| `spool build`              | Production build. Remotes first, then hosts, each tier in parallel               |
| `spool preview`            | Serve the built apps locally                                                     |
| `spool types`              | Type each remote's exposes from its real source                                  |
| `spool deploy`             | Run each app's `deploy` command, remotes first                                   |
| `spool ci`                 | Generate GitHub workflows: one checking the workspace, one per deployable app    |
| `spool upgrade [files...]` | Migrate `spool.json`, regenerate spool-owned files and move dependencies forward |
| `spool doctor`             | Check ports, wiring, generated files, shared deps and environment                |
| `spool graph`              | Print hosts, remotes, what each consumes and exposes, and the shared list        |
| `spool eject`              | Remove the spool dependency and keep everything it generated                     |

### create

| Option              | Description                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `-n, --name <name>` | Workspace name. Defaults to the folder name                                                        |
| `--host <name>`     | Host app, as `name` or `name:framework`                                                            |
| `--remotes <list>`  | Comma-separated remotes, each as `name` or `name:framework`                                        |
| `--framework <fw>`  | Default framework: `react`, `svelte` or `vue`. Defaults to `react`                                 |
| `--addons <list>`   | Extras: `ladle`, `playwright`, `lint`, `test`, `turbo`, `state`, `sentry`, `navigation`, or `none` |
| `--pm <manager>`    | `pnpm`, `npm` or `yarn`                                                                            |
| `--here`            | Scaffold into the current folder. It stops and lists any generated file that already exists        |
| `--no-install`      | Skip the install step                                                                              |

Names are lowercase letters, digits and single hyphens, like `acme-frontend`, at most 64 characters. Windows device names such as `con` or `nul` are rejected on every OS, and so is an app named like a shared package.

Anything you leave out, spool asks for. Without a terminal it asks for nothing: `create` needs `--name` (or a folder), `--host`, `--remotes` and `--pm`, and `--addons` defaults to none.

### add

| Option             | Description                                         |
| ------------------ | --------------------------------------------------- |
| `-t, --type`       | `host` or `remote`. Defaults to `remote`            |
| `-p, --port`       | Dev server port. Defaults to the next free one      |
| `--host <name>`    | Host to wire the remote into. Defaults to the first |
| `--framework <fw>` | `react`, `svelte` or `vue`                          |
| `--no-install`     | Skip the install step                               |

`spool add` updates `spool.json`, typings and the host's remote registry, then prints where to render `<Remote name="..." />`. It never edits your components.

### addon

`spool addon sentry navigation` adds extras to an existing workspace. `--only <list>` limits the per-app files to some apps, and `--no-install` skips the install step. It never rewrites a component you may have edited.

### remove

`spool remove <name>` takes the app out of `spool.json` and unwires it from every app that lists it as a remote. The folder stays on disk until you pass `--files`, which asks before deleting. Without a terminal, `--files` needs `--yes`.

### dev

| Option                | Description                                                                  |
| --------------------- | ---------------------------------------------------------------------------- |
| `--only <list>`       | Run a subset of apps                                                         |
| `--rest <mode>`       | Where the remotes a subset needs come from: `built` or `env:<name>`          |
| `--timeout <seconds>` | How long to wait for each remote's manifest before giving up. Defaults to 20 |
| `--no-ladle`          | Skip the component workshop                                                  |
| `--kill`              | Stop a previous run and free the ports, then exit                            |

Working on one remote does not need every server up. `--rest built` previews the other remotes' `dist/`, and `--rest env:staging` loads each one from its `urls.staging` (or `url`):

```bash
spool dev --only shell,dashboard --rest env:staging
spool dev --only dashboard --rest built
```

`spool dev` writes `.spool/dev.pid` while it runs. `spool dev --kill` stops only processes it started: each one is checked against the start time and command line recorded in the pidfile. A manifest port held by anything else is reported, left running, and fails with `PORT_IN_USE`.

### build

| Option              | Description                                               |
| ------------------- | --------------------------------------------------------- |
| `--only <list>`     | Build a subset of apps                                    |
| `--env <name>`      | Select each remote's `urls.<name>` for this build         |
| `--concurrency <n>` | Apps built at once. Defaults to half the cores, at most 4 |
| `--json`            | Print one JSON document. See [Scripting](#scripting)      |

`build` and `dev` run `spool types` first, then start each app's own `vite` directly. They do not read the apps' `package.json` scripts. After a build, spool compares what each app resolved for every shared dep and fails only when one app would load a version another cannot accept. An exported `SPOOL_ENV` counts like `--env`.

### preview

`spool preview` serves each app's `dist/` on its manifest port, remotes first. It takes `--only <list>` and `--kill`, and fails when an app has no `dist/`. A remote that has a deployed `url` in `spool.json` is loaded from there by hosts built with `spool build`, so preview warns about it.

### deploy

| Option          | Description                                          |
| --------------- | ---------------------------------------------------- |
| `--only <list>` | Deploy a subset of apps                              |
| `--env <name>`  | Exposed to the command as `SPOOL_ENV`, and recorded  |
| `--json`        | Print one JSON document. See [Scripting](#scripting) |

Apps deploy one at a time, remotes first, and the run stops at the first failure. `--env` also writes what shipped to `.spool/deploys.json`: the commit, the url, the time, and the shared dep versions the app was built with. Commit that file. Before each deploy spool compares the app's shared versions with what the other apps last shipped to that environment, and refuses when one would load a version another cannot accept, naming both.

### upgrade

| Option        | Description                                                                        |
| ------------- | ---------------------------------------------------------------------------------- |
| `--dry-run`   | Report what would change without writing                                           |
| `--downgrade` | Write this CLI's dependency ranges even when the workspace is ahead of them        |
| `--force`     | Overwrite generated files that have local changes. Name paths after it to limit it |

See [Checks and upgrades](#checks-and-upgrades).

### doctor, graph, eject, ci and types

| Command        | Options                                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spool doctor` | `--fix` repairs what it safely can, `--dry-run` shows those changes first, `--remote` also fetches each deployed remote url, `--env <name>` checks `urls.<name>` instead of `url`, `--json` |
| `spool graph`  | `--json`, `--dot` for Graphviz                                                                                                                                                              |
| `spool eject`  | `--yes` skips the confirmation. Required without a terminal                                                                                                                                 |
| `spool ci`     | `--force` overwrites existing workflow files                                                                                                                                                |
| `spool types`  | `--only <list>`                                                                                                                                                                             |

## The manifest

Everything lives in one `spool.json`. Each app's `vite.config.ts` reads it through [`spoolApp()`](#vite-config) when Vite starts, so the manifest is the only thing you edit. The file is validated as it loads, and an unknown key is an error.

<!-- prettier-ignore -->
```json
{
  "name": "acme",
  "version": 2,
  "packageManager": "pnpm",
  "shared": ["react", "react-dom"],
  "apps": {
    "shell":     { "type": "host",   "path": "apps/shell",     "port": 5173, "remotes": ["dashboard"] },
    "dashboard": { "type": "remote", "path": "apps/dashboard", "port": 5174, "exposes": { "./App": "./src/app/app.tsx" },
                   "url": "https://dashboard.example.com/mf-manifest.json" }
  }
}
```

| Field                        | Description                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`                       | Workspace name                                                                                                              |
| `version`                    | Required, and `2`. A file without it, or with `1`, fails with `MANIFEST_VERSION`. Run `spool upgrade`                       |
| `packageManager`             | `pnpm` (default), `npm` or `yarn`                                                                                           |
| `bundler`                    | `vite`, the only value and the default                                                                                      |
| `shared`                     | Deps shared as singletons across apps. Defaults to `react` and `react-dom`. A dep an app does not install is dropped for it |
| `shareStrategy`              | `loaded-first` (default) or `version-first`                                                                                 |
| `csp`                        | `default` or `strict`. See [Headers and CSP](#headers-and-csp)                                                              |
| `addons`                     | Extras enabled in this workspace. See [Addons](#addons)                                                                     |
| `server`                     | Dev and preview server settings every app gets. See [Server settings](#server-settings)                                     |
| `overrides`                  | `{ "origins": [...] }`. Origins a runtime remote override may load from. See [Overrides](#overrides)                        |
| `apps.<name>.type`           | `host` consumes remotes, `remote` exposes modules                                                                           |
| `apps.<name>.framework`      | `react` (default), `svelte` or `vue`                                                                                        |
| `apps.<name>.path`           | Folder, relative to the workspace. Lowercase, and never outside it                                                          |
| `apps.<name>.port`           | Dev server port, 1 to 65535                                                                                                 |
| `apps.<name>.remotes`        | Remotes this app mounts. A remote can consume remotes too                                                                   |
| `apps.<name>.exposes`        | Modules a remote exposes, keys starting with `./` and values a file inside the app                                          |
| `apps.<name>.url`            | Deployed `mf-manifest.json`, used by host production builds                                                                 |
| `apps.<name>.urls`           | Per-environment manifests, like `{ "staging": "https://..." }`. `--env` selects one                                         |
| `apps.<name>.deploy`         | Shell command `spool deploy` runs in the app folder                                                                         |
| `apps.<name>.deployEnv`      | Upper-case secret names the generated deploy workflow passes to `deploy`. Defaults to none                                  |
| `apps.<name>.headers`        | Extra response headers for this app, in dev, preview and the built `_headers`                                               |
| `apps.<name>.frameAncestors` | Who may frame this app: `self`, `none`, origins, or `["edge"]` alone. Defaults to `self`                                    |

`url` and `urls` values are http or https urls with no username or password. Header names are letters, digits and hyphens, and values cannot hold line breaks or control characters.

The manifest also fails right away, naming the app, for a remote that names itself or is not in the workspace, a cycle through `remotes`, an expose outside its app folder, or an app `path` outside the workspace. `spool doctor` catches the rest after hand-editing.

### Server settings

`server` holds what every app's dev and preview server needs, so you never edit a generated `vite.config.ts`.

| Field     | Description                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------- |
| `proxy`   | Vite proxy entries. Each is a target string or `{ target, changeOrigin, secure, ws }`                   |
| `headers` | Headers for dev and preview only, not the built `_headers`                                              |
| `host`    | `true`, `false` or a host name                                                                          |
| `cors`    | List of allowed origins, like `["http://localhost:5173"]`. Defaults to every app's own localhost origin |
| `fs`      | `{ "allow": [...] }`: folders outside the workspace the dev server may serve                            |

```json
{
	"server": {
		"proxy": {
			"/api": { "target": "${ACME_BACKEND:-http://localhost:3000}", "changeOrigin": true }
		}
	}
}
```

`${VAR}` and `${VAR:-fallback}` read the environment at startup in `proxy`, `host` and `fs.allow`. Only variables named `SPOOL_*` or `VITE_*` expand, so a manifest edit cannot pull in an unrelated secret. Any other name becomes its fallback, or an empty string.

### Serving files outside the workspace

Vite's dev server only serves files inside the workspace, so a module linked in from a sibling folder gets a 403. List the folders in `server.fs.allow`, relative to the folder `spool.json` is in:

```text
contracts/packages/schemas     shared zod schemas, linked with "link:../contracts/packages/schemas"
frontend/spool.json
frontend/apps/shell
```

```json
{
	"server": {
		"fs": { "allow": ["../contracts/packages"] }
	}
}
```

Every app's dev server then allows the workspace root, as Vite does by default, plus each folder you list, as absolute paths. Vite's `fs.deny` defaults (`.env`, `.env.*`, certificates, `.git`) still apply inside them. `preview` serves only the built `dist/` and ignores the setting.

An empty entry or the filesystem root is rejected. A folder that does not exist yet is only a `spool doctor` warning, since Vite ignores it. Entries may use `${VAR}`. `doctor` skips those, and the dev server refuses one that expands to nothing.

## Addons

Pick extras at the `spool create` prompt, or pass `--addons "ladle, playwright, lint, test, turbo, state, sentry, navigation"`. `spool addon` adds one to an existing workspace later. Federation is not an addon: every host has it.

- **Ladle**: a React design-system package in `packages/ui` with a component workshop. `spool dev` starts it alongside your apps, or open it on its own with `pnpm --filter ui ladle`. It needs at least one React app.
- **Playwright**: e2e tests in `packages/e2e` that boot the workspace and check every remote mounts. Run `npx playwright install` once, then `pnpm --filter e2e test`. It needs a host.
- **ESLint**: one flat config at the root with `strictTypeChecked` rules and the plugin each framework you use needs. It adds Prettier and the `format` and `format:check` scripts.
- **Vitest**: a `vitest.config.ts` per app, separate from `vite.config.ts` because federation cannot run under a test. Any app with `remotes` gets them stubbed in `src/test`, regenerated when the remote list changes.
- **Turborepo**: a `turbo.json` that puts `spool.json` and the `SPOOL_ENV` and `SPOOL_REMOTE_*` variables into the cache key, so a wiring change never gets a stale hit. `spool dev` and `spool build` are unchanged. Turbo covers the tasks spool does not run.
- **Shared state**: [@zerosumstudio/clutch](https://github.com/zerosumstudio/clutch) shared as a singleton, plus `src/state/counter.ts` in every app, a `sharedStore` that resolves every copy to one store per page. It validates its shape with a plain predicate, so swap in a zod or valibot schema if you want one. Bump its `version` and add a `migrate` when the shape changes.
- **Sentry**: error reporting wired into every app. See [Sentry](#sentry).
- **Navigation**: one url every bundle on the page agrees on, in `src/navigation`. `navigate` and `useLocation` ride on `window.history`, so back and forward work across remotes and deep links resolve on load. `matchRoute` returns the value at the longest url prefix that matches, such as a `RemoteName`.

Addons picked together at create time compose. With the state addon every remote renders a working counter and the host shows the live count, and the Playwright spec gains a test proving a remote's click updates the host.

A generated workspace has Node `>=26` in `engines` and `.nvmrc`, a root named `<name>-workspace`, and per-app `type-check` scripts: `tsc` for React, `vue-tsc` for Vue and `svelte-check` for Svelte. Each app's `package.json` also has `dev`, `build` and `preview` scripts that run `vite`, for use outside spool.

## Vite config

Each app's `vite.config.ts` calls `spoolApp()` from `@zerosumstudio/spool/vite`. The export reads and validates `spool.json` with the CLI's own parser, so a typo fails at config load with the same message `spool doctor` gives, prefixed with `[spool]`.

```ts
import { federation } from '@module-federation/vite'
import react from '@vitejs/plugin-react'
import { spoolApp } from '@zerosumstudio/spool/vite'
import { defineConfig } from 'vite'

export default defineConfig(({ command }) => {
	const app = spoolApp('shell', { root: import.meta.dirname, command })

	return {
		server: app.server,
		preview: app.server,
		plugins: [react(), federation(app.federation), app.plugin],
		build: { target: 'esnext' },
	}
})
```

| Return value | What it holds                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`     | Port, `strictPort`, the `cors` allowlist, `proxy`, `fs`, and the headers. Use it for both `server` and `preview`                              |
| `federation` | Options for `federation()`: name, exposes, remotes, `shared` as singletons, `shareStrategy`, and the manifest                                 |
| `plugin`     | Defines the override origins, serves the same per-path headers in dev and preview, and writes `_headers` into the build. Keep it in `plugins` |

`command` decides where a host finds its remotes. A build reads `SPOOL_REMOTE_<NAME>`, then the remote's `urls` entry for `SPOOL_ENV`, then its `url`, then `http://localhost:<port>/mf-manifest.json`. A dev server skips the deployed urls and uses the environment variable or localhost. `SPOOL_REMOTE_<NAME>` must be an http or https url with no credentials. `spoolApp` never shares `svelte`, whatever `shared` lists.

`spool eject` writes the helper to `spool.vite.js` and `spool.vite.d.ts` at the workspace root and points each `vite.config.ts` at it, for a workspace that wants to own the code.

## Federation

Every host has `<Remote>`, the remote registry and `preloadRemote`, in `src/federation`. Mount a remote by name, across frameworks. Every module a remote exposes gets a name: `<Remote name="dashboard" />` is its app, and `<Remote name="dashboard/Panel" />` is a widget it also offers. The names make up a generated `RemoteName` type, so a typo like `<Remote name="dashbaord" />` or `preloadRemote("serach")` does not compile. A name that only arrives at runtime goes through `isRemoteName(name)` first. An unknown name renders nothing, and warns in dev.

React remotes expose a component. Vue and Svelte remotes expose a mount function that takes the target element and props once, and returns an unmount function. Hosts mount each remote by its contract, and a non-React host gets a small React bridge for a React remote.

### React

```tsx
import { Remote } from '@/federation'

export function Dashboard() {
	return (
		<Remote
			name="dashboard"
			props={{ compact: true }}
			fallback={<p>Loading</p>}
			renderError={(error, retry) => (
				<button type="button" onClick={retry}>
					{error.code}: try again
				</button>
			)}
			onError={(error, name) => console.warn(name, error.code)}
		/>
	)
}
```

| Prop          | Description                                                                           |
| ------------- | ------------------------------------------------------------------------------------- |
| `name`        | A `RemoteName`                                                                        |
| `props`       | Props for a component remote, or the second argument of a mount function              |
| `fallback`    | Rendered while the remote loads. Defaults to nothing                                  |
| `renderError` | `(error, retry) => ReactNode` for a load failure. Defaults to a message with a button |
| `onError`     | `(error, name)`, called once per failure                                              |

An error a remote throws while rendering, after it has loaded, is not a load failure. `<Remote>` does not report it and passes it on, exactly as thrown, to your app's own error boundaries. Give the host an error boundary around its routes, or React unmounts the page.

### Vue

```vue
<script setup lang="ts">
import { Remote } from '@/federation'
</script>

<template>
	<Remote name="dashboard" :props="{ compact: true }">
		<template #fallback>
			<p>Loading</p>
		</template>
		<template #error="{ error, retry }">
			<button type="button" @click="retry">{{ error.code }}: try again</button>
		</template>
	</Remote>
</template>
```

| API              | Description                                                   |
| ---------------- | ------------------------------------------------------------- |
| `name`, `props`  | As in React                                                   |
| `#fallback` slot | Rendered while the remote loads                               |
| `#error` slot    | Scope `{ error, retry }`. Defaults to a message with a button |
| `@error` event   | `(error, name)`, emitted once per failure                     |

### Svelte

```svelte
<script lang="ts">
	import { Remote } from '@/federation'
</script>

<Remote name="dashboard" props={{ compact: true }}>
	{#snippet fallback()}
		<p>Loading</p>
	{/snippet}
	{#snippet error(failure, retry)}
		<button type="button" onclick={retry}>{failure.code}: try again</button>
	{/snippet}
</Remote>
```

| Prop               | Description                                           |
| ------------------ | ----------------------------------------------------- |
| `name`, `props`    | As in React                                           |
| `fallback` snippet | Rendered while the remote loads                       |
| `error` snippet    | `(error, retry)`. Defaults to a message with a button |
| `onError`          | `(error, name)`, called once per failure              |

### Loading, errors and retry

A load that takes longer than 15 seconds rejects with `TIMEOUT`. Every failure is a `RemoteError` with a `code`, the `remote` id it was loading, a `needsReload` flag and the original `cause`.

| Code           | Meaning                                                               |
| -------------- | --------------------------------------------------------------------- |
| `TIMEOUT`      | The manifest or entry did not load within 15 seconds                  |
| `ENTRY_FAILED` | The remote's manifest or `remoteEntry.js` could not be fetched or run |
| `CHUNK_FAILED` | The entry loaded, but one of its modules did not                      |
| `NOT_FOUND`    | No remote is registered under that name                               |

`needsReload` is true when the remote's entry had already loaded before the failure, since a browser such as WebKit keeps a failed module import for the life of the page. The default error UI then shows "Reload page" in place of "Try again", and a custom one should do the same.

`retry` fetches the remote's manifest and entry again, so once the remote is back it renders without a page reload. A failed `preloadRemote` does not stick: the first mount after it loads the remote again by itself, so a short outage during a boot preload recovers without anyone clicking retry. Every host on the page, nested hosts included, shares what it knows about each remote's entry, so once any of them has loaded a remote the rest reuse it and no retry evaluates it twice. If one expose of a loaded remote fails, only that expose is retried.

`src/federation/report.ts` is called with every failed load before `onError`. It logs with `console.error`, or with the Sentry addon sends the error with a `remote` tag. It is spool-owned like the rest of `src/federation`, and `spool upgrade` asks before replacing an edited copy.

### Svelte is never shared

A Svelte app mounts with its own Svelte runtime. Sharing `svelte` across federation splits the runtime between a remote's `mount` and its components, so `spoolApp` never shares `svelte` or a `svelte/*` subpath, and `create`, `add` and `upgrade` keep it out of `shared`. A page with two Svelte apps carries two copies of the runtime, which share nothing but the DOM node they are given. Share state through `@zerosumstudio/clutch`, which does not depend on Svelte. The reasoning is in [ADR 8](https://github.com/zerosumstudio/spool/blob/main/docs/adr/0008-svelte-not-shared.md).

### Composing remotes

Composing remotes is your own code, one region or many, persistent or routed:

```tsx
import { useLocation, matchRoute } from '@/navigation'
import { Remote, preloadRemote, type RemoteName } from '@/federation'

const routes: Record<string, RemoteName> = { '/': 'browse', '/search': 'search' }

export function Layout() {
	const active = matchRoute(useLocation().pathname, routes)

	return (
		<>
			<Remote name="player" props={{ compact: true }} /> {/* always mounted */}
			{active && <Remote name={active} />} {/* swaps with the url */}
			<a href="/search" onMouseEnter={() => preloadRemote('search')}>
				Search
			</a>
		</>
	)
}
```

### Types across the boundary

`spool types` emits declarations for every expose using the workspace's TypeScript into `.spool/types`, then rewrites each consumer's `src/remotes.d.ts` to point at them. `<Remote name="dashboard/Panel" props={...} />` is typed against the real component, and a changed prop fails type-check in the host. `spool dev` and `spool build` run it first. Without a TypeScript install spool falls back to prop-less typing and says so.

## Overrides

Point a running host at a different build of one remote from the browser console. The override lives in `localStorage` and only affects you:

```ts
import { setRemoteOverride, listRemoteOverrides } from '@/federation'

setRemoteOverride('dashboard', 'https://dashboard-pr-42.example.com/mf-manifest.json')
listRemoteOverrides() // { dashboard: { url, expiresAt } }
setRemoteOverride('dashboard', null) // back to the build's url
```

Reload the page after setting one. An override is never read from the page url, so a crafted link cannot swap in someone else's remote.

- **Origins are an allowlist.** The url's origin must be in `overrides.origins` in `spool.json`, with no list meaning no overrides. A build allows only that list. A dev server also allows every app's own localhost origin.
- **The url is checked.** It must be https (http to localhost, in dev only), carry no credentials, query or fragment, and end in `mf-manifest.json` or `remoteEntry.js`. The remote's manifest must also load its code from a listed origin.
- **It expires in 24 hours.** `setRemoteOverride(name, url, { ttlMs })` can only shorten that. An expired or invalid override is removed.
- **It announces itself.** The console shows `[federation] "dashboard" is overridden to ... until ...` once per remote.

```json
{ "overrides": { "origins": ["https://dashboard-pr-42.example.com"] } }
```

A listed origin can run code in your page, so list only origins that serve your own builds. With `csp: "strict"` they are added to `script-src` and `connect-src`.

## Headers and CSP

The `./vite` plugin writes `dist/_headers` from `spool.json` at build, so the shipped file always follows the manifest. Cloudflare Pages and Netlify read it as-is. On Vercel, set the same headers in `vercel.json`. Nothing about headers is generated into your workspace.

| Path                                   | Headers                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `/mf-manifest.json`, `/remoteEntry.js` | `Cache-Control: no-cache`                                                                 |
| `/assets/*`                            | `Cache-Control: public, max-age=31536000, immutable`                                      |
| `/*`                                   | `X-Content-Type-Options: nosniff`, `Content-Security-Policy`, and the app's own `headers` |

A remote's manifest, entry and `/assets/*` also get `Access-Control-Allow-Origin: *`, since hosts fetch them cross-origin. A header in `apps.<name>.headers` with the same name as a generated one replaces it.

The default policy for every app is `frame-ancestors 'self'; object-src 'none'; base-uri 'self'`. `csp: "strict"` adds `script-src` and `connect-src`:

- **Sources**: `'self'` plus the origin of every remote the app consumes (its `url`, each `urls` entry, and any `SPOOL_REMOTE_<NAME>`) and every `overrides.origins` entry.
- **`connect-src`** also allows the Sentry origin, read from `VITE_SENTRY_DSN` when the sentry addon is on.

A host that must be framed by a partner sets `frameAncestors: ["https://partner.example"]`. When an edge layer in front of the app decides that per request, set `frameAncestors: ["edge"]` and spool leaves `frame-ancestors` out of the policy, since two `frame-ancestors` headers intersect and would block the frame.

`spool preview` serves the same policy, caching and custom headers as `_headers`, strict sources included. CORS is the exception: preview follows the `server.cors` list, not `*`. `spool dev` serves them too, except the strict `script-src` and `connect-src` and the immutable `/assets/*` cache, which hot reload cannot work with.

Both `build` and `preview` read `VITE_SENTRY_DSN` from the environment, then the app's `.env` files, to allow the Sentry origin. If preview finds none under `csp: "strict"`, it warns that `connect-src` leaves Sentry out, which happens when the DSN only exists as a build-time variable.

## Sentry

The sentry addon gives each app its framework SDK (Sentry 11), a `src/sentry.ts` called from its entry, a `src/sentry-scrub.ts` and a `.env.example`. Set `VITE_SENTRY_DSN` per app. Without it, `initSentry` does nothing.

Errors are tagged `mfe` with the app whose chunk threw them, so a remote failing inside a host is filed under the remote, and `remote` with the name a host asked for and could not load.

What stays out of events:

- `dataCollection` is off for user info, cookies, request and response headers, and bodies. The `Console` integration is removed.
- Every url is cut to its origin and path: the request url, urls in exception and event messages, and breadcrumb urls and messages. A request's query string and `Referer` header are removed.
- The Vue SDK's `attachProps` is off, and any component props are stripped from the event.

Tracing is off by default. If you turn it on, wire `scrubEvent` from `src/sentry-scrub.ts` into `beforeSendTransaction` (or the span hook your Sentry version offers), so transaction urls lose their query strings too. Nothing scrubs them for you.

With `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` in CI, `spool build` uploads hidden source maps, deletes them from `dist/`, and tags the release with `SENTRY_RELEASE`, or the short git sha when that is unset.

## Deploying

Every app builds to a plain static site. Give apps a `deploy` command in `spool.json`, deploy the remotes, set each remote's `url` to its deployed `mf-manifest.json`, then rebuild and deploy the host:

```bash
spool build
spool deploy --env production
```

A host resolves each remote in this order:

1. `SPOOL_REMOTE_<NAME>` env var (dev and build)
2. the remote's `urls` entry for `--env` or `SPOOL_ENV` (production builds only)
3. the remote's `url` in `spool.json` (production builds only)
4. `http://localhost:<port>/mf-manifest.json`

For staging and friends, give a remote per-environment urls and build with `spool build --env staging`. `spool deploy --env staging` passes the name to your deploy commands as `SPOOL_ENV`, and `spool doctor --remote --env staging` probes those urls. Example deploy commands: `wrangler pages deploy dist --project-name=<p>`, `netlify deploy --prod --dir=dist`, `vercel deploy dist --prod`, `aws s3 sync dist s3://<bucket> --delete`.

### CI

`spool ci` writes a check workflow that runs whichever of `doctor`, `type-check`, `lint`, `test` and `build` your root `package.json` has, plus a path-filtered deploy workflow per app with a `deploy` command. Every action is pinned to a commit sha. Deploy jobs wait for the check job, run only on `main`, have read-only permissions, never cancel a running deploy, and trigger on the app's folder, the workspace packages and the workspace files.

A deploy job passes no secrets by default. List the ones its command reads in `deployEnv`, then rerun `spool ci --force`:

```json
{
	"apps": {
		"dashboard": {
			"deploy": "wrangler pages deploy dist --project-name=dashboard",
			"deployEnv": ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]
		}
	}
}
```

Deploy jobs run in the `production` GitHub environment, which accepts every branch until you restrict it. In Settings > Environments, set Deployment branches to `main` and add required reviewers. Without that, anyone with write access can run the workflow from their own branch and read the deploy secrets.

## Checks and upgrades

- `spool doctor` checks ports (including one another process holds), wiring, exposed files, registry and typings, generated files against what spool wrote, shared dep versions across every workspace member, shared entries an app never imports, a leftover `spool.vite.ts` or `public/_headers`, and the environment the addons need. `--fix` repairs what it safely can, `--dry-run` shows the changes first, and `--json` prints the problems for CI.
- `spool upgrade` migrates a version 1 `spool.json`, regenerates spool-owned files and syncs dependency ranges. It never overwrites your edits: spool hashes every file it writes into `.spool/generated.json`, so a later run can tell its own output from yours. Edited files are offered, not replaced. `--force` skips the asking and takes paths to limit it. Commit `.spool/generated.json`. `.spool/types` and pidfiles are ignored.
- Versions only move forward, onto the highest range already in the workspace, so a workspace ahead of spool stays ahead. `--downgrade` writes spool's own ranges regardless. Prereleases and `>=` ranges are never chosen as the target.
- `spool graph` shows the workspace as a tree, or as `--dot` for Graphviz.
- For the apps a change touches, use `pnpm --filter "...[<ref>]"` or `turbo --affected`.
- `spool eject` removes the spool dependency and leaves the rest in place. `spool.json`, `spool.workspace.ts` and every generated config keep working without the CLI. It deletes `.spool/`, and swaps the `dev` and `build` scripts for plain package manager ones, which run apps in whatever order the manager picks.

`spool.workspace.ts` reads the manifest when you import it, so nothing built on it goes stale:

```ts
import { apps, hosts, remotes, srcDirs, app, root } from '../../spool.workspace'
```

Each app has `name`, `type`, `framework`, `port`, absolute `dir` and `src`, `remotes`, and `exposes`. The module also exports `workspaceName`, `shared` and `addons`.

## Scripting

`build`, `deploy`, `doctor` and `graph` take `--json`. The run prints exactly one document to stdout, with logs and the output of commands spool runs on stderr, and never prompts:

```json
{ "ok": true, "command": "build", "results": [{ "name": "dashboard", "ok": true, "durationMs": 4210 }] }
{ "ok": false, "command": "build", "error": { "code": "BUILD_FAILED", "message": "..." }, "results": [] }
```

| Command           | Fields besides `ok` and `command`                                                           |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `build`, `deploy` | `results`: `{ name, ok, durationMs, error? }` per app, also on a failure                    |
| `doctor`          | `problems`: `{ level, code, app, message }`. Fails with `CHECK_FAILED` when any is an error |
| `graph`           | `name`, `apps` (`name`, `type`, `framework`, `port`, `consumes`, `exposes`) and `shared`    |

A bad flag under `--json` gets the failure document too.

| Exit code | Meaning                                                                                                                                              |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`       | Success                                                                                                                                              |
| `1`       | A failure: a build, a check, a port, a file. `error.code` says which                                                                                 |
| `2`       | Bad usage, or input that could not be asked for: `USAGE`, `INVALID_NAME`, `INVALID_PATH`, `INVALID_VALUE`, `INPUT_REQUIRED`, `CONFIRMATION_REQUIRED` |
| `130`     | Cancelled with Ctrl+C at a prompt                                                                                                                    |

Without a terminal, spool never prompts. A missing value exits 2 with `INPUT_REQUIRED` and names the flag, and a destructive step without `--yes` exits 2 with `CONFIRMATION_REQUIRED`. `remove --files` and `eject` need `--yes`. The failure codes are `NO_WORKSPACE`, `MANIFEST_INVALID`, `MANIFEST_VERSION`, `APP_NOT_FOUND`, `TARGET_EXISTS`, `TARGET_NOT_EMPTY`, `UNSAFE_PATH`, `BUILD_FAILED`, `DEPLOY_FAILED`, `PORT_IN_USE`, `CHECK_FAILED`, `FAILED` and `INTERNAL`.

## Windows

- Names and paths that Windows cannot hold are rejected on every OS, so a workspace made anywhere clones everywhere. That covers device names (`con`, `nul`, `aux`, `prn`, `com1` and so on) in names and paths, network and device paths, and drive-relative paths like `C:foo`.
- `dev`, `preview` and `build` start each app's `vite` through the same Node that runs spool, so no `.cmd` shim or shell is involved.
- `spool dev --kill` checks a process's start time and command line through PowerShell before it ends the tree with `taskkill`. Port owners come from `netstat`. All three are run from the system folder, not from `PATH`.
- Generated workspaces have a `.gitattributes` that keeps line endings as LF, so a file written on Windows does not show as entirely changed to everyone else.

## Upgrading to 1.0

1.0 is the first release under `@zerosumstudio`. Coming from `@bkincz/spool` 4.0, run `spool upgrade` in the workspace, then `spool doctor`. `spool.json` moves to version 2, `spool.vite.ts` and `public/_headers` give way to the `./vite` import, `promote`, `rollback` and `affected` are gone, exit codes and `--json` change, and Node 26 is required. The [migration guide](https://github.com/zerosumstudio/spool/blob/main/docs/migration-1.0.md) opens with a checklist and covers each change with a before and after. The full list is in the [changelog](https://github.com/zerosumstudio/spool/blob/main/CHANGELOG.md).

## License

MIT © zerosum studio
