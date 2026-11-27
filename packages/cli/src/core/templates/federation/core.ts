import { getInstance, type ModuleFederationRuntimePlugin } from '@module-federation/runtime'

/*
 *   TYPES
 ***************************************************************************************************/
type Federation = NonNullable<ReturnType<typeof getInstance>>

export type RemoteErrorCode = 'TIMEOUT' | 'ENTRY_FAILED' | 'CHUNK_FAILED' | 'NOT_FOUND'

export interface RemoteModule {
	default: unknown
}

export interface LoadOptions<Module> {
	/** How long a load may take before it rejects with TIMEOUT. */
	timeoutMs?: number
	/** The bundler's own import of the remote, which also registers it with the runtime. */
	importRemote?: () => Promise<Module>
}

export type RemoteState<Module = RemoteModule> =
	| { status: 'loading' }
	| { status: 'ready'; module: Module }
	| { status: 'error'; error: RemoteError }

export interface RemoteLoader<Module = RemoteModule> {
	getState: () => RemoteState<Module>
	/** The first subscriber starts the load. Safe to call again after an unsubscribe. */
	subscribe: (listener: () => void) => () => void
	/** Starts the load over after an error. */
	retry: () => void
}

interface RemoteEntries {
	// The url each container was evaluated from. Every later load imports that
	// url, so no container is evaluated twice.
	loadedFrom: Map<string, string>
	// WebKit can answer a second import() of a remoteEntry.js that failed with the
	// same failure, without fetching it, so each failure moves the next attempt to
	// a fresh url.
	failures: Map<string, number>
	// The url each entry is being loaded from right now.
	loading: Map<string, string>
}

/*
 *   ERRORS
 ***************************************************************************************************/
export const DEFAULT_TIMEOUT_MS = 15_000

export class RemoteError extends Error {
	readonly code: RemoteErrorCode
	/** The registry key or import id that was being loaded. */
	readonly remote: string
	/** This id failed again after its entry had loaded. WebKit keeps a failed module import
	 * for the life of the page, so only a reload can fix it. The first failure is worth a retry. */
	readonly needsReload: boolean

	constructor(
		code: RemoteErrorCode,
		remote: string,
		options: { message?: string; needsReload?: boolean; cause?: unknown } = {},
	) {
		super(options.message ?? formatMessage(code, remote), { cause: options.cause })
		this.name = 'RemoteError'
		this.code = code
		this.remote = remote
		this.needsReload = options.needsReload ?? false
	}
}

function formatMessage(code: RemoteErrorCode, remote: string): string {
	if (code === 'TIMEOUT') return `remote "${remote}" took too long to load`

	if (code === 'CHUNK_FAILED') return `remote "${remote}" loaded, but one of its modules did not`

	if (code === 'NOT_FOUND') return `no remote "${remote}" is registered`

	return `remote "${remote}" could not load its entry`
}

/*
 *   SHARED STATE
 ***************************************************************************************************/
// Shared by every spool host on the page and keyed by remoteEntry url, like the
// runtime's own entry cache: a nested host bundles its own copy of this file and
// of the runtime, but they all share that cache and the browser's module map.
const page = globalThis as typeof globalThis & { __spoolRemoteEntries?: RemoteEntries }
const entries: RemoteEntries = (page.__spoolRemoteEntries ??= {
	loadedFrom: new Map(),
	failures: new Map(),
	loading: new Map(),
})

// The bundler's import("staff/App") keeps its first promise for the life of
// the page, even a rejected one, so an id whose import has failed goes to the
// runtime from then on.
const failedImports = new Set<string>()
// Ids that have failed once with their entry loaded, so a second failure means a reload.
const failedChunks = new Set<string>()
// Loads this bundle has started and not finished, by remote name.
const inFlight = new Map<string, number>()
const warnedUnknown = new Set<string>()

/*
 *   ENTRY PLUGIN
 ***************************************************************************************************/
function buildAttemptUrl(entry: string): string {
	const failures = entries.failures.get(entry)

	if (!failures) return entry

	const url = new URL(entry)
	url.searchParams.set('spool-retry', String(failures))

	return url.href
}

const remoteEntriesPlugin: ModuleFederationRuntimePlugin = {
	name: 'spool-remote-entries',
	loadEntry({ remoteInfo: { entry, type } }) {
		const isImported = type === 'module' || type === 'esm'
		const url = entries.loadedFrom.get(entry) ?? (isImported ? buildAttemptUrl(entry) : entry)
		entries.loading.set(entry, url)

		if (url !== entry) return import(/* @vite-ignore */ url)

		return undefined
	},
	afterLoadEntry({ remoteInfo: { entry }, remoteEntryExports }) {
		const url = entries.loading.get(entry)
		entries.loading.delete(entry)

		if (entries.loadedFrom.has(entry)) return

		if (remoteEntryExports) {
			entries.loadedFrom.set(entry, url ?? entry)
		} else if (url) {
			entries.failures.set(entry, (entries.failures.get(entry) ?? 0) + 1)
		}
	},
}

let withPlugin: Federation | undefined

function getFederation(): Federation | undefined {
	const instance = getInstance() ?? undefined

	if (instance && instance !== withPlugin) {
		instance.registerPlugins([remoteEntriesPlugin])
		withPlugin = instance
	}

	return instance
}

/*
 *   REGISTERED REMOTES
 ***************************************************************************************************/
/** The remote a registry key or import id belongs to: "staff" for "staff" and
 * "staff/App", "assessments" for "assessments/NewAssessment". */
export function getRemoteName(id: string): string {
	const slash = id.indexOf('/')

	return slash === -1 ? id : id.slice(0, slash)
}

function findRegisteredRemote(name: string) {
	const instance = getFederation()
	const remote = instance?.options.remotes.find(
		candidate => candidate.name === name || candidate.alias === name,
	)

	return instance && remote ? { instance, remote } : undefined
}

function getCachedModule(name: string) {
	const registered = findRegisteredRemote(name)

	return registered?.instance.moduleCache.get(registered.remote.name)
}

/** Whether the remote's entry has run on this page, here or in another host's bundle. */
function hasLoadedEntry(name: string): boolean {
	const module = getCachedModule(name)

	if (!module) return false

	return Boolean(module.remoteEntryExports) || entries.loadedFrom.has(module.remoteInfo.entry)
}

/** Records a failure of `id` and says whether it is the second one with the entry loaded. */
function isRepeatChunkFailure(id: string): boolean {
	if (!hasLoadedEntry(getRemoteName(id))) return false

	const isRepeat = failedChunks.has(id)
	failedChunks.add(id)

	return isRepeat
}

/** Re-registers a remote whose entry script failed to load, so the runtime
 * drops the failure it keeps and fetches the entry again. Leaves a remote alone
 * while it is loading, once its entry has loaded anywhere on the page, and when
 * it never got as far as its entry, as nothing about it is kept then. */
export function forceReregister(id: string): void {
	const name = getRemoteName(id)
	const registered = findRegisteredRemote(name)

	if (!registered || inFlight.has(name)) return

	const { instance, remote } = registered
	const module = instance.moduleCache.get(remote.name)

	if (!module || module.remoteEntryExports) return

	const { entry } = module.remoteInfo

	if (entries.loadedFrom.has(entry) || entries.loading.has(entry)) return

	instance.registerRemotes([remote], { force: true })
}

/** Gives up on a load that never answered, so the next attempt asks again. An entry script that
 * hung moves to a fresh url. A manifest that hung is cleared by re-registering the remote: the
 * runtime keeps its pending request in `__MANIFEST_LOADING__` until it rejects or the remote is
 * removed, and a hung one does neither, so with no module cached forceReregister cannot see it. */
function abandonLoad(name: string): void {
	const registered = findRegisteredRemote(name)

	if (!registered) return

	const { instance, remote } = registered
	const module = instance.moduleCache.get(remote.name)

	if (module?.remoteEntryExports) return

	const entry = module?.remoteInfo.entry

	if (entry !== undefined) {
		if (entries.loadedFrom.has(entry)) return

		if (entries.loading.delete(entry)) {
			entries.failures.set(entry, (entries.failures.get(entry) ?? 0) + 1)
		}
	}

	instance.registerRemotes([remote], { force: true })
}

function releaseLoad(name: string): void {
	const loads = (inFlight.get(name) ?? 1) - 1

	if (loads) inFlight.set(name, loads)
	else inFlight.delete(name)
}

/*
 *   LOADING
 ***************************************************************************************************/
/** Turns whatever a load threw into a RemoteError, working out whether the entry or a chunk failed. */
export function toRemoteError(id: string, cause: unknown): RemoteError {
	if (cause instanceof RemoteError) return cause

	const name = getRemoteName(id)

	if (getFederation() && !findRegisteredRemote(name)) {
		return new RemoteError('NOT_FOUND', id, { cause })
	}

	const hasEntry = hasLoadedEntry(name)

	return new RemoteError(hasEntry ? 'CHUNK_FAILED' : 'ENTRY_FAILED', id, {
		cause,
		needsReload: isRepeatChunkFailure(id),
	})
}

function startLoad<Module>(id: string, importRemote?: () => Promise<Module>): Promise<Module> {
	const name = getRemoteName(id)
	const registered =
		!importRemote || failedImports.has(id) ? findRegisteredRemote(name) : undefined

	if (registered) {
		return registered.instance
			.loadRemote<Module>(id)
			.then(module => module ?? Promise.reject(new RemoteError('NOT_FOUND', id)))
	}

	if (!importRemote) return Promise.reject(new RemoteError('NOT_FOUND', id))

	return importRemote().catch((error: unknown) => {
		failedImports.add(id)
		throw error
	})
}

/** Loads a remote module, through the bundler's import while that works and through the
 * runtime once it has failed. Rejects with a RemoteError, and with TIMEOUT after `timeoutMs`
 * without waiting on a load that never answers. */
export function loadRemote<Module = RemoteModule>(
	id: string,
	{ timeoutMs = DEFAULT_TIMEOUT_MS, importRemote }: LoadOptions<Module> = {},
): Promise<Module> {
	const name = getRemoteName(id)
	forceReregister(name)
	inFlight.set(name, (inFlight.get(name) ?? 0) + 1)

	return new Promise<Module>((resolve, reject) => {
		let isSettled = false
		const settle = () => {
			isSettled = true
			clearTimeout(timer)
			releaseLoad(name)
		}

		const timer = setTimeout(() => {
			if (isSettled) return

			// The count has to drop here, or forceReregister skips this remote for good.
			settle()
			const needsReload = isRepeatChunkFailure(id)
			abandonLoad(name)
			failedImports.add(id)
			reject(
				new RemoteError('TIMEOUT', id, {
					message: `remote "${id}" did not load within ${String(timeoutMs)}ms`,
					needsReload,
				}),
			)
		}, timeoutMs)

		new Promise<Module>(begin => {
			begin(startLoad(id, importRemote))
		}).then(
			module => {
				if (isSettled) return

				settle()
				failedChunks.delete(id)
				resolve(module)
			},
			(cause: unknown) => {
				if (isSettled) return

				settle()
				reject(toRemoteError(id, cause))
			},
		)
	})
}

/*
 *   LOADER
 ***************************************************************************************************/
const LOADING = { status: 'loading' } as const

/** The loading, ready and error states of one remote, for a <Remote> to render. */
export function createRemoteLoader<Module extends RemoteModule = RemoteModule>(
	name: string,
	load: () => Promise<Module>,
): RemoteLoader<Module> {
	let state: RemoteState<Module> = LOADING
	let hasStarted = false
	let attempt = 0
	const listeners = new Set<() => void>()

	function update(next: RemoteState<Module>): void {
		state = next
		for (const listener of [...listeners]) listener()
	}

	function run(): void {
		const current = ++attempt

		if (state !== LOADING) update(LOADING)

		new Promise<Module>(begin => {
			begin(load())
		}).then(
			module => {
				if (current === attempt) update({ status: 'ready', module })
			},
			(cause: unknown) => {
				if (current !== attempt) return

				update({ status: 'error', error: toRemoteError(name, cause) })
			},
		)
	}

	return {
		getState: () => state,
		subscribe(listener) {
			listeners.add(listener)

			if (!hasStarted) {
				hasStarted = true
				run()
			}

			return () => {
				listeners.delete(listener)
			}
		},
		retry() {
			if (state.status === 'error') run()
		},
	}
}

/*
 *   DEV WARNINGS
 ***************************************************************************************************/
/** Warns once per name, in dev only, that <Remote> was given a name the registry does not have. */
export function warnUnknownRemote(name: string): void {
	if (!import.meta.env.DEV || warnedUnknown.has(name)) return

	warnedUnknown.add(name)
	console.warn(`[federation] no remote named "${name}" in the registry`)
}
