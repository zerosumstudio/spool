// @vitest-environment jsdom
/*
 *   IMPORTS
 ***************************************************************************************************/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CoreModule from '../core'

/*
 *   TEST SETUP
 ***************************************************************************************************/
const INSTANCE_KEY = '__spoolTestFederationInstance'
const ENTRIES_KEY = '__spoolRemoteEntries'
const ENTRY = 'https://remote.example/remoteEntry.js'

// Stands in for @module-federation/runtime: getInstance() returns whatever the test installs.
vi.mock('@module-federation/runtime', () => ({
	getInstance: () =>
		(globalThis as Record<string, unknown>)['__spoolTestFederationInstance'] ?? null,
}))

type Core = typeof CoreModule

interface RegisteredRemote {
	name: string
	alias?: string
	entry: string
}

interface RemoteInfo {
	name: string
	entry: string
	type: string
}

interface EntriesPlugin {
	name: string
	loadEntry(args: { remoteInfo: RemoteInfo }): unknown
	afterLoadEntry(args: { remoteInfo: RemoteInfo; remoteEntryExports?: object | undefined }): void
}

interface CachedModule {
	remoteInfo: { entry: string }
	remoteEntryExports?: object | undefined
}

// How @module-federation/vite registers a remote: its own name, the app name as alias.
const assessments: RegisteredRemote = {
	name: '__mfe_internal__assessments',
	alias: 'assessments',
	entry: 'http://localhost:5175/mf-manifest.json',
}

const remoteInfo: RemoteInfo = { name: assessments.name, entry: ENTRY, type: 'module' }

function installInstance(remotes: RegisteredRemote[]) {
	const instance = {
		options: { remotes },
		moduleCache: new Map<string, CachedModule>(),
		registerRemotes: vi.fn(),
		registerPlugins: vi.fn<(plugins: EntriesPlugin[]) => void>(),
		loadRemote: vi.fn((id: string) => Promise.resolve({ default: `runtime:${id}` })),
	}
	;(globalThis as Record<string, unknown>)[INSTANCE_KEY] = instance

	return instance
}

type Instance = ReturnType<typeof installInstance>

function entriesPlugin(instance: Instance): EntriesPlugin {
	const plugin = instance.registerPlugins.mock.calls.at(-1)?.[0][0]
	if (!plugin) throw new Error('no runtime plugin was registered')

	return plugin
}

/** What the runtime leaves behind once it resolved the manifest and tried the entry. */
function cacheModule(instance: Instance, remoteEntryExports?: object): void {
	instance.moduleCache.set(assessments.name, { remoteInfo: { entry: ENTRY }, remoteEntryExports })
}

/** One entry load as the runtime runs it: loadEntry, then afterLoadEntry with the outcome. */
async function attempt(plugin: EntriesPlugin, outcome: 'loads' | 'fails'): Promise<string> {
	const exports = (await plugin.loadEntry({ remoteInfo })) as { url: string } | undefined
	const url = exports?.url ?? ENTRY
	plugin.afterLoadEntry({
		remoteInfo,
		remoteEntryExports: outcome === 'loads' ? { url } : undefined,
	})

	return url
}

/** A fresh copy of the module, as another host's bundle on the same page has. */
async function freshCore(): Promise<Core> {
	vi.resetModules()

	return import('../core')
}

const failedEntry = () => Promise.reject(new Error('Failed to fetch remoteEntry.js'))
const failingImport = () => vi.fn(() => Promise.reject(new Error('Failed to get manifest')))
const neverSettles = () => new Promise<never>(() => undefined)

beforeEach(() => {
	// The retry urls the entry plugin imports have no server behind them.
	for (const retry of [1, 2]) {
		vi.doMock(`${ENTRY}?spool-retry=${retry}`, () => ({ url: `${ENTRY}?spool-retry=${retry}` }))
	}
})

afterEach(() => {
	vi.useRealTimers()
	delete (globalThis as Record<string, unknown>)[INSTANCE_KEY]
	delete (globalThis as Record<string, unknown>)[ENTRIES_KEY]
})

/*
 *   NAME RESOLUTION
 ***************************************************************************************************/
describe('getRemoteName', () => {
	it.each([
		['staff', 'staff'],
		['staff/App', 'staff'],
		['assessments/NewAssessment', 'assessments'],
		['my-app/Nested/Expose', 'my-app'],
	])('resolves %s to the remote %s', async (id, name) => {
		const { getRemoteName } = await freshCore()

		expect(getRemoteName(id)).toBe(name)
	})
})

/*
 *   ENTRY URLS
 ***************************************************************************************************/
describe('remote entry plugin', () => {
	it('is registered once, before the first load', async () => {
		const instance = installInstance([assessments])
		const { loadRemote } = await freshCore()
		const importRemote = vi.fn(() => Promise.resolve({ default: 'bundled' }))

		await loadRemote('assessments', { importRemote })
		await loadRemote('assessments/NewAssessment', { importRemote })

		expect(instance.registerPlugins).toHaveBeenCalledOnce()
		expect(instance.registerPlugins.mock.invocationCallOrder[0]).toBeLessThan(
			importRemote.mock.invocationCallOrder[0]!,
		)
		expect(entriesPlugin(instance).name).toBe('spool-remote-entries')
	})

	it('leaves an entry that has not failed to the runtime', async () => {
		const instance = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', { importRemote: () => Promise.resolve({}) })

		expect(entriesPlugin(instance).loadEntry({ remoteInfo })).toBeUndefined()
	})

	it('moves each attempt after a failure to a fresh url, then keeps the one that loaded', async () => {
		const instance = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', { importRemote: () => Promise.resolve({}) })
		const plugin = entriesPlugin(instance)

		expect(await attempt(plugin, 'fails')).toBe(ENTRY)
		expect(await attempt(plugin, 'fails')).toBe(`${ENTRY}?spool-retry=1`)
		expect(await attempt(plugin, 'loads')).toBe(`${ENTRY}?spool-retry=2`)
		expect(await attempt(plugin, 'loads')).toBe(`${ENTRY}?spool-retry=2`)
	})

	it('counts a failure once, however many hosts were waiting on it', async () => {
		const instance = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', { importRemote: () => Promise.resolve({}) })
		const plugin = entriesPlugin(instance)

		await plugin.loadEntry({ remoteInfo })
		plugin.afterLoadEntry({ remoteInfo })
		plugin.afterLoadEntry({ remoteInfo })

		expect(await attempt(plugin, 'loads')).toBe(`${ENTRY}?spool-retry=1`)
	})

	it('shares urls with every other host bundle on the page', async () => {
		const shell = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', { importRemote: () => Promise.resolve({}) })
		const shellPlugin = entriesPlugin(shell)
		const staff = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', { importRemote: () => Promise.resolve({}) })
		const staffPlugin = entriesPlugin(staff)

		await attempt(shellPlugin, 'fails')
		await attempt(staffPlugin, 'fails')
		expect(await attempt(staffPlugin, 'loads')).toBe(`${ENTRY}?spool-retry=2`)

		// The shell imports the container staff evaluated, not one of its own.
		expect(await attempt(shellPlugin, 'loads')).toBe(`${ENTRY}?spool-retry=2`)
	})

	it('leaves script-type entries to the runtime', async () => {
		const instance = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', { importRemote: () => Promise.resolve({}) })
		const plugin = entriesPlugin(instance)
		const script = { ...remoteInfo, type: 'var' }

		await plugin.loadEntry({ remoteInfo: script })
		plugin.afterLoadEntry({ remoteInfo: script })

		expect(plugin.loadEntry({ remoteInfo: script })).toBeUndefined()
	})
})

/*
 *   RE-REGISTERING
 ***************************************************************************************************/
describe('forceReregister', () => {
	it('re-registers a remote whose entry failed, found by its alias', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance)
		const { forceReregister } = await freshCore()

		forceReregister('assessments/NewAssessment')

		expect(instance.registerRemotes).toHaveBeenCalledExactlyOnceWith([assessments], {
			force: true,
		})
	})

	it('finds a remote registered under the app name itself', async () => {
		const staff = {
			name: 'staff',
			alias: 'staff',
			entry: 'http://localhost:5174/mf-manifest.json',
		}
		const instance = installInstance([staff])
		instance.moduleCache.set('staff', { remoteInfo: { entry: ENTRY } })
		const { forceReregister } = await freshCore()

		forceReregister('staff')

		expect(instance.registerRemotes).toHaveBeenCalledExactlyOnceWith([staff], { force: true })
	})

	it('leaves a remote that never got as far as its entry', async () => {
		const instance = installInstance([assessments])
		const { forceReregister } = await freshCore()

		forceReregister('assessments')

		expect(instance.registerRemotes).not.toHaveBeenCalled()
	})

	it('leaves a remote whose entry loaded, so a failed expose does not tear it down', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance, {})
		const { forceReregister } = await freshCore()

		forceReregister('assessments/NewAssessment')

		expect(instance.registerRemotes).not.toHaveBeenCalled()
	})

	it('leaves a remote another host on the page has since loaded', async () => {
		const staff = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', { importRemote: () => Promise.resolve({}) })
		await attempt(entriesPlugin(staff), 'loads')

		const shell = installInstance([assessments])
		cacheModule(shell)
		;(await freshCore()).forceReregister('assessments')

		expect(shell.registerRemotes).not.toHaveBeenCalled()
	})

	it('leaves a remote whose entry another host is loading', async () => {
		const staff = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', { importRemote: () => Promise.resolve({}) })
		await entriesPlugin(staff).loadEntry({ remoteInfo })

		const shell = installInstance([assessments])
		cacheModule(shell)
		;(await freshCore()).forceReregister('assessments')

		expect(shell.registerRemotes).not.toHaveBeenCalled()
	})

	it('does nothing for a remote the runtime does not know, or with no runtime', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance)
		const { forceReregister } = await freshCore()

		forceReregister('staff')
		expect(instance.registerRemotes).not.toHaveBeenCalled()

		delete (globalThis as Record<string, unknown>)[INSTANCE_KEY]
		expect(() => forceReregister('assessments')).not.toThrow()
	})
})

/*
 *   LOADING
 ***************************************************************************************************/
describe('loadRemote', () => {
	it('uses the bundler import while it works', async () => {
		const instance = installInstance([assessments])
		const { loadRemote } = await freshCore()
		const importRemote = vi.fn(() => Promise.resolve({ default: 'bundled' }))

		await expect(loadRemote('assessments/App', { importRemote })).resolves.toEqual({
			default: 'bundled',
		})
		await loadRemote('assessments/App', { importRemote })

		expect(importRemote).toHaveBeenCalledTimes(2)
		expect(instance.loadRemote).not.toHaveBeenCalled()
		expect(instance.registerRemotes).not.toHaveBeenCalled()
	})

	it('asks the runtime once the import has failed, re-registering a failed entry first', async () => {
		const instance = installInstance([assessments])
		const { loadRemote } = await freshCore()
		const importRemote = vi.fn(() => {
			cacheModule(instance)

			return failedEntry()
		})

		await expect(
			loadRemote('assessments/NewAssessment', { importRemote }),
		).rejects.toMatchObject({
			code: 'ENTRY_FAILED',
			cause: expect.objectContaining({ message: 'Failed to fetch remoteEntry.js' }),
		})
		await expect(loadRemote('assessments/NewAssessment', { importRemote })).resolves.toEqual({
			default: 'runtime:assessments/NewAssessment',
		})

		expect(importRemote).toHaveBeenCalledOnce()
		expect(instance.registerRemotes).toHaveBeenCalledExactlyOnceWith([assessments], {
			force: true,
		})
		expect(instance.registerRemotes.mock.invocationCallOrder[0]).toBeLessThan(
			instance.loadRemote.mock.invocationCallOrder[0]!,
		)
	})

	it('retries a failed manifest through the runtime without re-registering', async () => {
		const instance = installInstance([assessments])
		const { loadRemote } = await freshCore()
		const importRemote = failingImport()

		await loadRemote('assessments/App', { importRemote }).catch(() => undefined)
		await loadRemote('assessments/App', { importRemote })

		expect(instance.loadRemote).toHaveBeenCalledOnce()
		expect(instance.registerRemotes).not.toHaveBeenCalled()
	})

	it('retries a failed expose of a loaded remote without re-registering it', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance, {})
		const { loadRemote } = await freshCore()
		const importExpose = vi.fn(() => Promise.reject(new Error('Failed to fetch expose')))

		await loadRemote('assessments/NewAssessment', { importRemote: importExpose }).catch(
			() => undefined,
		)
		await loadRemote('assessments/App', {
			importRemote: () => Promise.resolve({ default: 'app' }),
		})
		await expect(
			loadRemote('assessments/NewAssessment', { importRemote: importExpose }),
		).resolves.toEqual({ default: 'runtime:assessments/NewAssessment' })

		expect(instance.registerRemotes).not.toHaveBeenCalled()
	})

	it('does not re-register a remote while one of its loads is still in flight', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance)
		const { loadRemote, forceReregister } = await freshCore()
		let finish!: () => void
		instance.loadRemote.mockImplementationOnce(
			() =>
				new Promise(resolve => {
					finish = () => resolve({ default: 'runtime' })
				}),
		)
		await loadRemote('assessments', { importRemote: failedEntry }).catch(() => undefined)
		await loadRemote('assessments/NewAssessment', { importRemote: failedEntry }).catch(
			() => undefined,
		)
		instance.registerRemotes.mockClear()

		const first = loadRemote('assessments', { importRemote: failedEntry })
		forceReregister('assessments/NewAssessment')
		const second = loadRemote('assessments/NewAssessment', { importRemote: failedEntry })
		finish()
		await Promise.all([first, second])

		expect(instance.registerRemotes).toHaveBeenCalledOnce()
	})

	it('goes back to the import when the runtime never registered the remote', async () => {
		const instance = installInstance([])
		const { loadRemote } = await freshCore()
		const importRemote = failingImport()

		await loadRemote('assessments/App', { importRemote }).catch(() => undefined)
		await loadRemote('assessments/App', { importRemote }).catch(() => undefined)

		expect(importRemote).toHaveBeenCalledTimes(2)
		expect(instance.loadRemote).not.toHaveBeenCalled()
	})

	it('only ever uses the import without a federation runtime, as in tests', async () => {
		const { loadRemote } = await freshCore()
		const importRemote = failingImport()

		await loadRemote('assessments/App', { importRemote }).catch(() => undefined)
		await loadRemote('assessments/App', { importRemote }).catch(() => undefined)

		expect(importRemote).toHaveBeenCalledTimes(2)
	})

	it('catches an import that throws before it returns a promise', async () => {
		const { loadRemote } = await freshCore()
		const importRemote = vi.fn((): Promise<never> => {
			throw new Error('sync boom')
		})

		await expect(loadRemote('assessments/App', { importRemote })).rejects.toMatchObject({
			name: 'RemoteError',
			code: 'ENTRY_FAILED',
		})
	})
})

/*
 *   ERROR CODES
 ***************************************************************************************************/
describe('RemoteError', () => {
	it('is NOT_FOUND when the runtime resolves to nothing', async () => {
		const instance = installInstance([assessments])
		instance.loadRemote.mockResolvedValue(null as never)
		const { loadRemote } = await freshCore()
		const importRemote = failingImport()

		await loadRemote('assessments/App', { importRemote }).catch(() => undefined)

		await expect(loadRemote('assessments/App', { importRemote })).rejects.toMatchObject({
			code: 'NOT_FOUND',
			remote: 'assessments/App',
			needsReload: false,
		})
	})

	it('is NOT_FOUND when a runtime is live and the remote is not registered with it', async () => {
		installInstance([assessments])
		const { loadRemote } = await freshCore()

		await expect(
			loadRemote('staff/App', { importRemote: () => Promise.reject(new Error('nope')) }),
		).rejects.toMatchObject({ code: 'NOT_FOUND' })
	})

	it('is NOT_FOUND with no import and no runtime to ask', async () => {
		const { loadRemote } = await freshCore()

		await expect(loadRemote('staff/App')).rejects.toMatchObject({ code: 'NOT_FOUND' })
	})

	it('is ENTRY_FAILED, with no reload needed, while the entry has not loaded', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance)
		const { loadRemote } = await freshCore()

		await expect(
			loadRemote('assessments/App', { importRemote: failedEntry }),
		).rejects.toMatchObject({ code: 'ENTRY_FAILED', needsReload: false })
	})

	it('is CHUNK_FAILED and needs a reload once the entry has loaded', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance, {})
		const { loadRemote } = await freshCore()

		const error = await loadRemote('assessments/NewAssessment', {
			importRemote: () =>
				Promise.reject(new Error('Failed to fetch dynamically isImported module')),
		}).catch((cause: unknown) => cause)

		expect(error).toMatchObject({
			name: 'RemoteError',
			code: 'CHUNK_FAILED',
			needsReload: true,
		})
		expect(error).toBeInstanceOf(Error)
	})

	it('counts an entry another host on the page loaded', async () => {
		const staff = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', { importRemote: () => Promise.resolve({}) })
		await attempt(entriesPlugin(staff), 'loads')

		const shell = installInstance([assessments])
		cacheModule(shell)
		const { loadRemote } = await freshCore()

		await expect(
			loadRemote('assessments/NewAssessment', { importRemote: failedEntry }),
		).rejects.toMatchObject({ code: 'CHUNK_FAILED', needsReload: true })
	})
})

/*
 *   TIMEOUT
 ***************************************************************************************************/
describe('loadRemote timeout', () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	it('rejects with TIMEOUT after 15 seconds by default', async () => {
		installInstance([assessments])
		const { loadRemote } = await freshCore()
		const result = loadRemote('assessments/App', { importRemote: neverSettles })
		const isSettled = vi.fn()
		void result.catch(isSettled)

		await vi.advanceTimersByTimeAsync(14_999)
		expect(isSettled).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1)
		expect(isSettled).toHaveBeenCalledOnce()
		await expect(result).rejects.toMatchObject({
			name: 'RemoteError',
			code: 'TIMEOUT',
			remote: 'assessments/App',
			needsReload: false,
		})
	})

	it('takes the limit from timeoutMs', async () => {
		const { loadRemote } = await freshCore()
		const result = loadRemote('assessments/App', { importRemote: neverSettles, timeoutMs: 50 })
		const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' })

		await vi.advanceTimersByTimeAsync(50)

		await assertion
	})

	it('lowers inFlight on timeout, so forceReregister no longer skips the remote', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance)
		const { loadRemote, forceReregister } = await freshCore()
		const hung = loadRemote('assessments/App', { importRemote: neverSettles, timeoutMs: 1000 })
		const assertion = expect(hung).rejects.toMatchObject({ code: 'TIMEOUT' })
		// Starting the load re-registered the failed entry once; nothing more while it hangs.
		instance.registerRemotes.mockClear()

		forceReregister('assessments')
		expect(instance.registerRemotes).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1000)
		await assertion
		// The timeout itself re-registered the remote; this is the next attempt's look.
		instance.registerRemotes.mockClear()
		forceReregister('assessments')

		expect(instance.registerRemotes).toHaveBeenCalledExactlyOnceWith([assessments], {
			force: true,
		})
	})

	it('lets a retry recover once the first load timed out', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance)
		const { loadRemote } = await freshCore()
		const first = loadRemote('assessments/App', { importRemote: neverSettles, timeoutMs: 1000 })
		const assertion = expect(first).rejects.toMatchObject({ code: 'TIMEOUT' })
		await vi.advanceTimersByTimeAsync(1000)
		await assertion
		instance.registerRemotes.mockClear()

		const retry = loadRemote('assessments/App', { importRemote: neverSettles, timeoutMs: 1000 })

		await expect(retry).resolves.toEqual({ default: 'runtime:assessments/App' })
		expect(instance.registerRemotes).toHaveBeenCalledExactlyOnceWith([assessments], {
			force: true,
		})
	})

	it('re-registers the remote on timeout when no module was ever cached, as after a hung manifest', async () => {
		// The runtime caches the pending manifest request until it rejects or the remote is
		// removed, and creates the module only once the manifest arrives: nothing is cached.
		const instance = installInstance([assessments])
		const { loadRemote } = await freshCore()
		const hung = loadRemote('assessments/App', { importRemote: neverSettles, timeoutMs: 1000 })
		const assertion = expect(hung).rejects.toMatchObject({ code: 'TIMEOUT' })
		expect(instance.registerRemotes).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(1000)
		await assertion

		expect(instance.registerRemotes).toHaveBeenCalledExactlyOnceWith([assessments], {
			force: true,
		})
	})

	it('lets a retry after a hung manifest ask the runtime again', async () => {
		const instance = installInstance([assessments])
		const { loadRemote } = await freshCore()
		const first = loadRemote('assessments/App', { importRemote: neverSettles, timeoutMs: 1000 })
		const assertion = expect(first).rejects.toMatchObject({ code: 'TIMEOUT' })
		await vi.advanceTimersByTimeAsync(1000)
		await assertion
		const importAgain = vi.fn(neverSettles)

		await expect(
			loadRemote('assessments/App', { importRemote: importAgain, timeoutMs: 1000 }),
		).resolves.toEqual({ default: 'runtime:assessments/App' })

		expect(importAgain).not.toHaveBeenCalled()
		expect(instance.registerRemotes.mock.invocationCallOrder[0]).toBeLessThan(
			instance.loadRemote.mock.invocationCallOrder[0]!,
		)
	})

	it('leaves a remote whose entry loaded alone when only a chunk hung', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance, {})
		const { loadRemote } = await freshCore()
		const hung = loadRemote('assessments/Panel', { importRemote: neverSettles, timeoutMs: 10 })
		const assertion = expect(hung).rejects.toMatchObject({ code: 'TIMEOUT' })

		await vi.advanceTimersByTimeAsync(10)
		await assertion

		expect(instance.registerRemotes).not.toHaveBeenCalled()
	})

	it('leaves a remote whose entry another host loaded alone', async () => {
		const staff = installInstance([assessments])
		await (
			await freshCore()
		).loadRemote('assessments', {
			importRemote: () => Promise.resolve({}),
		})
		await attempt(entriesPlugin(staff), 'loads')
		const shell = installInstance([assessments])
		cacheModule(shell)
		const { loadRemote } = await freshCore()
		const hung = loadRemote('assessments/Panel', { importRemote: neverSettles, timeoutMs: 10 })
		const assertion = expect(hung).rejects.toMatchObject({ code: 'TIMEOUT' })
		shell.registerRemotes.mockClear()

		await vi.advanceTimersByTimeAsync(10)
		await assertion

		expect(shell.registerRemotes).not.toHaveBeenCalled()
	})

	it('moves a hung entry to a fresh url for the next attempt', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance)
		const { loadRemote } = await freshCore()
		const hung = loadRemote('assessments/App', { importRemote: neverSettles, timeoutMs: 1000 })
		const assertion = expect(hung).rejects.toMatchObject({ code: 'TIMEOUT' })
		const plugin = entriesPlugin(instance)
		void plugin.loadEntry({ remoteInfo })

		await vi.advanceTimersByTimeAsync(1000)
		await assertion

		expect(await attempt(plugin, 'loads')).toBe(`${ENTRY}?spool-retry=1`)
	})

	it('needs a reload when the entry had loaded and a chunk hung', async () => {
		const instance = installInstance([assessments])
		cacheModule(instance, {})
		const { loadRemote } = await freshCore()
		const hung = loadRemote('assessments/Panel', { importRemote: neverSettles, timeoutMs: 10 })
		const assertion = expect(hung).rejects.toMatchObject({ code: 'TIMEOUT', needsReload: true })

		await vi.advanceTimersByTimeAsync(10)

		await assertion
	})

	it('ignores a load that settles after it timed out', async () => {
		const { loadRemote } = await freshCore()
		let finish!: (value: { default: string }) => void
		const late = new Promise<{ default: string }>(resolve => {
			finish = resolve
		})
		const result = loadRemote('assessments/App', { importRemote: () => late, timeoutMs: 10 })
		const assertion = expect(result).rejects.toMatchObject({ code: 'TIMEOUT' })
		await vi.advanceTimersByTimeAsync(10)
		await assertion

		finish({ default: 'too late' })

		await vi.runAllTimersAsync()

		expect(vi.getTimerCount()).toBe(0)
	})

	it('stops the timer once a load settles', async () => {
		const { loadRemote } = await freshCore()

		await loadRemote('assessments/App', { importRemote: () => Promise.resolve({ default: 1 }) })

		expect(vi.getTimerCount()).toBe(0)
	})
})

/*
 *   LOADER
 ***************************************************************************************************/
describe('createRemoteLoader', () => {
	const module = { default: 'component' }

	it('starts on the first subscriber and not before', async () => {
		const { createRemoteLoader } = await freshCore()
		const load = vi.fn(() => Promise.resolve(module))
		const loader = createRemoteLoader('assessments', load)

		expect(loader.getState()).toEqual({ status: 'loading' })
		expect(load).not.toHaveBeenCalled()

		loader.subscribe(() => undefined)
		expect(load).toHaveBeenCalledOnce()
	})

	it('goes from loading to ready, telling its subscribers', async () => {
		const { createRemoteLoader } = await freshCore()
		const loader = createRemoteLoader('assessments', () => Promise.resolve(module))
		const listener = vi.fn()
		loader.subscribe(listener)

		await vi.waitFor(() => expect(loader.getState()).toEqual({ status: 'ready', module }))

		expect(listener).toHaveBeenCalledOnce()
	})

	it('goes to error with a RemoteError, then recovers on retry', async () => {
		const { createRemoteLoader, RemoteError } = await freshCore()
		const load = vi
			.fn<() => Promise<typeof module>>()
			.mockRejectedValueOnce(new Error('offline'))
			.mockResolvedValueOnce(module)
		const loader = createRemoteLoader('assessments', load)
		loader.subscribe(() => undefined)

		await vi.waitFor(() => expect(loader.getState().status).toBe('error'))
		const state = loader.getState()
		expect(state.status === 'error' && state.error).toBeInstanceOf(RemoteError)

		loader.retry()
		expect(loader.getState()).toEqual({ status: 'loading' })
		await vi.waitFor(() => expect(loader.getState()).toEqual({ status: 'ready', module }))
		expect(load).toHaveBeenCalledTimes(2)
	})

	it('keeps the RemoteError a load rejected with', async () => {
		const { createRemoteLoader, RemoteError } = await freshCore()
		const timeout = new RemoteError('TIMEOUT', 'assessments/App')
		const loader = createRemoteLoader('assessments', () => Promise.reject(timeout))
		loader.subscribe(() => undefined)

		await vi.waitFor(() =>
			expect(loader.getState()).toEqual({ status: 'error', error: timeout }),
		)
	})

	it('only retries from an error', async () => {
		const { createRemoteLoader } = await freshCore()
		const load = vi.fn(() => new Promise<typeof module>(() => undefined))
		const loader = createRemoteLoader('assessments', load)
		loader.subscribe(() => undefined)

		loader.retry()

		expect(load).toHaveBeenCalledOnce()
	})

	it('does not start over when a subscriber leaves and another arrives', async () => {
		const { createRemoteLoader } = await freshCore()
		const load = vi.fn(() => Promise.resolve(module))
		const loader = createRemoteLoader('assessments', load)

		loader.subscribe(() => undefined)()
		loader.subscribe(() => undefined)

		expect(load).toHaveBeenCalledOnce()
	})

	it('stops telling a subscriber that left', async () => {
		const { createRemoteLoader } = await freshCore()
		const loader = createRemoteLoader('assessments', () => Promise.resolve(module))
		const listener = vi.fn()

		loader.subscribe(listener)()
		await vi.waitFor(() => expect(loader.getState().status).toBe('ready'))

		expect(listener).not.toHaveBeenCalled()
	})

	it('ignores a result that arrives after a newer attempt hasStarted', async () => {
		const { createRemoteLoader } = await freshCore()
		const results: ((value: typeof module) => void)[] = []
		const rejections: ((reason: Error) => void)[] = []
		const load = vi.fn(
			() =>
				new Promise<typeof module>((resolve, reject) => {
					results.push(resolve)
					rejections.push(reject)
				}),
		)
		const loader = createRemoteLoader('assessments', load)
		loader.subscribe(() => undefined)
		rejections[0]!(new Error('first failed'))
		await vi.waitFor(() => expect(loader.getState().status).toBe('error'))

		loader.retry()
		results[1]!({ default: 'second' })
		await vi.waitFor(() => expect(loader.getState().status).toBe('ready'))
		results[0]!({ default: 'stale' })
		await Promise.resolve()

		expect(loader.getState()).toEqual({ status: 'ready', module: { default: 'second' } })
	})

	it('catches a load that throws before it returns a promise', async () => {
		const { createRemoteLoader } = await freshCore()
		const loader = createRemoteLoader('assessments', () => {
			throw new Error('sync boom')
		})
		loader.subscribe(() => undefined)

		await vi.waitFor(() => expect(loader.getState().status).toBe('error'))
	})
})

/*
 *   WARNINGS
 ***************************************************************************************************/
describe('warnUnknownRemote', () => {
	it('warns once per name in dev', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const { warnUnknownRemote } = await freshCore()

		warnUnknownRemote('ghost')
		warnUnknownRemote('ghost')
		warnUnknownRemote('other')

		expect(warn).toHaveBeenCalledTimes(2)
		expect(warn).toHaveBeenCalledWith('[federation] no remote named "ghost" in the registry')
	})
})
