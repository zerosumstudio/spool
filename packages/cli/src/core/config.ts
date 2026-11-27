/*
 *   IMPORTS
 ***************************************************************************************************/
import { CliError } from '../util/errors.js'
import {
	HEADER_NAME_PATTERN,
	EXPOSE_KEY_PATTERN,
	ENV_NAME,
	isHttpUrl,
	isPublicHttpUrl,
	isOrigin,
	isSafeCspSource,
	isSafeHeaderValue,
	validateAppPath,
	validateExposeSource,
	validateName,
} from '../util/names.js'

/*
 *   CONSTANTS
 ***************************************************************************************************/
/** Manifest file name that marks a spool workspace root. */
export const MANIFEST_FILE = 'spool.json'

/** Runtime helper at the workspace root; every app's vite config imports it. */
export const HELPER_FILE = 'spool.vite.ts'

/** Reads the manifest for user code: tests, scripts, anything wanting the app list. */
export const WORKSPACE_FILE = 'spool.workspace.ts'

/** Manifest schema version this CLI reads and writes. */
export const MANIFEST_VERSION = 2

export const FRAMEWORKS = ['react', 'svelte', 'vue'] as const
export type Framework = (typeof FRAMEWORKS)[number]

/** Framework scaffolded when nothing picks one explicitly. */
export const DEFAULT_FRAMEWORK: Framework = 'react'

export const APP_TYPES = ['host', 'remote'] as const
export type AppType = (typeof APP_TYPES)[number]

export const PACKAGE_MANAGERS = ['pnpm', 'npm', 'yarn'] as const
export type PackageManager = (typeof PACKAGE_MANAGERS)[number]

export const SHARE_STRATEGIES = ['version-first', 'loaded-first'] as const
export type ShareStrategy = (typeof SHARE_STRATEGIES)[number]

export const CSP_MODES = ['default', 'strict'] as const
export type CspMode = (typeof CSP_MODES)[number]

export const ADDON_NAME_VALUES = [
	'ladle',
	'playwright',
	'lint',
	'test',
	'turbo',
	'state',
	'sentry',
	'navigation',
] as const
export type AddonName = (typeof ADDON_NAME_VALUES)[number]

/** Was an addon in earlier versions; every host has it now, so it is accepted and ignored. */
const RETIRED_ADDON = 'federation'

/*
 *   TYPES
 ***************************************************************************************************/
export interface AppConfig {
	/** "host" mounts remotes; "remote" exposes modules. */
	type: AppType
	/** UI framework the app is scaffolded and regenerated for. */
	framework: Framework
	/** Path to the app, relative to workspace root. */
	path: string
	/** Dev server port. */
	port: number
	/** Deployed manifest URL of a remote, used by host production builds. */
	url?: string
	/** Per-environment manifest URLs; `--env <name>` on build selects one. */
	urls?: Record<string, string>
	/** Shell command `spool deploy` runs in the app folder. */
	deploy?: string
	/** Names of the environment variables and secrets the deploy workflow passes to `deploy`. */
	deployEnv?: string[]
	/** Remotes this app mounts. A remote can consume remotes too. */
	remotes: string[]
	/** Modules a remote exposes: exposeKey -> source path. */
	exposes: Record<string, string>
	/** Extra response headers this app's dev server and its `_headers` file send. */
	headers?: Record<string, string>
	/** Origins allowed to iframe this app; becomes a frame-ancestors CSP directive. `edge` alone leaves the header to an edge layer. */
	frameAncestors?: string[]
}

export interface ProxyEntry {
	target: string
	changeOrigin?: boolean
	secure?: boolean
	ws?: boolean
}

export interface ServerConfig {
	proxy?: Record<string, string | ProxyEntry>
	headers?: Record<string, string>
	host?: boolean | string
	/** Origins the dev server allows. Omitted means every app's own localhost origin. */
	cors?: string[]
	fs?: {
		/** Extra directories the dev server may serve, relative to the workspace root. */
		allow: string[]
	}
}

export interface OverridesConfig {
	/** Origins a runtime override may load a remote from. */
	origins: string[]
}

export interface Manifest {
	/** Workspace name; used for npm scope and federation naming. */
	name: string
	version: typeof MANIFEST_VERSION
	packageManager: PackageManager
	bundler: 'vite'
	/** Deps shared as singletons across the federation boundary. */
	shared: string[]
	shareStrategy: ShareStrategy
	/** "strict" adds `script-src` and `connect-src` to the `_headers` CSP. */
	csp: CspMode
	server?: ServerConfig
	/** Enabled addons whose wiring isn't captured elsewhere in the manifest. */
	addons: AddonName[]
	/** App registry keyed by app name. */
	apps: Record<string, AppConfig>
	/** Present when hosts may swap a remote's url at runtime, and only to these origins. */
	overrides?: OverridesConfig
}

/*
 *   READER
 ***************************************************************************************************/
type Path = readonly (string | number)[]

interface Issue {
	path: string
	message: string
}

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Collects problems with `spool.json` so one parse reports all of them. */
class Reader {
	readonly issues: Issue[] = []

	add(path: Path, message: string): void {
		this.issues.push({ path: path.join('.') || '(root)', message })
	}

	/** Strict: a key nobody reads is almost always a typo. */
	object(value: unknown, path: Path, allowed: readonly string[]): UnknownRecord | undefined {
		if (!isRecord(value)) {
			this.add(path, 'must be an object')
			return undefined
		}

		for (const key of Object.keys(value)) {
			if (!allowed.includes(key)) this.add([...path, key], 'is not a known setting')
		}

		return value
	}

	string(value: unknown, path: Path): string | undefined {
		if (typeof value === 'string') return value

		this.add(path, 'must be a string')
		return undefined
	}

	boolean(value: unknown, path: Path): boolean | undefined {
		if (typeof value === 'boolean') return value

		this.add(path, 'must be true or false')
		return undefined
	}

	choice<T extends string>(
		value: unknown,
		path: Path,
		options: readonly T[],
		fallback?: T,
	): T | undefined {
		if (value === undefined && fallback !== undefined) return fallback

		const match = options.find(option => option === value)
		if (match !== undefined) return match

		this.add(path, `must be one of ${options.map(option => `"${option}"`).join(', ')}`)
		return undefined
	}

	list<T>(
		value: unknown,
		path: Path,
		readItem: (item: unknown, path: Path) => T | undefined,
		fallback?: T[],
	): T[] | undefined {
		if (value === undefined && fallback !== undefined) return fallback
		if (!Array.isArray(value)) {
			this.add(path, 'must be an array')
			return undefined
		}

		const items: T[] = []
		value.forEach((item, index) => {
			const parsed = readItem(item, [...path, index])
			if (parsed !== undefined) items.push(parsed)
		})
		return items
	}

	record<T>(
		value: unknown,
		path: Path,
		readValue: (item: unknown, path: Path) => T | undefined,
		checkKey?: (key: string) => string | undefined,
	): Record<string, T> | undefined {
		if (!isRecord(value)) {
			this.add(path, 'must be an object')
			return undefined
		}

		// No prototype, so a "__proto__" key in the file is only a key.
		const out = Object.create(null) as Record<string, T>
		for (const [key, item] of Object.entries(value)) {
			const keyError = checkKey?.(key)
			if (keyError) this.add([...path, key], keyError)

			const parsed = readValue(item, [...path, key])
			if (parsed !== undefined) out[key] = parsed
		}
		return out
	}

	/** A setting that may be left out: reads it when it is there and hands the result on. */
	optional<T>(
		raw: UnknownRecord,
		key: string,
		path: Path,
		read: (value: unknown, path: Path) => T | undefined,
		assign: (parsed: T) => void,
	): void {
		if (raw[key] === undefined) return

		const parsed = read(raw[key], [...path, key])

		if (parsed !== undefined) assign(parsed)
	}

	/** An http(s) URL, without credentials: it is compiled into the public bundle. */
	url(value: unknown, path: Path): string | undefined {
		const text = this.string(value, path)
		if (text === undefined) return undefined
		if (isPublicHttpUrl(text)) return text

		this.add(
			path,
			isHttpUrl(text)
				? 'must not contain a username or password'
				: 'must be an http or https URL',
		)
		return undefined
	}

	origin(value: unknown, path: Path): string | undefined {
		const text = this.string(value, path)
		if (text === undefined) return undefined
		if (isOrigin(text)) return text

		this.add(
			path,
			'must be an origin like "https://app.example.com": no path, query or trailing slash',
		)
		return undefined
	}

	headers(value: unknown, path: Path): Record<string, string> | undefined {
		return this.record(
			value,
			path,
			(item, itemPath) => {
				const text = this.string(item, itemPath)
				if (text === undefined) return undefined
				if (isSafeHeaderValue(text)) return text

				this.add(itemPath, 'must not contain line breaks or control characters')
				return undefined
			},
			key => (HEADER_NAME_PATTERN.test(key) ? undefined : 'is not a valid header name'),
		)
	}
}

/*
 *   PARSER
 ***************************************************************************************************/
export const MANIFEST_KEYS = [
	'name',
	'version',
	'packageManager',
	'bundler',
	'shared',
	'shareStrategy',
	'csp',
	'server',
	'addons',
	'apps',
	'overrides',
] as const

export const APP_KEYS = [
	'type',
	'framework',
	'path',
	'port',
	'url',
	'urls',
	'deploy',
	'deployEnv',
	'remotes',
	'exposes',
	'headers',
	'frameAncestors',
] as const

/** What a manifest means when it leaves a setting out. `saveManifest` leaves these out again. */
export const MANIFEST_DEFAULTS = {
	packageManager: 'pnpm',
	bundler: 'vite',
	shared: ['react', 'react-dom'],
	shareStrategy: 'loaded-first',
	csp: 'default',
	addons: [],
} as const

export const APP_DEFAULTS = {
	framework: DEFAULT_FRAMEWORK,
	remotes: [],
	exposes: {},
} as const

const SERVER_KEYS = ['proxy', 'headers', 'host', 'cors', 'fs'] as const
const PROXY_KEYS = ['target', 'changeOrigin', 'secure', 'ws'] as const
const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/
const FILESYSTEM_ROOT = /^(?:[\\/]+|[a-zA-Z]:[\\/]*)$/

function readProxy(reader: Reader, value: unknown, path: Path): string | ProxyEntry | undefined {
	if (typeof value === 'string') return value

	const raw = reader.object(value, path, PROXY_KEYS)
	if (!raw) return undefined

	const target = reader.string(raw.target, [...path, 'target'])
	if (target === undefined) return undefined

	const entry: ProxyEntry = { target }
	for (const key of ['changeOrigin', 'secure', 'ws'] as const) {
		if (raw[key] === undefined) continue

		const flag = reader.boolean(raw[key], [...path, key])
		if (flag !== undefined) entry[key] = flag
	}
	return entry
}

function readFsAllow(reader: Reader, value: unknown, path: Path): string | undefined {
	const entry = reader.string(value, path)
	if (entry === undefined) return undefined

	if (entry.trim() === '') {
		reader.add(path, 'cannot be empty')
		return undefined
	}
	if (FILESYSTEM_ROOT.test(entry.trim())) {
		reader.add(
			path,
			'cannot be the filesystem root; that would let the dev server read any file on disk',
		)
		return undefined
	}
	return entry
}

function readHost(reader: Reader, value: unknown, path: Path): boolean | string | undefined {
	if (typeof value === 'boolean' || typeof value === 'string') return value

	reader.add(path, 'must be true, false or a host name')
	return undefined
}

function readCors(reader: Reader, value: unknown, path: Path): string[] | undefined {
	if (typeof value === 'boolean') {
		reader.add(
			path,
			'must be a list of origins. A boolean was the version 1 form; run `spool upgrade`',
		)
		return undefined
	}

	return reader.list(value, path, (item, itemPath) => reader.origin(item, itemPath))
}

function readFs(reader: Reader, value: unknown, path: Path): { allow: string[] } | undefined {
	const fs = reader.object(value, path, ['allow'])
	if (!fs) return undefined

	const allow = reader.list(fs.allow, [...path, 'allow'], (item, itemPath) =>
		readFsAllow(reader, item, itemPath),
	)

	return allow ? { allow } : undefined
}

function readServer(reader: Reader, value: unknown, path: Path): ServerConfig | undefined {
	const raw = reader.object(value, path, SERVER_KEYS)
	if (!raw) return undefined

	const server: ServerConfig = {}

	reader.optional(
		raw,
		'proxy',
		path,
		(item, itemPath) =>
			reader.record(item, itemPath, (entry, entryPath) =>
				readProxy(reader, entry, entryPath),
			),
		proxy => (server.proxy = proxy),
	)
	reader.optional(
		raw,
		'headers',
		path,
		(item, itemPath) => reader.headers(item, itemPath),
		headers => (server.headers = headers),
	)
	reader.optional(
		raw,
		'host',
		path,
		(item, itemPath) => readHost(reader, item, itemPath),
		host => (server.host = host),
	)
	reader.optional(
		raw,
		'cors',
		path,
		(item, itemPath) => readCors(reader, item, itemPath),
		cors => (server.cors = cors),
	)
	reader.optional(
		raw,
		'fs',
		path,
		(item, itemPath) => readFs(reader, item, itemPath),
		fs => (server.fs = fs),
	)

	return server
}

function readExposes(
	reader: Reader,
	value: unknown,
	path: Path,
): Record<string, string> | undefined {
	return reader.record(
		value,
		path,
		(item, itemPath) => {
			const source = reader.string(item, itemPath)
			if (source === undefined) return undefined

			const error = validateExposeSource(source)
			if (error === undefined) return source

			reader.add(itemPath, error)
			return undefined
		},
		key =>
			EXPOSE_KEY_PATTERN.test(key)
				? undefined
				: 'must start with "./" and use letters, digits, ".", "_" and "-" in "/" separated parts',
	)
}

function readFrameAncestor(reader: Reader, value: unknown, path: Path): string | undefined {
	const source = reader.string(value, path)
	if (source === undefined) return undefined
	if (isSafeCspSource(source)) return source

	reader.add(path, 'must be one source with no spaces, ";" or ","')
	return undefined
}

function readDeployEnvName(reader: Reader, value: unknown, path: Path): string | undefined {
	const name = reader.string(value, path)
	if (name === undefined) return undefined
	if (SECRET_NAME.test(name)) return name

	reader.add(path, 'must be an upper case variable name like "CLOUDFLARE_API_TOKEN"')
	return undefined
}

function readDeployEnv(reader: Reader, value: unknown, path: Path): string[] | undefined {
	const names = reader.list(value, path, (item, itemPath) =>
		readDeployEnvName(reader, item, itemPath),
	)

	if (names && new Set(names).size !== names.length) {
		reader.add(path, 'lists a name more than once')
	}

	return names
}

function readFrameAncestors(reader: Reader, value: unknown, path: Path): string[] | undefined {
	const ancestors = reader.list(value, path, (item, itemPath) =>
		readFrameAncestor(reader, item, itemPath),
	)

	if (ancestors?.includes('edge') && ancestors.length > 1) {
		reader.add(path, '"edge" stands alone; the edge sets the header, so list nothing else')
	}

	return ancestors
}

function readAppPath(reader: Reader, value: unknown, path: Path): string | undefined {
	const appPath = reader.string(value, path)
	if (appPath === undefined) return undefined

	const error = validateAppPath(appPath)
	if (error) reader.add(path, error)

	return appPath
}

/** The settings an app may leave out. */
function readAppOptions(reader: Reader, raw: UnknownRecord, path: Path, app: AppConfig): void {
	reader.optional(
		raw,
		'url',
		path,
		(item, itemPath) => reader.url(item, itemPath),
		url => (app.url = url),
	)
	reader.optional(
		raw,
		'urls',
		path,
		(item, itemPath) =>
			reader.record(
				item,
				itemPath,
				(entry, entryPath) => reader.url(entry, entryPath),
				key => (ENV_NAME.test(key) ? undefined : 'is not a valid environment name'),
			),
		urls => (app.urls = urls),
	)
	reader.optional(
		raw,
		'deploy',
		path,
		(item, itemPath) => reader.string(item, itemPath),
		deploy => (app.deploy = deploy),
	)
	reader.optional(
		raw,
		'deployEnv',
		path,
		(item, itemPath) => readDeployEnv(reader, item, itemPath),
		names => (app.deployEnv = names),
	)
	reader.optional(
		raw,
		'headers',
		path,
		(item, itemPath) => reader.headers(item, itemPath),
		headers => (app.headers = headers),
	)
	reader.optional(
		raw,
		'frameAncestors',
		path,
		(item, itemPath) => readFrameAncestors(reader, item, itemPath),
		ancestors => (app.frameAncestors = ancestors),
	)
}

function readApp(reader: Reader, value: unknown, path: Path): AppConfig | undefined {
	const raw = reader.object(value, path, APP_KEYS)
	if (!raw) return undefined

	const type = reader.choice(raw.type, [...path, 'type'], APP_TYPES)
	const framework = reader.choice(
		raw.framework,
		[...path, 'framework'],
		FRAMEWORKS,
		APP_DEFAULTS.framework,
	)
	const appPath = readAppPath(reader, raw.path, [...path, 'path'])
	const port = readPort(reader, raw.port, [...path, 'port'])
	const remotes = reader.list(
		raw.remotes,
		[...path, 'remotes'],
		(item, itemPath) => reader.string(item, itemPath),
		[],
	)
	const exposes =
		raw.exposes === undefined ? {} : readExposes(reader, raw.exposes, [...path, 'exposes'])

	const app = assembleApp({ type, framework, path: appPath, port, remotes, exposes })
	if (app) readAppOptions(reader, raw, path, app)

	return app
}

/** The app, once every required setting read cleanly. */
function assembleApp(parts: {
	[K in 'type' | 'framework' | 'path' | 'port' | 'remotes' | 'exposes']: AppConfig[K] | undefined
}): AppConfig | undefined {
	const { type, framework, path, port, remotes, exposes } = parts

	if (!type || !framework || path === undefined || port === undefined || !remotes || !exposes) {
		return undefined
	}

	return { type, framework, path, port, remotes, exposes }
}

function readPort(reader: Reader, value: unknown, path: Path): number | undefined {
	if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) {
		return value
	}

	reader.add(path, 'must be a whole number from 1 to 65535')
	return undefined
}

function readName(reader: Reader, value: unknown, path: Path, label: string, shared: string[]) {
	const name = reader.string(value, path)
	if (name === undefined) return undefined

	const error = validateName(name, label, { shared })
	if (error === undefined) return name

	reader.add(path, error)
	return undefined
}

function readSharedEntry(reader: Reader, item: unknown, path: Path): string | undefined {
	const dep = reader.string(item, path)
	if (dep === undefined) return undefined

	if (dep.trim() === '') {
		reader.add(path, 'cannot be empty')
		return undefined
	}

	return dep
}

/** The server and overrides blocks, present only when the file has them. */
function readManifestExtras(
	reader: Reader,
	raw: UnknownRecord,
): Partial<Pick<Manifest, 'server' | 'overrides'>> {
	const extras: Partial<Pick<Manifest, 'server' | 'overrides'>> = {}

	reader.optional(
		raw,
		'server',
		[],
		(item, path) => readServer(reader, item, path),
		server => (extras.server = server),
	)
	reader.optional(
		raw,
		'overrides',
		[],
		(item, path) => {
			const overrides = reader.object(item, path, ['origins'])
			const origins = overrides
				? reader.list(overrides.origins, [...path, 'origins'], (entry, entryPath) =>
						reader.origin(entry, entryPath),
					)
				: undefined

			return origins ? { origins } : undefined
		},
		overrides => (extras.overrides = overrides),
	)

	return extras
}

/** The manifest, once every required setting read cleanly. */
function assembleManifest(
	parts: {
		[
			K in
				| 'name'
				| 'shared'
				| 'packageManager'
				| 'bundler'
				| 'shareStrategy'
				| 'csp'
				| 'addons'
				| 'apps'
		]: Manifest[K] | undefined
	},
	extras: Partial<Pick<Manifest, 'server' | 'overrides'>>,
): Manifest | undefined {
	const { name, shared, packageManager, bundler, shareStrategy, csp, addons, apps } = parts

	if (
		!name ||
		!shared ||
		!packageManager ||
		!bundler ||
		!shareStrategy ||
		!csp ||
		!addons ||
		!apps
	) {
		return undefined
	}

	return {
		name,
		version: MANIFEST_VERSION,
		packageManager,
		bundler,
		shared,
		shareStrategy,
		csp,
		addons,
		apps,
		...extras,
	}
}

/** `raw` must already be version 2. Use `parseManifest` unless the version is known. */
function readManifest(raw: UnknownRecord, reader: Reader): Manifest | undefined {
	const shared = reader.list(
		raw.shared,
		['shared'],
		(item, path) => readSharedEntry(reader, item, path),
		[...MANIFEST_DEFAULTS.shared],
	)
	const sharedNames = shared ?? []

	const name = readName(reader, raw.name, ['name'], 'workspace name', sharedNames)
	const packageManager = reader.choice(
		raw.packageManager,
		['packageManager'],
		PACKAGE_MANAGERS,
		MANIFEST_DEFAULTS.packageManager,
	)
	const bundler = reader.choice(raw.bundler, ['bundler'], ['vite'], MANIFEST_DEFAULTS.bundler)
	const shareStrategy = reader.choice(
		raw.shareStrategy,
		['shareStrategy'],
		SHARE_STRATEGIES,
		MANIFEST_DEFAULTS.shareStrategy,
	)
	const csp = reader.choice(raw.csp, ['csp'], CSP_MODES, MANIFEST_DEFAULTS.csp)
	// Federation is always on, so a file that still lists it keeps working: the entry is ignored.
	const addons = reader.list(
		raw.addons,
		['addons'],
		(item, path) =>
			item === RETIRED_ADDON ? undefined : reader.choice(item, path, ADDON_NAME_VALUES),
		[],
	)
	const apps =
		raw.apps === undefined
			? {}
			: reader.record(
					raw.apps,
					['apps'],
					(item, path) => readApp(reader, item, path),
					key => validateName(key, 'app name', { shared: sharedNames }),
				)
	const extras = readManifestExtras(reader, raw)

	const parsed = assembleManifest(
		{ name, shared, packageManager, bundler, shareStrategy, csp, addons, apps },
		extras,
	)
	if (!parsed) return undefined

	validateRemotes(parsed, reader)
	return parsed
}

/*
 *   CROSS-FIELD VALIDATION
 ***************************************************************************************************/
function validateRemotes(manifest: Manifest, reader: Reader): void {
	for (const [name, app] of Object.entries(manifest.apps)) {
		const seen = new Set<string>()

		app.remotes.forEach((remote, index) => {
			const path = ['apps', name, 'remotes', index]

			if (remote === name) {
				reader.add(path, `App "${name}" lists itself as a remote.`)
				return
			}
			if (seen.has(remote)) {
				reader.add(path, `App "${name}" lists remote "${remote}" more than once.`)
				return
			}
			seen.add(remote)

			if (!(remote in manifest.apps)) {
				reader.add(
					path,
					`App "${name}" lists remote "${remote}", which is not in this workspace.`,
				)
			}
		})
	}

	const cycle = findRemoteCycle(manifest)
	if (cycle) reader.add(['apps'], `Remotes form a cycle: ${cycle.join(' -> ')}.`)
}

/** Depth-first search for a cycle in the remotes graph; returns the first one found. */
function findRemoteCycle(manifest: Manifest): string[] | undefined {
	const state = new Map<string, 'visiting' | 'done'>()
	const stack: string[] = []

	function visit(name: string): string[] | undefined {
		const app = manifest.apps[name]
		if (!app) return undefined

		state.set(name, 'visiting')
		stack.push(name)

		for (const remote of app.remotes) {
			if (!(remote in manifest.apps)) continue

			if (state.get(remote) === 'visiting') {
				const start = stack.indexOf(remote)
				return [...stack.slice(start), remote]
			}
			if (state.get(remote) !== 'done') {
				const found = visit(remote)
				if (found) return found
			}
		}

		stack.pop()
		state.set(name, 'done')
		return undefined
	}

	for (const name of Object.keys(manifest.apps)) {
		if (state.get(name) === 'done') continue

		const found = visit(name)
		if (found) return found
	}
	return undefined
}

/*
 *   FACTORIES
 ***************************************************************************************************/
/** Reads the schema version of a parsed `spool.json`. A missing version means 1. */
export function manifestVersionOf(raw: unknown): unknown {
	return isRecord(raw) ? (raw.version ?? 1) : undefined
}

/** Validates a parsed `spool.json`. Throws `MANIFEST_VERSION` for version 1 and `MANIFEST_INVALID` for a bad file. */
export function parseManifest(raw: unknown): Manifest {
	if (!isRecord(raw)) {
		throw new CliError(
			`Invalid ${MANIFEST_FILE}: it must contain a JSON object.`,
			'MANIFEST_INVALID',
		)
	}

	const version = manifestVersionOf(raw)
	if (version === 1) {
		throw new CliError(
			`This workspace uses ${MANIFEST_FILE} version 1, but this CLI reads version ${MANIFEST_VERSION}. Run \`spool upgrade\` to migrate it.`,
			'MANIFEST_VERSION',
		)
	}
	if (version !== MANIFEST_VERSION) {
		throw new CliError(
			`This workspace uses ${MANIFEST_FILE} version ${String(version)}, but this CLI only understands version ${MANIFEST_VERSION}. Upgrade spool and try again.`,
			'MANIFEST_VERSION',
		)
	}

	const reader = new Reader()
	for (const key of Object.keys(raw)) {
		if (!(MANIFEST_KEYS as readonly string[]).includes(key)) {
			reader.add([key], 'is not a known setting')
		}
	}

	const manifest = readManifest(raw, reader)
	if (!manifest || reader.issues.length) {
		const details = reader.issues.map(issue => `  - ${issue.path}: ${issue.message}`).join('\n')
		throw new CliError(`Invalid ${MANIFEST_FILE}:\n${details}`, 'MANIFEST_INVALID')
	}
	return manifest
}

export function emptyManifest(name: string): Manifest {
	return parseManifest({ name, version: MANIFEST_VERSION, apps: {} })
}

/** The app called `name`, or an APP_NOT_FOUND error that says where to look. */
export function getApp(manifest: Manifest, name: string): AppConfig {
	const app = manifest.apps[name]

	if (!app) {
		throw new CliError(
			`No app named "${name}" in this workspace. Check the names in spool.json.`,
			'APP_NOT_FOUND',
		)
	}

	return app
}

/*
 *   FRAMEWORKS
 ***************************************************************************************************/
export function isFramework(value: string): value is Framework {
	return (FRAMEWORKS as readonly string[]).includes(value)
}

/** Returns an error message if `value` is not a known framework, else undefined. */
export function validateFramework(value: string): string | undefined {
	if (isFramework(value)) return undefined
	return `Unknown framework "${value}". Use ${FRAMEWORKS.join(' or ')}.`
}

/** Parses a framework name, aborting with a friendly message for unknown values. */
export function parseFramework(value: string): Framework {
	if (isFramework(value)) return value
	throw new CliError(validateFramework(value) ?? `Unknown framework "${value}".`, 'INVALID_VALUE')
}

/*
 *   VERSION 1 MIGRATION
 ***************************************************************************************************/
export interface Migration {
	/** The migrated manifest, ready to be written as `spool.json` and parsed. */
	manifest: UnknownRecord
	/** What changed, one line each, for `spool upgrade` to print. */
	changes: string[]
}

function localhostOrigins(apps: unknown): string[] {
	if (!isRecord(apps)) return []

	return Object.values(apps).flatMap(app =>
		isRecord(app) && typeof app.port === 'number' ? [`http://localhost:${app.port}`] : [],
	)
}

function migrateAddons(out: UnknownRecord, changes: string[]): void {
	if (!Array.isArray(out.addons)) return

	let addons = out.addons as unknown[]
	if (addons.includes('shell')) {
		addons = addons.filter(name => name !== 'shell')
		if (!addons.includes('navigation')) addons.push('navigation')
		changes.push('replaced addon "shell" with "navigation"; federation is always on')
	}
	if (addons.includes(RETIRED_ADDON)) {
		addons = addons.filter(name => name !== RETIRED_ADDON)
		changes.push('dropped addon "federation": every host has it now')
	}

	out.addons = addons
}

function migrateServer(out: UnknownRecord, changes: string[]): void {
	if (!isRecord(out.server) || typeof out.server.cors !== 'boolean') return

	const server = { ...out.server }
	if (server.cors) {
		server.cors = localhostOrigins(out.apps)
		changes.push(
			'server.cors true -> the origin of every app. Version 1 allowed any origin; add the ones you need',
		)
	} else {
		delete server.cors
		changes.push('removed server.cors false, which is the default')
	}

	out.server = server
}

/**
 * Svelte is never shared: a Svelte remote mounts through its own `mountApp`. Removes `svelte`
 * and its subpaths from a raw manifest's `shared`, and returns a note when it did.
 */
export function dropSharedSvelte(raw: UnknownRecord): string | undefined {
	if (!Array.isArray(raw.shared)) return undefined

	const isSvelte = (dep: unknown): boolean =>
		typeof dep === 'string' && (dep === 'svelte' || dep.startsWith('svelte/'))

	if (!raw.shared.some(isSvelte)) return undefined

	raw.shared = raw.shared.filter(dep => !isSvelte(dep))

	return 'removed svelte from shared: Svelte remotes mount through their own runtime, so it is never shared'
}

/**
 * Moves a version 1 `spool.json` to version 2. Pure: it returns a new object and
 * leaves `raw` alone. A manifest that is already version 2 comes back unchanged.
 */
export function migrateManifest(raw: unknown): Migration {
	if (!isRecord(raw)) {
		throw new CliError(
			`Invalid ${MANIFEST_FILE}: it must contain a JSON object.`,
			'MANIFEST_INVALID',
		)
	}

	const version = manifestVersionOf(raw)
	if (version === MANIFEST_VERSION) return { manifest: { ...raw }, changes: [] }
	if (version !== 1) {
		throw new CliError(
			`This workspace uses ${MANIFEST_FILE} version ${String(version)}, but this CLI only understands versions 1 and ${MANIFEST_VERSION}. Upgrade spool and try again.`,
			'MANIFEST_VERSION',
		)
	}

	const changes: string[] = [`${MANIFEST_FILE} version 1 -> ${MANIFEST_VERSION}`]
	const out: UnknownRecord = { ...raw, version: MANIFEST_VERSION }

	if (out.bundler === 'rspack') {
		delete out.bundler
		changes.push('removed unsupported bundler "rspack"')
	}

	migrateAddons(out, changes)
	migrateServer(out, changes)

	const droppedSvelte = dropSharedSvelte(out)
	if (droppedSvelte) changes.push(droppedSvelte)

	if (typeof out.overrides === 'boolean') {
		if (out.overrides) {
			out.overrides = { origins: [] }
			changes.push(
				'overrides true -> { "origins": [] }. List the origins a runtime override may load from, or overrides stay inert',
			)
		} else {
			delete out.overrides
			changes.push('removed overrides false, which is the default')
		}
	}

	return { manifest: out, changes }
}
