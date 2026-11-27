/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import {
	MANIFEST_FILE,
	MANIFEST_VERSION,
	parseManifest,
	migrateManifest,
	emptyManifest,
	getApp,
	parseFramework,
	type AppConfig,
} from '../../core/config.js'
import { CliError } from '../../util/errors.js'
import { host, remote } from '../helpers.js'

/*
 *   HELPERS
 ***************************************************************************************************/
const parse = (extra: Record<string, unknown> = {}) =>
	parseManifest({ name: 'acme', version: 2, apps: {}, ...extra })

function failure(run: () => unknown): CliError {
	try {
		run()
	} catch (error) {
		if (error instanceof CliError) return error
	}

	throw new Error('expected a CliError')
}

/*
 *   MANIFEST FILE
 ***************************************************************************************************/
describe('MANIFEST_FILE', () => {
	it('is spool.json, at version 2', () => {
		expect(MANIFEST_FILE).toBe('spool.json')
		expect(MANIFEST_VERSION).toBe(2)
	})
})

/*
 *   EMPTY MANIFEST
 ***************************************************************************************************/
describe('emptyManifest', () => {
	it('applies the defaults', () => {
		expect(emptyManifest('acme')).toEqual({
			name: 'acme',
			version: 2,
			packageManager: 'pnpm',
			bundler: 'vite',
			shared: ['react', 'react-dom'],
			shareStrategy: 'loaded-first',
			csp: 'default',
			addons: [],
			apps: {},
		})
	})
})

/*
 *   PARSE MANIFEST
 ***************************************************************************************************/
describe('parseManifest', () => {
	it('points a version 1 file at spool upgrade, with MANIFEST_VERSION', () => {
		const error = failure(() => parseManifest({ name: 'acme', version: 1, apps: {} }))

		expect(error.code).toBe('MANIFEST_VERSION')
		expect(error.message).toContain('spool upgrade')
	})

	it('treats a missing version as version 1', () => {
		expect(failure(() => parseManifest({ name: 'acme', apps: {} })).code).toBe(
			'MANIFEST_VERSION',
		)
	})

	it('rejects a newer version with an upgrade hint', () => {
		const error = failure(() => parseManifest({ name: 'acme', version: 3, apps: {} }))

		expect(error.code).toBe('MANIFEST_VERSION')
		expect(error.message).toContain('Upgrade spool')
	})

	it('rejects anything that is not an object', () => {
		for (const raw of [null, 'x', 4, []]) {
			expect(failure(() => parseManifest(raw)).code).toBe('MANIFEST_INVALID')
		}
	})

	it('lists every problem in one MANIFEST_INVALID error', () => {
		const error = failure(() =>
			parse({
				packageManager: 'bun',
				apps: { x: host({ port: 70000 }), y: { type: 'widget' } },
			}),
		)

		expect(error.code).toBe('MANIFEST_INVALID')
		expect(error.message).toMatch(/packageManager/)
		expect(error.message).toMatch(/apps\.x\.port/)
		expect(error.message).toMatch(/apps\.y\.type/)
	})

	it('accepts per-environment urls on a remote', () => {
		const manifest = parse({
			apps: {
				dash: {
					...remote(),
					urls: { staging: 'https://staging.example.com/mf-manifest.json' },
				},
			},
		})

		expect(manifest.apps.dash!.urls).toEqual({
			staging: 'https://staging.example.com/mf-manifest.json',
		})
	})

	it('rejects a urls entry that is not an http url', () => {
		for (const url of ['not-a-url', 'ftp://example.com/x', 'javascript:alert(1)']) {
			expect(() =>
				parse({ apps: { dash: { ...remote(), urls: { staging: url } } } }),
			).toThrow(/apps\.dash\.urls\.staging/)
		}
	})

	it('fills per-app defaults for framework, remotes and exposes', () => {
		const manifest = parse({
			apps: { shell: { type: 'host', path: 'apps/shell', port: 5173 } },
		})

		expect(manifest.apps.shell).toEqual({
			type: 'host',
			framework: 'react',
			path: 'apps/shell',
			port: 5173,
			remotes: [],
			exposes: {},
		})
	})

	it('rejects a missing name', () => {
		expect(() => parseManifest({ version: 2, apps: {} })).toThrow(/name/)
	})

	it('rejects an unknown app type and framework', () => {
		expect(() =>
			parse({ apps: { x: { type: 'widget', path: 'apps/x', port: 5173 } } }),
		).toThrow(/apps\.x\.type/)
		expect(() => parse({ apps: { x: host({ framework: 'angular' as never }) } })).toThrow(
			/apps\.x\.framework/,
		)
	})

	it('rejects ports that are not whole numbers from 1 to 65535', () => {
		for (const port of [1.5, -1, 0, 70000, 'high']) {
			expect(() => parse({ apps: { x: { ...host(), port } } })).toThrow(/apps\.x\.port/)
		}
	})

	it('rejects an unknown top-level key instead of silently dropping it', () => {
		expect(() => parse({ sharde: ['react'] })).toThrow(/sharde/)
	})

	it('rejects a typoed app key such as "expose"', () => {
		expect(() =>
			parse({ apps: { dash: { ...remote(), expose: { './App': './src/app/app.tsx' } } } }),
		).toThrow(/expose/)
	})

	it('accepts a deploy command and rejects a non-string one', () => {
		const ok = parse({ apps: { dash: { ...remote(), deploy: 'wrangler pages deploy dist' } } })

		expect(ok.apps.dash?.deploy).toBe('wrangler pages deploy dist')
		expect(() => parse({ apps: { dash: { ...remote(), deploy: 42 } } })).toThrow(
			/apps\.dash\.deploy/,
		)
	})

	it('accepts deployEnv secret names and rejects bad or repeated ones', () => {
		const ok = parse({ apps: { dash: { ...remote(), deployEnv: ['CF_TOKEN', 'CF_ACCOUNT'] } } })

		expect(ok.apps.dash?.deployEnv).toEqual(['CF_TOKEN', 'CF_ACCOUNT'])
		expect(() => parse({ apps: { dash: { ...remote(), deployEnv: ['lower'] } } })).toThrow(
			/deployEnv/,
		)
		expect(() => parse({ apps: { dash: { ...remote(), deployEnv: ['A', 'A'] } } })).toThrow(
			/more than once/,
		)
	})

	it('accepts a deployed url on a remote and rejects a malformed one', () => {
		const ok = parse({
			apps: { dash: { ...remote(), url: 'https://cdn.example.com/mf-manifest.json' } },
		})

		expect(ok.apps.dash?.url).toBe('https://cdn.example.com/mf-manifest.json')
		expect(() => parse({ apps: { dash: { ...remote(), url: 'not a url' } } })).toThrow(
			/apps\.dash\.url/,
		)
	})

	it('rejects credentials in url and urls, which would ship in the public bundle', () => {
		const url = 'https://user:pass@cdn.example.com/mf-manifest.json'

		expect(() => parse({ apps: { dash: { ...remote(), url } } })).toThrow(
			/apps.dash.url.*username/,
		)
		expect(() => parse({ apps: { dash: { ...remote(), urls: { staging: url } } } })).toThrow(
			/apps.dash.urls.staging.*username/,
		)
	})

	it('keeps a __proto__ key as a plain key instead of setting the prototype', () => {
		const proxy = JSON.parse('{"__proto__": "http://localhost:9"}') as Record<string, string>
		const manifest = parse({ server: { proxy } })

		expect(Object.getPrototypeOf(manifest.server?.proxy)).toBeNull()
		expect(Object.keys(manifest.server?.proxy ?? {})).toEqual(['__proto__'])
	})

	it('reports the offending path in a readable message', () => {
		expect(() => parse({ apps: { dash: { ...remote(), port: 'high' } } })).toThrow(
			/apps\.dash\.port/,
		)
	})

	it('rejects the rspack bundler', () => {
		expect(() => parse({ bundler: 'rspack' })).toThrow(/bundler/)
	})

	it('accepts the csp mode and rejects an unknown one', () => {
		expect(parse({ csp: 'strict' }).csp).toBe('strict')
		expect(() => parse({ csp: 'loose' })).toThrow(/csp/)
	})
})

/*
 *   NAMES IN THE MANIFEST
 ***************************************************************************************************/
describe('names in the manifest', () => {
	it('rejects a workspace name that is a path or a device name', () => {
		for (const name of ['../evil', 'a/b', 'con', 'nul', 'COM1']) {
			expect(() => parseManifest({ name, version: 2, apps: {} })).toThrow(/name/)
		}
	})

	it('rejects an app key that is not a safe name', () => {
		for (const key of ['a/b', '..', 'con', 'lpt1', 'react', 'Bad']) {
			expect(() => parse({ apps: { [key]: host() } })).toThrow(/apps\./)
		}
	})

	it('rejects an app named after a package the workspace shares', () => {
		expect(() => parse({ shared: ['react', 'lodash'], apps: { lodash: host() } })).toThrow(
			/shared package/,
		)
	})
})

/*
 *   HEADERS, FRAME ANCESTORS, OVERRIDES
 ***************************************************************************************************/
describe('headers, frameAncestors and overrides', () => {
	it('accepts per-app headers and frameAncestors', () => {
		const manifest = parse({
			apps: {
				shell: {
					...host(),
					headers: { 'X-Frame-Options': 'DENY' },
					frameAncestors: ['self'],
				},
			},
		})

		expect(manifest.apps.shell!.headers).toEqual({ 'X-Frame-Options': 'DENY' })
		expect(manifest.apps.shell!.frameAncestors).toEqual(['self'])
	})

	it('rejects a non-string header value', () => {
		expect(() => parse({ apps: { shell: { ...host(), headers: { 'X-Test': 42 } } } })).toThrow(
			/headers/,
		)
	})

	it('rejects a header name or value that would add lines to _headers', () => {
		expect(() =>
			parse({ apps: { shell: { ...host(), headers: { 'X-A\nX-B': 'x' } } } }),
		).toThrow(/valid header name/)
		expect(() =>
			parse({ apps: { shell: { ...host(), headers: { 'X-A': 'x\r\nSet-Cookie: a=b' } } } }),
		).toThrow(/line breaks/)
		expect(() => parse({ server: { headers: { 'X-A': 'x\ny' } }, apps: {} })).toThrow(
			/line breaks/,
		)
	})

	it('rejects a frame ancestor that would add directives', () => {
		for (const source of ['https://a.test; script-src *', 'a b', 'a,b', '']) {
			expect(() =>
				parse({ apps: { shell: { ...host(), frameAncestors: [source] } } }),
			).toThrow(/frameAncestors/)
		}
	})

	it('leaves overrides out by default and accepts a list of origins', () => {
		expect(emptyManifest('acme').overrides).toBeUndefined()
		expect(
			parse({ overrides: { origins: ['https://staging.example.com'] } }).overrides,
		).toEqual({ origins: ['https://staging.example.com'] })
	})

	it('rejects the version 1 overrides flag and origins that are not origins', () => {
		expect(() => parse({ overrides: true })).toThrow(/overrides/)
		for (const origin of [
			'https://a.test/path',
			'https://a.test/',
			'a.test',
			'ftp://a.test',
			'https://user:pass@a.test',
		]) {
			expect(() => parse({ overrides: { origins: [origin] } })).toThrow(/overrides\.origins/)
		}
	})
})

/*
 *   SERVER
 ***************************************************************************************************/
describe('server.cors', () => {
	it('takes a list of origins', () => {
		expect(parse({ server: { cors: ['http://localhost:3000'] } }).server?.cors).toEqual([
			'http://localhost:3000',
		])
	})

	it('rejects the version 1 boolean and bad origins', () => {
		expect(() => parse({ server: { cors: true } })).toThrow(/spool upgrade/)
		expect(() => parse({ server: { cors: ['*'] } })).toThrow(/server\.cors\.0/)
	})
})

describe('server.fs.allow', () => {
	const withAllow = (allow: unknown) => parse({ server: { fs: { allow } } })

	it('accepts relative, parent and absolute folders', () => {
		const allow = ['../contracts/packages', 'vendor', '/srv/shared', 'D:\\shared']

		expect(withAllow(allow).server?.fs?.allow).toEqual(allow)
	})

	it('is absent unless set', () => {
		expect(parse({ server: { host: true } }).server).toEqual({ host: true })
	})

	it('rejects an empty or blank entry', () => {
		expect(() => withAllow([''])).toThrow(/server\.fs\.allow\.0: cannot be empty/)
		expect(() => withAllow(['  '])).toThrow(/cannot be empty/)
	})

	it('rejects the filesystem root, posix or windows', () => {
		for (const root of ['/', '\\', 'C:', 'C:\\', 'c:/']) {
			expect(() => withAllow([root])).toThrow(/filesystem root/)
		}
	})

	it('rejects a non-array, a non-string entry and unknown fs keys', () => {
		expect(() => withAllow('../contracts')).toThrow()
		expect(() => withAllow([42])).toThrow()
		expect(() => parse({ server: { fs: { allow: [], deny: ['.env'] } } })).toThrow(/deny/)
	})
})

describe('server.proxy', () => {
	it('takes a target string or a strict entry', () => {
		const manifest = parse({
			server: {
				proxy: {
					'/api': 'http://localhost:4000',
					'/ws': { target: 'http://localhost:4001', ws: true },
				},
			},
		})

		expect(manifest.server?.proxy?.['/ws']).toEqual({
			target: 'http://localhost:4001',
			ws: true,
		})
		expect(() => parse({ server: { proxy: { '/a': { target: 'x', nope: 1 } } } })).toThrow(
			/nope/,
		)
	})
})

/*
 *   ADDONS
 ***************************************************************************************************/
describe('addons', () => {
	it('accepts every known addon name', () => {
		const manifest = parse({
			addons: [
				'navigation',
				'sentry',
				'test',
				'lint',
				'turbo',
				'state',
				'ladle',
				'playwright',
			],
		})

		expect(manifest.addons).toHaveLength(8)
	})

	it('ignores "federation", which every host has now, instead of failing a file that lists it', () => {
		expect(parse({ addons: ['federation', 'sentry'] }).addons).toEqual(['sentry'])
	})

	it('rejects an unknown addon name, including the retired "shell"', () => {
		expect(() => parse({ addons: ['bogus'] })).toThrow(/addons\.0/)
		expect(() => parse({ addons: ['shell'] })).toThrow(/addons\.0/)
	})
})

/*
 *   APP PATHS
 ***************************************************************************************************/
describe('app path confinement', () => {
	const withPath = (path: string) => () => parse({ apps: { shell: { ...host(), path } } })

	it('accepts nested lowercase paths', () => {
		expect(parse({ apps: { shell: { ...host(), path: 'packages/web/shell' } } })).toBeDefined()
	})

	it('rejects absolute, drive, UNC and drive-relative paths', () => {
		for (const path of [
			'/etc/apps/shell',
			'C:\\apps',
			'C:/apps',
			'\\\\server\\share',
			'C:foo',
		]) {
			expect(withPath(path)).toThrow(/apps\.shell\.path/)
		}
	})

	it('rejects ".." segments, a trailing slash and an alternate data stream', () => {
		for (const path of ['../outside', 'apps/../x', '..', 'apps/shell/', 'apps/shell:stream']) {
			expect(withPath(path)).toThrow(/apps\.shell\.path/)
		}
	})

	it('rejects uppercase, odd characters and Windows device segments', () => {
		for (const path of ['Apps/Shell', 'apps/sh ell', 'apps/con', 'apps/aux.txt', 'nul']) {
			expect(withPath(path)).toThrow(/apps\.shell\.path/)
		}
	})
})

/*
 *   REMOTES
 ***************************************************************************************************/
describe('remotes validation', () => {
	it('rejects an app that lists itself as a remote', () => {
		expect(() => parse({ apps: { shell: host({ remotes: ['shell'] }) } })).toThrow(
			/lists itself/,
		)
	})

	it('rejects a remote listed twice', () => {
		expect(() =>
			parse({
				apps: { shell: host({ remotes: ['dashboard', 'dashboard'] }), dashboard: remote() },
			}),
		).toThrow(/more than once/)
	})

	it('rejects a remote that is not in the manifest', () => {
		expect(() => parse({ apps: { shell: host({ remotes: ['ghost'] }) } })).toThrow(
			/not in this workspace/,
		)
	})

	it('detects and reports a two-app cycle', () => {
		expect(() =>
			parse({
				apps: {
					a: remote({ path: 'apps/a', port: 1, remotes: ['b'] }),
					b: remote({ path: 'apps/b', port: 2, remotes: ['a'] }),
				},
			}),
		).toThrow(/cycle: a -> b -> a/)
	})

	it('allows a remote that consumes another remote, with no cycle', () => {
		const manifest = parse({
			apps: {
				shell: host({ remotes: ['dashboard'] }),
				dashboard: remote({ remotes: ['widget'] }),
				widget: remote({ path: 'apps/widget', port: 5175 }),
			},
		})

		expect(manifest.apps.dashboard!.remotes).toEqual(['widget'])
	})
})

/*
 *   EXPOSES
 ***************************************************************************************************/
describe('exposes validation', () => {
	const withExpose = (key: string, source: string) => () =>
		parse({ apps: { dash: { ...remote(), exposes: { [key]: source } } } })

	it('accepts the keys and sources spool scaffolds', () => {
		expect(withExpose('./App', './src/app/app.tsx')).not.toThrow()
		expect(withExpose('./widgets/Card', 'src/Card.vue')).not.toThrow()
	})

	it('rejects a key that does not start with "./"', () => {
		expect(withExpose('App', './src/app/app.tsx')).toThrow(/must start with/)
	})

	it('rejects a source that escapes the app folder', () => {
		for (const source of [
			'../shared/App.tsx',
			'/abs/App.tsx',
			'C:\\x.tsx',
			'C:x.tsx',
			'\\\\h\\s',
		]) {
			expect(withExpose('./App', source)).toThrow(/apps\.dash\.exposes/)
		}
	})

	it('rejects a Windows device name as a source segment', () => {
		expect(withExpose('./App', './src/con/app.tsx')).toThrow(/Windows reserves/)
	})
})

/*
 *   APP PORT
 ***************************************************************************************************/
describe('getApp', () => {
	it('returns the port of a known app', () => {
		expect(getApp(parse({ apps: { dashboard: remote() } }), 'dashboard').port).toBe(5174)
	})

	it('throws APP_NOT_FOUND for an unknown app', () => {
		const error = failure(() => getApp(emptyManifest('acme'), 'ghost'))

		expect(error.code).toBe('APP_NOT_FOUND')
		expect(error.message).toContain('No app named "ghost"')
	})
})

describe('parseFramework', () => {
	it('returns known frameworks and throws INVALID_VALUE for others', () => {
		expect(parseFramework('vue')).toBe('vue')
		expect(failure(() => parseFramework('angular')).code).toBe('INVALID_VALUE')
	})
})

describe('AppConfig typing', () => {
	it('accepts host and remote shapes from the factories', () => {
		const apps: AppConfig[] = [host(), remote()]

		expect(apps).toHaveLength(2)
	})
})

describe('frameAncestors edge token', () => {
	it('accepts edge on its own', () => {
		const manifest = parse({ apps: { shell: { ...host(), frameAncestors: ['edge'] } } })

		expect(manifest.apps.shell!.frameAncestors).toEqual(['edge'])
	})

	it('rejects edge mixed with origins', () => {
		expect(() =>
			parse({ apps: { shell: { ...host(), frameAncestors: ['edge', 'https://a.test'] } } }),
		).toThrow(/stands alone/)
	})
})

/*
 *   VERSION 1 MIGRATION
 ***************************************************************************************************/
describe('migrateManifest', () => {
	const v1 = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
		name: 'acme',
		version: 1,
		apps: { shell: host(), dash: remote() },
		...extra,
	})

	it('drops svelte and its subpaths from shared, with a note', () => {
		const { manifest, changes } = migrateManifest(
			v1({ shared: ['react', 'svelte', 'svelte/internal/client', 'vue'] }),
		)

		expect(manifest.shared).toEqual(['react', 'vue'])
		expect(changes.join(' ')).toContain('removed svelte from shared')
	})

	it('moves a version 1 file to a version 2 file that parses', () => {
		const { manifest, changes } = migrateManifest(v1())

		expect(manifest.version).toBe(2)
		expect(changes[0]).toContain('version 1 -> 2')
		expect(parseManifest(manifest).name).toBe('acme')
	})

	it('treats a file with no version as version 1', () => {
		const { manifest } = migrateManifest({ name: 'acme', apps: {} })

		expect(manifest.version).toBe(2)
	})

	it('leaves the input alone', () => {
		const raw = v1({ overrides: true })

		migrateManifest(raw)
		expect(raw.version).toBe(1)
		expect(raw.overrides).toBe(true)
	})

	it('returns a version 2 file unchanged, with nothing to report', () => {
		const raw = { name: 'acme', version: 2, apps: {} }

		expect(migrateManifest(raw)).toEqual({ manifest: raw, changes: [] })
	})

	it('turns overrides true into an empty origins list and drops false', () => {
		const on = migrateManifest(v1({ overrides: true }))
		const off = migrateManifest(v1({ overrides: false }))

		expect(on.manifest.overrides).toEqual({ origins: [] })
		expect(on.changes.join(' ')).toMatch(/overrides true/)
		expect('overrides' in off.manifest).toBe(false)
	})

	it('narrows server.cors true to the origin of every app, and drops false', () => {
		const on = migrateManifest(v1({ server: { cors: true, host: true } }))
		const off = migrateManifest(v1({ server: { cors: false } }))

		expect(on.manifest.server).toEqual({
			host: true,
			cors: ['http://localhost:5173', 'http://localhost:5174'],
		})
		expect(on.changes.join(' ')).toMatch(/server\.cors true/)
		expect(off.manifest.server).toEqual({})
		expect(parseManifest(on.manifest).server?.cors).toHaveLength(2)
	})

	it('splits the "shell" addon and drops the rspack bundler', () => {
		const { manifest, changes } = migrateManifest(
			v1({ addons: ['shell', 'federation'], bundler: 'rspack' }),
		)

		expect(manifest.addons).toEqual(['navigation'])
		expect('bundler' in manifest).toBe(false)
		expect(changes.join(' ')).toMatch(/shell/)
		expect(changes.join(' ')).toMatch(/rspack/)
	})

	it('drops the "federation" addon from a version 1 file, with a note', () => {
		const { manifest, changes } = migrateManifest(v1({ addons: ['federation', 'sentry'] }))

		expect(manifest.addons).toEqual(['sentry'])
		expect(changes.join(' ')).toMatch(/federation/)
		expect(parseManifest(manifest).addons).toEqual(['sentry'])
	})

	it('rejects a version it does not know, and a file that is not an object', () => {
		expect(failure(() => migrateManifest({ version: 9 })).code).toBe('MANIFEST_VERSION')
		expect(failure(() => migrateManifest([])).code).toBe('MANIFEST_INVALID')
	})
})
