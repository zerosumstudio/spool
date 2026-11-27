# Migrating from `@bkincz/spool` 4.0 to `@zerosumstudio/spool` 1.0

1.0 is the first release under `@zerosumstudio`. It needs Node 26, moves `spool.json` to version 2, replaces the generated `spool.vite.ts` and `public/_headers` with an import from the package, removes `promote`, `rollback` and `affected`, makes federation part of every host, and tightens overrides, headers, exit codes and `--json`. Most of the workspace is migrated by `spool upgrade`. The rest is listed below, because spool never rewrites a file you may have edited.

This guide covers `@bkincz/spool` 4.0.0. Older versions need the 4.0 changes first.

## Checklist

Work through these in order, then run `spool doctor`.

1. Use Node 26 or newer, install `@zerosumstudio/spool`, and uninstall `@bkincz/spool`, since both provide the `spool` command. See [package and runtime](#package-and-runtime).
2. Swap `@bkincz/spool` for `@zerosumstudio/spool` in the root `package.json`, and `@bkincz/clutch` for `@zerosumstudio/clutch` if you use the state addon: in `spool.json` `shared`, each app's `package.json` and your imports.
3. Run `spool upgrade --dry-run`, then `spool upgrade`, then your package manager's install. It migrates `spool.json` and removes `spool.vite.ts` and `public/_headers`. See [`spool.json`](#spooljson-version-2) and [the vite helper](#the-vite-helper-and-headers).
4. If you edited an app's `vite.config.ts`, call `spoolApp(name, { root, command })` and add `app.plugin` to `plugins`. See [the vite helper](#the-vite-helper-and-headers).
5. List the origins a runtime override may load from in `overrides.origins`, and check `server.cors`. See [overrides and CORS](#overrides-and-cors).
6. Replace `spool dev --rest <env>` with `--rest env:<env>`, `spool upgrade --pin` with `--downgrade`, and drop `spool ci --pin`. Move anything that ran `promote`, `rollback` or `affected` into CI. See [commands and flags](#commands-and-flags).
7. Update scripts and CI that read exit codes or `--json` output, and pass `--yes` to `remove --files` and `eject` where there is no terminal. See [exit codes, `--json` and no terminal](#exit-codes---json-and-no-terminal).
8. Move hosts that mount remotes by hand onto `<Remote>`, and drop `federation` from any `--addons` list. See [federation](#federation-is-always-on).
9. Port the shared state files to clutch 1.0, and replace `src/sentry.ts`. See [the generated workspace](#the-generated-workspace).
10. Run `spool ci --force`, list each deploy command's secrets in `deployEnv`, and restrict the `production` GitHub environment. See [deploy workflows](#deploy-workflows).
11. Check [behaviour changes](#behaviour-changes) against what your scripts rely on, then run `spool doctor`.

## Package and runtime

| 4.0                                                                  | 1.0                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `@bkincz/spool`                                                      | `@zerosumstudio/spool`. `@bkincz/spool` stays on npm at 4.0.0                    |
| Node 22.12 or newer for the CLI, `>=22.13.0` in generated workspaces | Node 26 or newer for both (`engines.node` is `>=26`)                             |
| `spool.vite.ts` in every workspace                                   | `import { spoolApp } from '@zerosumstudio/spool/vite'`, an export of the package |
| Runtime dependencies for prompts, parsing, color                     | `@clack/prompts` only. Nothing to do                                             |

```bash
npm uninstall -g @bkincz/spool
npm install -g @zerosumstudio/spool
```

`spool upgrade` adds `@zerosumstudio/spool` to the root `devDependencies` and leaves `@bkincz/spool` where it is, so remove the old entry yourself. It also moves `engines.node` to `>=26` in the root and every app. It does not write `.nvmrc`, so add one with `26` if you want it. The generated workflows read the Node version from `engines`.

Spool no longer ships Prettier. It formats the files it writes with your workspace's own Prettier when one is installed, with your config on top of the house style, and writes them as generated otherwise.

## `spool.json` version 2

`version` is required and is `2`. Every command that reads the workspace, except `spool upgrade`, refuses a version 1 file with `MANIFEST_VERSION`, and so does the `./vite` import. `spool upgrade` migrates it and prints each change.

```json
{
	"name": "acme",
	"bundler": "rspack",
	"addons": ["shell", "federation"],
	"shared": ["react", "react-dom", "svelte"],
	"server": { "cors": true },
	"overrides": true
}
```

```json
{
	"name": "acme",
	"version": 2,
	"addons": ["navigation"],
	"shared": ["react", "react-dom"],
	"server": { "cors": ["http://localhost:5173", "http://localhost:5174"] },
	"overrides": { "origins": [] }
}
```

| 4.0                          | 1.0                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| No `version`                 | `"version": 2`                                                                                                 |
| `"overrides": true`          | `"overrides": { "origins": [] }`. List the origins to allow, or overrides stay inert. `false` is removed       |
| `"server": { "cors": true }` | A list of origins. Migration writes every app's localhost origin, where `true` allowed any. `false` is removed |
| Addon `shell`                | `navigation`. Its `src/shell` files move to `src/federation` and `src/navigation`                              |
| Addon `federation`           | Dropped from the list, since every host has it. `spool.json` still accepts it and ignores it                   |
| `svelte` in `shared`         | Removed. Svelte is never shared, see [ADR 8](./adr/0008-svelte-not-shared.md)                                  |
| `"bundler": "rspack"`        | Removed. Vite is the only bundler                                                                              |

New settings: `csp` (`default` or `strict`), `apps.<name>.deployEnv`, and `overrides.origins`.

The manifest is checked more strictly. A workspace or app name must be lowercase letters, digits and single hyphens, at most 64 characters, and not a Windows device name such as `con` or `nul` or the name of a shared package. App paths, expose keys and sources, `url` and `urls` values, header names and values, and origins are checked too. An unknown key is an error, as before. A file that fails lists every problem, with `MANIFEST_INVALID`. After the migration, `${VAR}` in `server.proxy`, `host` and `fs.allow` expands only for variables named `SPOOL_*` or `VITE_*`. Any other name becomes its fallback.

## The vite helper and headers

Each app's `vite.config.ts` used to import `spool.vite.ts` from the workspace root. It now imports the package, and a plugin writes `_headers` into the build from `spool.json`.

```ts
// before
import { spoolApp } from '../../spool.vite'

export default defineConfig(({ command }) => {
	const app = spoolApp('shell', import.meta.dirname, command)

	return {
		server: app.server,
		preview: app.server,
		plugins: [react(), federation(app.federation)],
	}
})
```

```ts
// after
import { spoolApp } from '@zerosumstudio/spool/vite'

export default defineConfig(({ command }) => {
	const app = spoolApp('shell', { root: import.meta.dirname, command })

	return {
		server: app.server,
		preview: app.server,
		plugins: [react(), federation(app.federation), app.plugin],
	}
})
```

`spool upgrade` regenerates `vite.config.ts` when you have not edited it, and offers it when you have. Otherwise make the two edits above by hand: the options object, and `app.plugin` in `plugins`. Without the plugin there is no `_headers` and no override origins.

`spool upgrade` removes `spool.vite.ts` and each app's `public/_headers` when they are still what spool wrote. An edited one stays, and `spool doctor` warns `leftover-helper` or `leftover-headers`. Delete a leftover `public/_headers` once its content is in `spool.json`: it is copied into `dist` and clashes with the generated one. Move extra headers into `apps.<name>.headers`, and framing rules into `frameAncestors`.

`dist/_headers` now also carries `object-src 'none'` and `base-uri 'self'` for every app, and `csp: "strict"` adds `script-src` and `connect-src`. See [Headers and CSP](../README.md#headers-and-csp) in the README.

`spool eject` writes the helper to `spool.vite.js` and `spool.vite.d.ts` at the workspace root and points each `vite.config.ts` at it.

## Commands and flags

| 4.0                                                              | 1.0                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `spool promote --env <env> <app>@<sha>`                          | Removed. Check out the commit, then `spool build --env <env>` and `spool deploy --env <env>` |
| `spool rollback --env <env> <app>`                               | Removed. Check out the commit you want back and deploy it the same way                       |
| `spool affected --since <ref>`                                   | Removed. Use `pnpm --filter "...[<ref>]"` or `turbo --affected`                              |
| `spool ci --pin`                                                 | Removed. Workflows always pin actions to commit shas, with no network call                   |
| `spool upgrade --pin`                                            | `spool upgrade --downgrade`                                                                  |
| `spool upgrade --force [files...]`                               | `spool upgrade --force [files...]`. Files are positional arguments after the command         |
| `spool dev --rest staging`                                       | `spool dev --rest env:staging`. `--rest built` is unchanged                                  |
| `spool build --concurrency` defaulted to one less than the cores | Half the cores, at most 4                                                                    |

`.spool/deploys.json` is still written by `deploy --env`, and the shared-version check still reads it. Its `sha` fields say what to check out. `promote` and `rollback` only re-ran a deploy command at a recorded sha, so a CI job that checks out the sha and runs `spool build` and `spool deploy` does the same.

A command given a flag it does not know fails with `USAGE` and exit code 2. `spool --help` and `spool <command> --help` list the real options.

### `dev`, `preview` and `build` run vite directly

They used to run each app's `package.json` scripts through your package manager. They now start the app's own `vite` through the same Node that runs spool, so a custom `dev`, `build` or `preview` script is not run by spool, and nothing else in it is either. Move a post-build step into the vite config, a vite plugin, or your CI.

The generated deploy workflow still runs `<pm> run build` in the app folder, so keep that script working.

`spool dev --kill` and `spool preview --kill` only stop processes that spool started, checked by start time and command line. A manifest port held by anything else is reported and fails with `PORT_IN_USE`. A pidfile written by 4.0 is never killed from, so stop a leftover 4.0 run by hand once.

## Exit codes, `--json` and no terminal

| Situation                                        | 4.0           | 1.0                                                         |
| ------------------------------------------------ | ------------- | ----------------------------------------------------------- |
| Bad flag, missing argument, invalid name or path | Exit 1        | Exit 2, with a code such as `USAGE` or `INVALID_NAME`       |
| A build, check, port or file failure             | Exit 1        | Exit 1, with a code such as `BUILD_FAILED` or `PORT_IN_USE` |
| Ctrl+C at a prompt                               | Exit 0        | Exit 130, with `CANCELLED`                                  |
| A malformed `spool.json`                         | A stack trace | Exit 1, `MANIFEST_INVALID`, listing every problem           |

`--json` is on `build`, `deploy`, `doctor` and `graph`. A run prints exactly one document to stdout, with logs and the output of commands spool runs on stderr.

```text
// before: build and deploy printed one line per app
{"name":"dashboard","ok":true,"duration":4210}
{"name":"shell","ok":true,"duration":3877}

// before: doctor printed only the problems
{"problems":[]}
```

```json
{
	"ok": true,
	"command": "build",
	"results": [
		{ "name": "dashboard", "ok": true, "durationMs": 4210 },
		{ "name": "shell", "ok": true, "durationMs": 3877 }
	]
}
```

A failure prints `{ "ok": false, "command", "error": { "code", "message" } }` with the same fields the command had gathered, so a failed build still lists its `results`. `duration` is now `durationMs`. `doctor --json` has `problems` and fails with `CHECK_FAILED` when any is an error, and `graph --json` has `name`, `apps` and `shared`. A bad flag under `--json` gets the failure document too. The full list of codes is in the README's [Scripting](../README.md#scripting) section.

Without a terminal, or under `--json`, spool never prompts:

- `remove --files` and `eject` used to assume yes. They now exit 2 with `CONFIRMATION_REQUIRED` unless you pass `--yes`.
- `create` needs `--name` (or a folder), `--host`, `--remotes` and `--pm`, or it exits 2 with `INPUT_REQUIRED` naming the flag. `--addons` defaults to none.
- `create --here` stops with `TARGET_NOT_EMPTY` and lists any file it would overwrite, where it used to mix into the folder.

## Federation is always on

Every host now has `<Remote>`, the registry, `preloadRemote` and the override functions in `src/federation`, whether or not the `federation` addon was picked. The separate mounting code and mount hints that hosts without the addon had are gone from the generator.

`spool upgrade` writes `src/federation` into every host and keeps it in step as remotes change. It does not rewrite your components, so a host that mounts remotes with its own `lazy` imports keeps them until you move it to `<Remote>`:

```tsx
// before: a host without the federation addon
const Dashboard = lazy(() => import('dashboard/App'))

// after
import { Remote } from '@/federation'

;<Remote name="dashboard" fallback={<p>Loading</p>} />
```

`<Remote>` takes the same options in React, Vue and Svelte now. React has `renderError` and `onError`. Vue has `fallback` and `error` slots and an `error` event. Svelte has `fallback` and `error` snippets and `onError`. A load that takes longer than 15 seconds rejects with `TIMEOUT`, and a `RemoteError` carries a `code` of `TIMEOUT`, `ENTRY_FAILED`, `CHUNK_FAILED` or `NOT_FOUND`. The README's [Federation](../README.md#federation) section has the details.

`federation` is ignored in `spool.json`, and `--addons federation` is refused with `Unknown addon`. `--addons shell` is refused with a note that it became `navigation`.

## Overrides and CORS

`setRemoteOverride(name, url)` used to take any url. It now needs the url's origin in `overrides.origins`.

```json
{ "overrides": { "origins": ["https://dashboard-pr-42.example.com"] } }
```

| 4.0                                 | 1.0                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `"overrides": true` allowed any url | Only origins listed in `overrides.origins`. A build allows nothing else, and a dev server also allows the apps' localhost origins |
| An override stayed until cleared    | It expires after 24 hours at most                                                                                                 |
| Silent                              | The console shows `[federation] "<name>" is overridden to ... until ...`                                                          |
| Any path                            | https only (http to localhost in dev), no credentials, query or fragment, ending in `mf-manifest.json` or `remoteEntry.js`        |

The manifest of an overridden remote must load its code from a listed origin too. A listed origin can run code in your page, so list only origins that serve your own builds.

`server.cors` is a list of origins. Omit it to allow every app's own localhost origin. If you had `true` and relied on it, list the origins you need, since migration only wrote the localhost ones.

## The generated workspace

`spool upgrade` moves dependency ranges forward and regenerates files it owns. These are the changes a new `spool create` scaffold has, and what to do about them in an existing workspace.

| Change                                   | In an existing workspace                                                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Node 26, `engines >=26`, `.nvmrc` 26     | `upgrade` moves `engines`. Add `.nvmrc` yourself                                                                       |
| Root package named `<name>-workspace`    | A new scaffold only. An existing root keeps its name                                                                   |
| `.prettierrc` has `trailingComma: all`   | `upgrade` replaces an unedited one, so run `format` once afterwards                                                    |
| clutch 1.0: `createStore`, `useStore`    | See below                                                                                                              |
| Sentry 11 and `dataCollection`           | See below                                                                                                              |
| `vue-tsc` and `svelte-check` type checks | `upgrade` adds the dev dependencies. Change each app's `type-check` script yourself                                    |
| Strict ESLint                            | An existing `eslint.config.js` is yours and is not regenerated. A fresh `spool create --addons lint` shows the new one |
| Svelte templates use runes               | New scaffolds only. `src/federation/Remote.svelte` is regenerated. Your components are not rewritten                   |

### Shared state

The state addon's `src/state/counter.ts` now uses clutch 1.0's `createStore` and `sharedStore`, and React reads it with `useStore` from `@zerosumstudio/clutch/react`. `spool upgrade` does not touch it. Port your own stores with the [clutch migration guide](https://github.com/zerosumstudio/clutch/blob/main/docs/migration-1.0.md), which has a search-and-replace checklist, or delete an unedited `src/state/counter.ts` and run `spool addon state` to write the new one. Then change what imports `counterMachine` to `counterStore`.

Apps on `@zerosumstudio/clutch` 1.0 do not share `sharedStore` entries with a 3.5 bundle, so move every app on the page together.

### Sentry

`spool upgrade` moves the `@sentry/*` packages to 11 and leaves `src/sentry.ts` alone. The 4.0 file sampled traces at 10% and sent default integrations and unscrubbed urls. The new one sets `dataCollection` so user info, cookies, headers and bodies stay out, drops the `Console` integration, scrubs urls in events and breadcrumbs, and has tracing off. To take it, delete `src/sentry.ts` and run `spool addon sentry`, which writes the new `src/sentry.ts` and `src/sentry-scrub.ts` and leaves existing files alone. Reapply any edits you had. If you keep tracing on, wire `scrubEvent` into `beforeSendTransaction` yourself. Nothing scrubs transactions for you.

### Type checks and lint

The `type-check` script of a Vue app should be `vue-tsc --noEmit`, and of a Svelte app `svelte-check --tsconfig ./tsconfig.json`, since plain `tsc` cannot read `.vue` or `.svelte` files.

## Deploy workflows

Workflows are not regenerated by `spool upgrade`. Run `spool ci --force` to replace them. The new ones differ:

- Every action is pinned to a commit sha. `spool ci --pin` is gone.
- A deploy job passes no secrets unless the app lists them. Add the names the deploy command reads to `deployEnv`, then rerun `spool ci --force`. 4.0 workflows passed fixed Cloudflare secrets, so a deploy that relied on them fails until they are listed.
- Deploy jobs run only on `main`, in the `production` GitHub environment, and never cancel a running deploy.

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

A GitHub environment accepts every branch until you restrict it. In Settings > Environments, set Deployment branches to `main` and add required reviewers. Without that, anyone with write access can run the workflow from their own branch and read the deploy secrets.

## Behaviour changes

- Every app's CSP now includes `object-src 'none'` and `base-uri 'self'`, which blocks a plugin or a `<base>` tag that relied on neither. `csp: "strict"` stays opt-in.
- Svelte is never shared through federation, so a page with two Svelte apps carries two runtimes. Share state through clutch.
- `spool build` defaults to half the cores, at most 4 apps at once.
- Dependency ranges move forward only. A range already ahead of spool's is kept, and `spool upgrade --downgrade` overwrites it.
