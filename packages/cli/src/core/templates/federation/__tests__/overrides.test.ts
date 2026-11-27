// @vitest-environment jsdom
/*
 *   IMPORTS
 ***************************************************************************************************/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as OverridesModule from '../overrides'

/*
 *   TEST SETUP
 ***************************************************************************************************/
const INSTANCE_KEY = '__spoolTestFederationInstance'
const DAY_MS = 24 * 60 * 60 * 1000
const MANIFEST = 'https://staging.example.com/mf-manifest.json'

const registerPlugins = vi.fn()

// Stands in for @module-federation/runtime: getInstance() returns whatever the test installs.
vi.mock('@module-federation/runtime', () => ({
	getInstance: () =>
		(globalThis as Record<string, unknown>)['__spoolTestFederationInstance'] ?? null,
	registerPlugins: (...args: unknown[]) => registerPlugins(...args),
}))

type Overrides = typeof OverridesModule

interface RuntimePlugin {
	beforeRegisterRemote(args: { remote: Record<string, unknown>; origin: unknown }): {
		remote: Record<string, unknown>
	}
	loadEntry(args: { remoteInfo: { name: string; alias?: string; entry: string } }): unknown
	loadRemoteSnapshot(args: {
		moduleInfo: { name: string; alias?: string; entry: string }
		remoteSnapshot: object
		manifestUrl?: string
	}): unknown
}

async function freshOverrides(): Promise<Overrides> {
	vi.resetModules()

	return import('../overrides')
}

function allowOrigins(origins: string[]): void {
	vi.stubGlobal('__SPOOL_OVERRIDE_ORIGINS__', origins)
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date('2026-11-27T10:00:00Z'))
	allowOrigins(['https://staging.example.com'])
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	localStorage.clear()
	registerPlugins.mockClear()
	delete (globalThis as Record<string, unknown>)[INSTANCE_KEY]
})

/*
 *   ALLOWLIST
 ***************************************************************************************************/
describe('checkOverrideUrl', () => {
	it.each([
		[MANIFEST],
		['https://staging.example.com/team/mf-manifest.json'],
		['https://staging.example.com/assets/remoteEntry.js'],
	])('accepts %s', async url => {
		const { checkOverrideUrl } = await freshOverrides()

		expect(checkOverrideUrl(url)).toBeUndefined()
	})

	it('rejects an origin that is not listed', async () => {
		const { checkOverrideUrl } = await freshOverrides()

		expect(checkOverrideUrl('https://evil.example/mf-manifest.json')).toContain(
			'https://evil.example is not in spool.json "overrides.origins"',
		)
	})

	it('rejects everything when the define is missing or empty', async () => {
		const { checkOverrideUrl } = await freshOverrides()

		allowOrigins([])
		expect(checkOverrideUrl(MANIFEST)).toContain('not in spool.json')

		vi.unstubAllGlobals()
		expect(checkOverrideUrl(MANIFEST)).toContain('not in spool.json')
	})

	it('rejects a lookalike origin that only shares a prefix or a suffix', async () => {
		const { checkOverrideUrl } = await freshOverrides()

		expect(
			checkOverrideUrl('https://staging.example.com.evil.example/mf-manifest.json'),
		).toBeDefined()
		expect(checkOverrideUrl('https://evilstaging.example.com/mf-manifest.json')).toBeDefined()
		expect(checkOverrideUrl('https://staging.example.com:8443/mf-manifest.json')).toBeDefined()
	})

	it('rejects http to a host that is not local, even when it is listed', async () => {
		const { checkOverrideUrl } = await freshOverrides()
		allowOrigins(['http://staging.example.com'])

		expect(checkOverrideUrl('http://staging.example.com/mf-manifest.json')).toContain('https')
	})

	it('allows http to localhost in dev when its origin is listed', async () => {
		const { checkOverrideUrl } = await freshOverrides()
		allowOrigins(['http://localhost:5175', 'http://127.0.0.1:5175'])

		expect(checkOverrideUrl('http://localhost:5175/mf-manifest.json')).toBeUndefined()
		expect(checkOverrideUrl('http://127.0.0.1:5175/remoteEntry.js')).toBeUndefined()
	})

	it('still wants a listed origin for localhost', async () => {
		const { checkOverrideUrl } = await freshOverrides()

		expect(checkOverrideUrl('http://localhost:5175/mf-manifest.json')).toContain(
			'not in spool.json',
		)
	})

	it.each([
		['https://staging.example.com/mf-manifest.json?v=2'],
		['https://staging.example.com/mf-manifest.json?'],
		['https://staging.example.com/mf-manifest.json#frag'],
		['https://staging.example.com/remoteEntry.js?token=abc'],
	])('rejects a query string or fragment: %s', async url => {
		const { checkOverrideUrl } = await freshOverrides()

		expect(checkOverrideUrl(url)).toContain('query string or fragment')
	})

	it.each([
		['https://staging.example.com/evil.js'],
		['https://staging.example.com/'],
		['https://staging.example.com/mf-manifest.json/extra'],
		['https://staging.example.com/not-mf-manifest.json'],
		['https://staging.example.com/remoteEntry.js.map'],
	])('rejects a path that is not an entry file: %s', async url => {
		const { checkOverrideUrl } = await freshOverrides()

		expect(checkOverrideUrl(url)).toContain('must end in')
	})

	it.each([
		['not a url'],
		[''],
		['/mf-manifest.json'],
		['javascript:alert(1)'],
		['data:text/javascript,1'],
	])('rejects what does not parse as an https url: %j', async value => {
		const { checkOverrideUrl } = await freshOverrides()

		expect(checkOverrideUrl(value)).toBeDefined()
	})

	it('rejects credentials in the url', async () => {
		const { checkOverrideUrl } = await freshOverrides()

		expect(
			checkOverrideUrl('https://user:pass@staging.example.com/mf-manifest.json'),
		).toContain('credentials')
	})
})

/*
 *   STORAGE
 ***************************************************************************************************/
describe('setRemoteOverride', () => {
	it('stores the url with a 24 hour expiry', async () => {
		const { setRemoteOverride } = await freshOverrides()

		setRemoteOverride('assessments', MANIFEST)

		expect(JSON.parse(localStorage.getItem('spool:remote:assessments')!)).toEqual({
			url: MANIFEST,
			expiresAt: Date.now() + DAY_MS,
		})
	})

	it('takes another lifetime from ttlMs', async () => {
		const { setRemoteOverride, listRemoteOverrides } = await freshOverrides()

		setRemoteOverride('assessments', MANIFEST, { ttlMs: 1000 })

		expect(listRemoteOverrides().assessments?.expiresAt).toBe(Date.now() + 1000)
	})

	it('throws, and stores nothing, for a url that fails the checks', async () => {
		const { setRemoteOverride } = await freshOverrides()

		expect(() =>
			setRemoteOverride('assessments', 'https://evil.example/mf-manifest.json'),
		).toThrow(/cannot override "assessments".*not in spool\.json/)
		expect(localStorage.length).toBe(0)
	})

	it('stores the normalised href, so what is checked is what is fetched', async () => {
		const { setRemoteOverride, listRemoteOverrides } = await freshOverrides()

		setRemoteOverride('assessments', 'https://STAGING.example.com/a/../mf-manifest.json')

		const stored = JSON.parse(localStorage.getItem('spool:remote:assessments')!)
		expect(stored.url).toBe('https://staging.example.com/mf-manifest.json')
		expect(listRemoteOverrides().assessments?.url).toBe(stored.url)
	})

	it('reads an older stored value back as its normalised href too', async () => {
		const { listRemoteOverrides } = await freshOverrides()
		localStorage.setItem(
			'spool:remote:assessments',
			JSON.stringify({
				url: 'https://STAGING.example.com/x/../mf-manifest.json',
				expiresAt: Date.now() + 1000,
			}),
		)

		expect(listRemoteOverrides().assessments?.url).toBe(
			'https://staging.example.com/mf-manifest.json',
		)
	})

	it('caps a longer ttlMs at 24 hours', async () => {
		const { setRemoteOverride, listRemoteOverrides } = await freshOverrides()

		setRemoteOverride('assessments', MANIFEST, { ttlMs: 30 * DAY_MS })

		expect(listRemoteOverrides().assessments?.expiresAt).toBe(Date.now() + DAY_MS)
	})

	it('ignores and removes an override that expires further out than 24 hours', async () => {
		const { listRemoteOverrides } = await freshOverrides()
		localStorage.setItem(
			'spool:remote:assessments',
			JSON.stringify({ url: MANIFEST, expiresAt: Date.now() + DAY_MS + 1 }),
		)

		expect(listRemoteOverrides()).toEqual({})
		expect(localStorage.length).toBe(0)
	})

	it('clears an override with null', async () => {
		const { setRemoteOverride, listRemoteOverrides } = await freshOverrides()
		setRemoteOverride('assessments', MANIFEST)

		setRemoteOverride('assessments', null)

		expect(listRemoteOverrides()).toEqual({})
	})

	it('expires after 24 hours and removes the entry', async () => {
		const { setRemoteOverride, listRemoteOverrides } = await freshOverrides()
		setRemoteOverride('assessments', MANIFEST)

		vi.advanceTimersByTime(DAY_MS - 1)
		expect(Object.keys(listRemoteOverrides())).toEqual(['assessments'])

		vi.advanceTimersByTime(1)
		expect(listRemoteOverrides()).toEqual({})
		expect(localStorage.getItem('spool:remote:assessments')).toBeNull()
	})

	it('drops a stored override whose origin has since left the allowlist', async () => {
		const { setRemoteOverride, listRemoteOverrides } = await freshOverrides()
		setRemoteOverride('assessments', MANIFEST)

		allowOrigins([])

		expect(listRemoteOverrides()).toEqual({})
		expect(localStorage.length).toBe(0)
	})

	it.each([
		['a bare url from the old format', MANIFEST],
		['broken json', '{'],
		['a json array', '[]'],
		['a missing expiry', JSON.stringify({ url: MANIFEST })],
		['a non-numeric expiry', JSON.stringify({ url: MANIFEST, expiresAt: 'soon' })],
	])('ignores and removes %s', async (_label, stored) => {
		const { listRemoteOverrides } = await freshOverrides()
		localStorage.setItem('spool:remote:assessments', stored)

		expect(listRemoteOverrides()).toEqual({})
		expect(localStorage.length).toBe(0)
	})

	it('lists only spool override keys', async () => {
		const { setRemoteOverride, listRemoteOverrides } = await freshOverrides()
		localStorage.setItem('unrelated', 'x')
		setRemoteOverride('assessments', MANIFEST)

		expect(Object.keys(listRemoteOverrides())).toEqual(['assessments'])
	})
})

/*
 *   RUNTIME PLUGIN
 ***************************************************************************************************/
describe('installRemoteOverrides', () => {
	function installInstance(remotes: Record<string, unknown>[]) {
		const instance = { options: { remotes }, registerRemotes: vi.fn() }
		;(globalThis as Record<string, unknown>)[INSTANCE_KEY] = instance

		return instance
	}

	function installedPlugin(): RuntimePlugin {
		return registerPlugins.mock.calls[0]![0][0] as RuntimePlugin
	}

	it('does nothing without a federation runtime', async () => {
		const { installRemoteOverrides } = await freshOverrides()

		installRemoteOverrides()

		expect(registerPlugins).not.toHaveBeenCalled()
	})

	it('points a remote that registers later at its override', async () => {
		const { installRemoteOverrides, setRemoteOverride } = await freshOverrides()
		installInstance([])
		setRemoteOverride('assessments', MANIFEST)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		installRemoteOverrides()

		const { remote } = installedPlugin().beforeRegisterRemote({
			remote: {
				name: '__mfe_internal__assessments',
				alias: 'assessments',
				entry: 'https://prod/mf-manifest.json',
			},
			origin: {},
		})

		expect(remote.entry).toBe(MANIFEST)
	})

	it('leaves a remote alone once its override expired', async () => {
		const { installRemoteOverrides, setRemoteOverride } = await freshOverrides()
		installInstance([])
		setRemoteOverride('assessments', MANIFEST)
		installRemoteOverrides()

		vi.advanceTimersByTime(DAY_MS)
		const { remote } = installedPlugin().beforeRegisterRemote({
			remote: {
				name: 'assessments',
				alias: 'assessments',
				entry: 'https://prod/mf-manifest.json',
			},
			origin: {},
		})

		expect(remote.entry).toBe('https://prod/mf-manifest.json')
	})

	it('re-registers a remote the runtime registered before this file loaded', async () => {
		const { installRemoteOverrides, setRemoteOverride } = await freshOverrides()
		const registered = {
			name: 'assessments',
			alias: 'assessments',
			entry: 'https://prod/mf-manifest.json',
		}
		const instance = installInstance([registered])
		setRemoteOverride('assessments', MANIFEST)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)

		installRemoteOverrides()

		expect(instance.registerRemotes).toHaveBeenCalledExactlyOnceWith(
			[{ ...registered, entry: MANIFEST }],
			{ force: true },
		)
	})

	it('does not touch a remote with no override, or an override from a listed-then-removed origin', async () => {
		const { installRemoteOverrides, setRemoteOverride } = await freshOverrides()
		const instance = installInstance([
			{ name: 'assessments', alias: 'assessments', entry: 'https://prod/mf-manifest.json' },
			{ name: 'staff', alias: 'staff', entry: 'https://prod/staff/mf-manifest.json' },
		])
		setRemoteOverride('staff', MANIFEST)
		allowOrigins([])

		installRemoteOverrides()

		expect(instance.registerRemotes).not.toHaveBeenCalled()
	})

	it('warns once per page load for each active override', async () => {
		const { installRemoteOverrides, setRemoteOverride } = await freshOverrides()
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		installInstance([
			{ name: 'assessments', alias: 'assessments', entry: 'https://prod/a/mf-manifest.json' },
			{ name: 'staff', alias: 'staff', entry: 'https://prod/s/mf-manifest.json' },
		])
		setRemoteOverride('assessments', MANIFEST)
		setRemoteOverride('staff', 'https://staging.example.com/staff/mf-manifest.json')

		installRemoteOverrides()
		const plugin = installedPlugin()
		for (let again = 0; again < 3; again++) {
			plugin.beforeRegisterRemote({
				remote: {
					name: 'assessments',
					alias: 'assessments',
					entry: 'https://prod/a/mf-manifest.json',
				},
				origin: {},
			})
		}

		expect(warn).toHaveBeenCalledTimes(2)
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining(
				`"assessments" is overridden to ${MANIFEST} until 2026-11-28T10:00:00.000Z`,
			),
		)
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('"staff" is overridden'))
	})

	it('refuses an overridden remote whose entry the manifest puts on an unlisted origin', async () => {
		const { installRemoteOverrides, setRemoteOverride } = await freshOverrides()
		installInstance([])
		setRemoteOverride('assessments', MANIFEST)
		installRemoteOverrides()
		const { loadEntry } = installedPlugin()
		const info = (entry: string) => ({
			remoteInfo: { name: '__mfe_internal__assessments', alias: 'assessments', entry },
		})

		expect(() => loadEntry(info('https://evil.example/remoteEntry.js'))).toThrow(
			/not on a listed origin/,
		)
		expect(() => loadEntry(info('not a url'))).toThrow(/not on a listed origin/)
		expect(() => loadEntry(info('https://staging.example.com/remoteEntry.js'))).not.toThrow()
	})

	describe('the manifest snapshot', () => {
		async function overridden() {
			const { installRemoteOverrides, setRemoteOverride } = await freshOverrides()
			installInstance([])
			setRemoteOverride('assessments', MANIFEST)
			installRemoteOverrides()

			return (
				remoteSnapshot: object,
				moduleInfo = { name: 'assessments', entry: MANIFEST },
			) =>
				installedPlugin().loadRemoteSnapshot({
					moduleInfo,
					remoteSnapshot,
					manifestUrl: MANIFEST,
				})
		}

		it('refuses a publicPath on an unlisted origin, before any code is requested', async () => {
			const load = await overridden()

			expect(() => load({ publicPath: 'https://evil.example/' })).toThrow(
				'loads code from https://evil.example, which is not on a listed origin',
			)
			expect(() => load({ publicPath: 'https://staging.example.com:9000/' })).toThrow()
			expect(() => load({ publicPath: '//evil.example/' })).toThrow('evil.example')
		})

		it('allows a publicPath on a listed origin, a relative one, and auto', async () => {
			const load = await overridden()

			expect(() => load({ publicPath: 'https://staging.example.com/assets/' })).not.toThrow()
			expect(() => load({ publicPath: '/assets/' })).not.toThrow()
			expect(() => load({ publicPath: 'auto' })).not.toThrow()
			expect(() => load({})).not.toThrow()
		})

		it('refuses a public path computed at run time, which cannot be checked', async () => {
			const load = await overridden()

			expect(() => load({ getPublicPath: 'return "https://evil.example/"' })).toThrow(
				'computes its public path at run time',
			)
		})

		it('hands the arguments back, as a waterfall hook has to', async () => {
			const load = await overridden()
			const snapshot = { publicPath: 'auto' }

			expect(load(snapshot)).toMatchObject({ remoteSnapshot: snapshot })
		})

		it('leaves a remote with no override alone, whatever its manifest says', async () => {
			const load = await overridden()

			expect(() =>
				load(
					{ publicPath: 'https://cdn.other.example/' },
					{ name: 'staff', entry: MANIFEST },
				),
			).not.toThrow()
		})

		it('reads the manifest url from the module when the runtime gives none', async () => {
			const { installRemoteOverrides, setRemoteOverride } = await freshOverrides()
			installInstance([])
			setRemoteOverride('assessments', MANIFEST)
			installRemoteOverrides()

			expect(() =>
				installedPlugin().loadRemoteSnapshot({
					moduleInfo: { name: 'assessments', entry: MANIFEST },
					remoteSnapshot: { publicPath: '//evil.example/' },
				}),
			).toThrow('evil.example')
		})
	})

	it('leaves the entry of a remote with no override alone, wherever it is', async () => {
		const { installRemoteOverrides } = await freshOverrides()
		installInstance([])
		installRemoteOverrides()

		expect(() =>
			installedPlugin().loadEntry({
				remoteInfo: { name: 'staff', entry: 'https://cdn.other.example/remoteEntry.js' },
			}),
		).not.toThrow()
	})

	it('never reads an override from the url', async () => {
		const { installRemoteOverrides } = await freshOverrides()
		installInstance([])
		window.history.pushState(
			null,
			'',
			`/?spool:remote:assessments=${encodeURIComponent(MANIFEST)}`,
		)
		installRemoteOverrides()

		const { remote } = installedPlugin().beforeRegisterRemote({
			remote: {
				name: 'assessments',
				alias: 'assessments',
				entry: 'https://prod/mf-manifest.json',
			},
			origin: {},
		})

		expect(remote.entry).toBe('https://prod/mf-manifest.json')
	})
})
