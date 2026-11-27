/*
 * Lets a developer swap one remote's entry from the browser console, without
 * touching the deployed manifest. An override is only taken from localStorage,
 * never from the url: a crafted link must not swap in someone else's remote.
 * It has to point at an origin listed in spool.json "overrides.origins", and it
 * expires after a day.
 */
import {
	getInstance,
	registerPlugins,
	type ModuleFederationRuntimePlugin,
} from '@module-federation/runtime'

/*
 *   TYPES
 ***************************************************************************************************/
export interface RemoteOverride {
	url: string
	/** Epoch milliseconds. */
	expiresAt: number
}

export interface OverrideOptions {
	/** How long the override lasts: at most 24 hours, which is also the default. */
	ttlMs?: number
}

// Set by the spool vite plugin from spool.json. Missing means no origin is allowed.
declare const __SPOOL_OVERRIDE_ORIGINS__: readonly string[] | undefined

/*
 *   CONSTANTS
 ***************************************************************************************************/
export const MAX_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000

const STORAGE_PREFIX = 'spool:remote:'
const ENTRY_FILES = ['mf-manifest.json', 'remoteEntry.js']
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']
const warned = new Set<string>()

/*
 *   VALIDATION
 ***************************************************************************************************/
function getAllowedOrigins(): readonly string[] {
	return typeof __SPOOL_OVERRIDE_ORIGINS__ === 'undefined' ? [] : __SPOOL_OVERRIDE_ORIGINS__
}

/** Why `value` cannot be an override, or undefined when it can. */
export function checkOverrideUrl(value: string): string | undefined {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		return 'not a valid url'
	}

	const isLocalDev = import.meta.env.DEV && LOCAL_HOSTS.includes(url.hostname)
	const isSecure = url.protocol === 'https:' || (url.protocol === 'http:' && isLocalDev)

	if (!isSecure) return 'must be https (http only to localhost in dev)'

	if (url.username || url.password) return 'must not carry credentials'

	if (!getAllowedOrigins().includes(url.origin)) {
		return `${url.origin} is not in spool.json "overrides.origins"`
	}

	if (/[?#]/.test(url.href)) return 'must not have a query string or fragment'

	const file = url.pathname.slice(url.pathname.lastIndexOf('/') + 1)

	if (!ENTRY_FILES.includes(file)) return `must end in ${ENTRY_FILES.join(' or ')}`

	return undefined
}

function getOrigin(value: string): string {
	try {
		return new URL(value).origin
	} catch {
		return ''
	}
}

function getEntry(remote: object): string {
	return 'entry' in remote && typeof remote.entry === 'string' ? remote.entry : ''
}

/** Why code from this manifest snapshot may not load for an overridden remote, or undefined. */
function checkSnapshot(snapshot: object, manifestUrl: string): string | undefined {
	const { publicPath, getPublicPath } = snapshot as {
		publicPath?: unknown
		getPublicPath?: unknown
	}

	if (getPublicPath !== undefined) return 'its manifest computes its public path at run time'

	if (typeof publicPath !== 'string' || publicPath === '' || publicPath === 'auto') {
		return undefined
	}

	let resolved: string
	try {
		resolved = new URL(publicPath, manifestUrl).origin
	} catch {
		return `its manifest has an unreadable publicPath ${publicPath}`
	}

	return getAllowedOrigins().includes(resolved)
		? undefined
		: `its manifest loads code from ${resolved}, which is not on a listed origin`
}

/*
 *   STORAGE
 ***************************************************************************************************/
function toStorageKey(name: string): string {
	return STORAGE_PREFIX + name
}

function parseOverride(raw: string | null): RemoteOverride | undefined {
	if (raw === null) return undefined

	try {
		const value: unknown = JSON.parse(raw)

		if (typeof value !== 'object' || value === null) return undefined

		const { url, expiresAt } = value as Partial<RemoteOverride>

		if (typeof url !== 'string' || typeof expiresAt !== 'number') return undefined

		return { url, expiresAt }
	} catch {
		return undefined
	}
}

/** The live override for `name`. One that expired, or no longer passes the checks, is removed. */
function readOverride(name: string): RemoteOverride | undefined {
	const key = toStorageKey(name)
	const raw = localStorage.getItem(key)

	if (raw === null) return undefined

	const override = parseOverride(raw)
	const now = Date.now()
	// An expiry further out than the longest lifetime was not written by setRemoteOverride.
	const isLive =
		override !== undefined &&
		override.expiresAt > now &&
		override.expiresAt <= now + MAX_OVERRIDE_TTL_MS &&
		!checkOverrideUrl(override.url)

	if (isLive) return { url: new URL(override.url).href, expiresAt: override.expiresAt }

	localStorage.removeItem(key)

	return undefined
}

/** Point `name` at `url` (its mf-manifest.json or remoteEntry.js), or clear the override with null.
 * Reload the page afterwards. */
export function setRemoteOverride(
	name: string,
	url: string | null,
	{ ttlMs = MAX_OVERRIDE_TTL_MS }: OverrideOptions = {},
): void {
	if (url === null) {
		localStorage.removeItem(toStorageKey(name))

		return
	}

	const problem = checkOverrideUrl(url)

	if (problem) throw new Error(`[federation] cannot override "${name}": ${problem}`)

	const override: RemoteOverride = {
		url: new URL(url).href,
		expiresAt: Date.now() + Math.min(ttlMs, MAX_OVERRIDE_TTL_MS),
	}
	localStorage.setItem(toStorageKey(name), JSON.stringify(override))
}

/** Every remote name currently overridden, with the override it points to. */
export function listRemoteOverrides(): Record<string, RemoteOverride> {
	const names: string[] = []
	for (let index = 0; index < localStorage.length; index++) {
		const key = localStorage.key(index)

		if (key?.startsWith(STORAGE_PREFIX)) names.push(key.slice(STORAGE_PREFIX.length))
	}

	const overrides: Record<string, RemoteOverride> = {}
	for (const name of names) {
		const override = readOverride(name)

		if (override) overrides[name] = override
	}

	return overrides
}

/*
 *   RUNTIME PLUGIN
 ***************************************************************************************************/
function warnOnce(name: string, override: RemoteOverride): void {
	if (warned.has(name)) return

	warned.add(name)
	const until = new Date(override.expiresAt).toISOString()
	console.warn(
		`[federation] "${name}" is overridden to ${override.url} until ${until}. ` +
			`Clear it with setRemoteOverride("${name}", null).`,
	)
}

const remoteOverridesPlugin: ModuleFederationRuntimePlugin = {
	name: 'spool-remote-overrides',
	beforeRegisterRemote({ remote, origin }) {
		if (!('entry' in remote)) return { remote, origin }

		const name = remote.alias ?? remote.name
		const override = readOverride(name)

		if (override) {
			remote.entry = override.url
			warnOnce(name, override)
		}

		return { remote, origin }
	},
	// A manifest names where its code lives (metaData.publicPath), and a listed manifest can
	// name any origin. The runtime starts preloading from the snapshot as soon as it has one,
	// before an entry is ever loaded, so this is the earliest hook that sees it. Where the
	// runtime offers nothing earlier, an origin on the list has to serve only your own builds.
	loadRemoteSnapshot(args) {
		const { moduleInfo, remoteSnapshot } = args
		const name = moduleInfo.alias ?? moduleInfo.name

		if (!readOverride(name)) return args

		const problem = checkSnapshot(remoteSnapshot, args.manifestUrl ?? getEntry(moduleInfo))

		if (problem) throw new Error(`[federation] "${name}" is overridden, and ${problem}`)

		return args
	},
	// The entry the runtime resolved, for an override that points at a remoteEntry.js directly.
	loadEntry({ remoteInfo }) {
		if (!readOverride(remoteInfo.alias ?? remoteInfo.name)) return undefined

		if (!getAllowedOrigins().includes(getOrigin(remoteInfo.entry))) {
			throw new Error(
				`[federation] "${remoteInfo.alias ?? remoteInfo.name}" is overridden, and its entry ${remoteInfo.entry} is not on a listed origin`,
			)
		}

		return undefined
	},
}

// The runtime registers remotes at init, before this file loads, so overrides are re-applied here.
function applyRemoteOverrides(): void {
	const instance = getInstance()

	if (!instance) return

	for (const remote of instance.options.remotes) {
		if (!('entry' in remote)) continue

		const name = remote.alias ?? remote.name
		const override = readOverride(name)

		if (override && remote.entry !== override.url) {
			warnOnce(name, override)
			instance.registerRemotes([{ ...remote, entry: override.url }], { force: true })
		}
	}
}

/** Only with a live federation runtime. Tests and plain vite builds have none. */
export function installRemoteOverrides(): void {
	if (!getInstance()) return

	registerPlugins([remoteOverridesPlugin])
	applyRemoteOverrides()
}
