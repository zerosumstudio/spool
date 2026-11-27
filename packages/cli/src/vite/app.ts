/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
	getApp,
	type AppConfig,
	type Manifest,
	type ServerConfig,
	type ShareStrategy,
} from '../core/config.js'
import { CliError } from '../util/errors.js'
import { isPublicHttpUrl, packageName, remoteEnvVar } from '../util/names.js'
import { serverHeaders } from './headers.js'
import { loadManifest } from './manifest.js'
import { spoolPlugin, type SpoolCommand, type SpoolPlugin } from './plugin.js'
import { watchParent } from './watchdog.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface SpoolAppOptions {
	/** The app's folder: `import.meta.dirname` in its vite config. */
	root: string
	/** Vite's `command`. Only builds read deployed remote urls. */
	command?: SpoolCommand
}

type ViteServer = Omit<ServerConfig, 'cors'> & {
	port: number
	strictPort: boolean
	cors: { origin: string[] }
	headers: Record<string, string>
}

export interface SpoolApp {
	/** Use for both `server` and `preview`. */
	server: ViteServer
	/** Options for `federation()` from @module-federation/vite. */
	federation: {
		name: string
		filename?: string
		manifest: true
		remotes?: Record<string, string>
		exposes?: Record<string, string>
		shared: Record<string, { singleton: true }>
		shareStrategy: ShareStrategy
		dts: false
	}
	/** Writes `_headers` into the build and defines the override origins. */
	plugin: SpoolPlugin
}

/*
 *   REMOTES
 ***************************************************************************************************/
/**
 * Remote lookup order: the SPOOL_REMOTE_<NAME> env var, then the remote's url for the
 * current SPOOL_ENV, then its plain url, then the local dev server. Only builds read the
 * deployed urls, so dev always stays on localhost.
 */
function resolveRemoteUrl(name: string, app: AppConfig, command: SpoolCommand): string {
	const environment = process.env.SPOOL_ENV
	const deployed =
		command === 'build'
			? ((environment === undefined ? undefined : app.urls?.[environment]) ?? app.url)
			: undefined

	const override = process.env[remoteEnvVar(name)]

	if (override !== undefined && !isPublicHttpUrl(override)) {
		throw new CliError(
			`${remoteEnvVar(name)} must be an http or https URL without a username or password.`,
			'INVALID_VALUE',
		)
	}

	return override ?? deployed ?? `http://localhost:${app.port}/mf-manifest.json`
}

/*
 *   SHARED DEPS
 ***************************************************************************************************/
/**
 * A shared dep the app has not declared in its own package.json is dropped, so apps on
 * different frameworks never share something they do not install.
 */
function filterDeclaredShared(dir: string, deps: string[]): string[] {
	if (!deps.length) return deps

	let declared: Set<string>
	try {
		const packageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
			dependencies?: Record<string, string>
			devDependencies?: Record<string, string>
		}
		declared = new Set([
			...Object.keys(packageJson.dependencies ?? {}),
			...Object.keys(packageJson.devDependencies ?? {}),
		])
	} catch {
		// Better to share nothing than to share a dep the app never installed.
		console.warn(
			`[spool] could not read ${join(dir, 'package.json')}; sharing no deps for this app. Run spool doctor.`,
		)
		return []
	}

	return deps.filter(dep => declared.has(packageName(dep)))
}

/** Svelte is never shared, whatever spool.json lists: see docs/adr/0008. */
export function withoutSvelte(deps: string[]): string[] {
	return deps.filter(dep => dep !== 'svelte' && !dep.startsWith('svelte/'))
}

/*
 *   SERVER
 ***************************************************************************************************/
/** Only these prefixes expand, so a spool.json edit cannot send an unrelated secret anywhere. */
const EXPANDABLE_ENV = /^(?:SPOOL_|VITE_)/
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/**
 * Expands ${VAR} and ${VAR:-fallback} through the manifest server block, so a proxy target
 * can differ per machine without anyone editing a vite config.
 */
function expandEnv<T>(value: T): T {
	if (typeof value === 'string') {
		return value.replace(ENV_REF, (_, name: string, fallback?: string) =>
			EXPANDABLE_ENV.test(name) ? (process.env[name] ?? fallback ?? '') : (fallback ?? ''),
		) as T
	}
	if (Array.isArray(value)) return value.map(expandEnv) as T
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, expandEnv(inner)]),
		) as T
	}

	return value
}

/** Mirrors vite's searchForWorkspaceRoot, which this file cannot import: vite lives in each app. */
function findViteWorkspaceRoot(from: string): string {
	const isWorkspace = (dir: string): boolean => {
		if (existsSync(join(dir, 'pnpm-workspace.yaml')) || existsSync(join(dir, 'lerna.json'))) {
			return true
		}
		try {
			const packageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
				workspaces?: unknown
			}

			return Boolean(packageJson.workspaces)
		} catch {
			return false
		}
	}
	let packageRoot: string | undefined
	let dir = resolve(from)

	for (;;) {
		if (isWorkspace(dir)) return dir
		if (packageRoot === undefined && existsSync(join(dir, 'package.json'))) packageRoot = dir

		const parent = dirname(dir)
		if (parent === dir) return packageRoot ?? resolve(from)
		dir = parent
	}
}

/**
 * Setting server.fs.allow drops vite's default of the workspace root, so it is put back
 * first. Entries resolve against the spool.json folder.
 */
function buildFsAllow(entries: string[], workspaceRoot: string, appDir: string): string[] {
	const dirs = entries.map(entry => {
		const dir = resolve(workspaceRoot, entry)

		if (entry.trim() === '' || dirname(dir) === dir) {
			throw new CliError(
				`server.fs.allow entry "${entry}" resolves to "${dir}". Use a folder below the filesystem root.`,
				'INVALID_PATH',
			)
		}

		return dir
	})

	return [...new Set([findViteWorkspaceRoot(appDir), ...dirs])]
}

function buildServer(manifest: Manifest, app: AppConfig, root: string, appDir: string): ViteServer {
	// An allowlist, never `true`: every app is served on its own localhost port, and a
	// wildcard origin cannot carry credentials.
	const origins =
		manifest.server?.cors ??
		Object.values(manifest.apps).map(entry => `http://localhost:${entry.port}`)
	const { headers: _headers, fs, cors: _cors, ...rest } = expandEnv(manifest.server ?? {})

	return {
		...rest,
		port: app.port,
		strictPort: true,
		cors: { origin: origins },
		...(fs ? { fs: { allow: buildFsAllow(fs.allow, root, appDir) } } : {}),
		headers: serverHeaders(manifest, app),
	}
}

/*
 *   SPOOL APP
 ***************************************************************************************************/
/**
 * Everything an app's vite config needs from spool.json: the dev and preview server, the
 * federation options, and the plugin that writes `_headers`. spool.json is validated with the
 * CLI's own parser, so a typo fails here with the same message `spool doctor` gives.
 */
export function spoolApp(name: string, options: SpoolAppOptions): SpoolApp {
	try {
		return createSpoolApp(name, options)
	} catch (error) {
		throw addPrefix(error)
	}
}

/** One `[spool]` prefix on everything the vite entry throws, like the warnings it logs. */
function addPrefix(error: unknown): unknown {
	if (!(error instanceof CliError) || error.message.startsWith('[spool]')) return error

	return new CliError(`[spool] ${error.message}`, error.code, error.data)
}

function createSpoolApp(name: string, options: SpoolAppOptions): SpoolApp {
	const { root: appDir, command = 'build' } = options

	watchParent()

	const { manifest, root } = loadManifest(appDir)
	const app = getApp(manifest, name)

	const federation: SpoolApp['federation'] = {
		name,
		// Remotes are typed through src/remotes.d.ts, so the DTS archive is redundant and
		// flaky to download. Every app writes a manifest because spool build compares them.
		manifest: true,
		// Every share is a singleton: two copies of react break hooks, and workspace
		// packages carry module state that has to resolve to one copy.
		shared: Object.fromEntries(
			withoutSvelte(filterDeclaredShared(appDir, manifest.shared)).map(dep => [
				dep,
				{ singleton: true as const },
			]),
		),
		// loaded-first keeps share scope off the remotes, so one remote you cannot reach
		// does not hold the page blank while it retries.
		shareStrategy: manifest.shareStrategy,
		dts: false,
	}

	if (app.remotes.length) {
		federation.remotes = Object.fromEntries(
			app.remotes.map(remote => [
				remote,
				resolveRemoteUrl(remote, getApp(manifest, remote), command),
			]),
		)
	}

	if (app.type === 'remote') {
		federation.filename = 'remoteEntry.js'
		federation.exposes = app.exposes
	}

	return {
		server: buildServer(manifest, app, root, appDir),
		federation,
		plugin: spoolPlugin(name, manifest, app, command, { root: appDir }),
	}
}
