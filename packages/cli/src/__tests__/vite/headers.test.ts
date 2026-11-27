/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi } from 'vitest'
import { parseManifest, type Manifest } from '../../core/config.js'
import {
	contentSecurityPolicy,
	headerRules,
	headersFile,
	rulesMiddleware,
	serverHeaders,
	strictSources,
} from '../../vite/headers.js'
import { OVERRIDE_ORIGINS_DEFINE, overrideOrigins, spoolPlugin } from '../../vite/plugin.js'
import { host, remote } from '../helpers.js'

/*
 *   HELPERS
 ***************************************************************************************************/
/** A spool.json as the plugin reads it: through the real parser. */
function workspace(extra: Record<string, unknown> = {}, apps?: Record<string, unknown>): Manifest {
	return parseManifest({
		name: 'acme',
		version: 2,
		apps: apps ?? {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote({ url: 'https://cdn.example.com/dashboard/mf-manifest.json' }),
		},
		...extra,
	})
}

const shell = (manifest: Manifest) => manifest.apps.shell!
const dashboard = (manifest: Manifest) => manifest.apps.dashboard!

/*
 *   CONTENT SECURITY POLICY
 ***************************************************************************************************/
describe('contentSecurityPolicy', () => {
	it('gives every app frame-ancestors, object-src none and base-uri self', () => {
		const manifest = workspace()

		expect(contentSecurityPolicy(manifest, shell(manifest), { mode: 'build' })).toBe(
			"frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
		)
	})

	it('writes self and none as keywords and origins as they are', () => {
		const manifest = workspace(
			{},
			{ shell: host({ frameAncestors: ['self', 'https://portal.example.com'] }) },
		)

		expect(contentSecurityPolicy(manifest, shell(manifest), { mode: 'build' })).toContain(
			"frame-ancestors 'self' https://portal.example.com;",
		)
	})

	it('leaves frame-ancestors to the edge but still sends the rest', () => {
		const manifest = workspace({}, { shell: host({ frameAncestors: ['edge'] }) })
		const policy = contentSecurityPolicy(manifest, shell(manifest), { mode: 'build' })

		expect(policy).not.toContain('frame-ancestors')
		expect(policy).toBe("object-src 'none'; base-uri 'self'")
	})

	it('adds script-src and connect-src for self, the remotes and the override origins with csp strict', () => {
		const manifest = workspace({
			csp: 'strict',
			overrides: { origins: ['https://staging.example.com'] },
		})
		const policy = contentSecurityPolicy(manifest, shell(manifest), { mode: 'build' })

		const sources = "'self' https://cdn.example.com https://staging.example.com"
		expect(policy).toContain(`script-src ${sources}`)
		expect(policy).toContain(`connect-src ${sources}`)
	})

	it('includes every environment url and the SPOOL_REMOTE override of a remote', () => {
		const manifest = workspace(
			{ csp: 'strict' },
			{
				shell: host({ remotes: ['dashboard'] }),
				dashboard: remote({
					url: 'https://cdn.example.com/mf-manifest.json',
					urls: { staging: 'https://staging.example.net/mf-manifest.json' },
				}),
			},
		)

		expect(
			strictSources(manifest, shell(manifest), {
				SPOOL_REMOTE_DASHBOARD: 'https://canary.example.org/mf-manifest.json',
			}),
		).toEqual([
			'https://cdn.example.com',
			'https://staging.example.net',
			'https://canary.example.org',
		])
	})

	it('adds nothing strict by default, or in a dev server where HMR needs inline scripts', () => {
		const manifest = workspace({ csp: 'strict' })
		const loose = workspace()

		expect(contentSecurityPolicy(loose, shell(loose), { mode: 'build' })).not.toContain(
			'script-src',
		)
		expect(contentSecurityPolicy(manifest, shell(manifest), { mode: 'dev' })).not.toContain(
			'script-src',
		)
	})
})

/*
 *   _HEADERS FILE
 ***************************************************************************************************/
describe('headersFile', () => {
	it('sends the policy on every page', () => {
		const manifest = workspace()
		const file = headersFile('shell', manifest, shell(manifest))

		expect(file).toContain(
			'/*\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: frame-ancestors',
		)
		expect(file).toContain("object-src 'none'")
		expect(file).toContain("base-uri 'self'")
	})

	it('lets a remote be loaded from other origins, and a host not', () => {
		const manifest = workspace()

		expect(headersFile('dashboard', manifest, dashboard(manifest))).toContain(
			'/mf-manifest.json\n  Access-Control-Allow-Origin: *',
		)
		expect(headersFile('shell', manifest, shell(manifest))).not.toContain(
			'Access-Control-Allow-Origin',
		)
	})

	it('caches the manifest and entry never and the assets for good', () => {
		const manifest = workspace()
		const file = headersFile('dashboard', manifest, dashboard(manifest))

		expect(file).toMatch(/\/mf-manifest\.json[^]*?Cache-Control: no-cache/)
		expect(file).toMatch(/\/remoteEntry\.js[^]*?Cache-Control: no-cache/)
		expect(file).toContain(
			'/assets/*\n  Access-Control-Allow-Origin: *\n  Cache-Control: public, max-age=31536000, immutable',
		)
	})

	it('appends the headers from spool.json, and says when the edge owns frame-ancestors', () => {
		const manifest = workspace(
			{},
			{ shell: host({ headers: { 'X-Frame-Options': 'DENY' }, frameAncestors: ['edge'] }) },
		)
		const file = headersFile('shell', manifest, shell(manifest))

		expect(file).toContain('  X-Frame-Options: DENY')
		expect(file).toContain('# frame-ancestors is set by the edge for this app.')
		expect(file).not.toContain("frame-ancestors '")
	})

	it('follows spool.json: changing frameAncestors or csp changes the file', () => {
		const before = workspace()
		const after = workspace(
			{ csp: 'strict' },
			{
				shell: host({
					remotes: ['dashboard'],
					frameAncestors: ['https://portal.example.com'],
				}),
				dashboard: remote({ url: 'https://cdn.example.com/mf-manifest.json' }),
			},
		)

		expect(headersFile('shell', before, shell(before))).not.toContain('portal.example.com')
		const file = headersFile('shell', after, shell(after))
		expect(file).toContain('frame-ancestors https://portal.example.com')
		expect(file).toContain('script-src')
	})

	describe('header injection', () => {
		it('is rejected when spool.json is parsed, so no file is written', () => {
			for (const headers of [
				{ 'X-A\nX-B': 'x' },
				{ 'X-A': 'x\nSet-Cookie: a=b' },
				{ 'X-A': 'x\r\n\r\n<script>' },
				{ 'X A': 'x' },
				{ '': 'x' },
			]) {
				expect(() => workspace({}, { shell: host({ headers }) })).toThrow(/headers/)
			}
		})

		it('is rejected by the writer too, for a manifest built around the parser', () => {
			const manifest = workspace()
			const app = { ...shell(manifest), headers: { 'X-A': 'x\nSet-Cookie: a=b' } }

			expect(() => headersFile('shell', manifest, app)).toThrow('split headers')
		})

		it('is rejected in frameAncestors, which end up in the policy', () => {
			expect(() =>
				workspace({}, { shell: host({ frameAncestors: ["'self'; script-src *"] }) }),
			).toThrow(/frameAncestors/)
		})
	})
})

/*
 *   DEV SERVER HEADERS
 ***************************************************************************************************/
describe('serverHeaders', () => {
	it('sends nosniff and the policy, with app headers over them and server headers last', () => {
		const manifest = workspace(
			{ server: { headers: { 'X-Team': 'platform', 'X-App': 'server' } } },
			{ shell: host({ headers: { 'X-App': 'app' } }) },
		)

		expect(serverHeaders(manifest, shell(manifest))).toEqual({
			'X-Content-Type-Options': 'nosniff',
			'Content-Security-Policy': "frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
			'X-App': 'server',
			'X-Team': 'platform',
		})
	})
})

/*
 *   PLUGIN
 ***************************************************************************************************/
describe('spoolPlugin', () => {
	it('defines the override origins from spool.json', () => {
		const manifest = workspace({ overrides: { origins: ['https://staging.example.com'] } })
		const plugin = spoolPlugin('shell', manifest, shell(manifest))

		expect(plugin.config().define).toEqual({
			[OVERRIDE_ORIGINS_DEFINE]: '["https://staging.example.com"]',
		})
	})

	it('defines an empty list when overrides are off', () => {
		const manifest = workspace()
		const plugin = spoolPlugin('shell', manifest, shell(manifest))

		expect(OVERRIDE_ORIGINS_DEFINE).toBe('__SPOOL_OVERRIDE_ORIGINS__')
		expect(plugin.config().define[OVERRIDE_ORIGINS_DEFINE]).toBe('[]')
	})

	it("adds every app's localhost origin to the override origins in dev, so local overrides need no config", () => {
		const manifest = workspace({ overrides: { origins: ['https://staging.example.com'] } })
		const serve = spoolPlugin('shell', manifest, shell(manifest), 'serve')

		expect(JSON.parse(serve.config().define[OVERRIDE_ORIGINS_DEFINE]!)).toEqual([
			'https://staging.example.com',
			'http://localhost:5173',
			'http://localhost:5174',
		])
	})

	it('adds the local origins in dev even when overrides are not configured', () => {
		const manifest = workspace()
		const serve = spoolPlugin('shell', manifest, shell(manifest), 'serve')

		expect(JSON.parse(serve.config().define[OVERRIDE_ORIGINS_DEFINE]!)).toEqual([
			'http://localhost:5173',
			'http://localhost:5174',
		])
	})

	it('keeps a build to overrides.origins alone: no localhost in production', () => {
		const manifest = workspace({ overrides: { origins: ['https://staging.example.com'] } })
		const build = spoolPlugin('shell', manifest, shell(manifest), 'build')

		expect(overrideOrigins(manifest, 'build')).toEqual(['https://staging.example.com'])
		expect(build.config().define[OVERRIDE_ORIGINS_DEFINE]).toBe(
			'["https://staging.example.com"]',
		)
		expect(build.config().define[OVERRIDE_ORIGINS_DEFINE]).not.toContain('localhost')
	})

	it('does not list an origin twice when overrides already name a local app', () => {
		const manifest = workspace({ overrides: { origins: ['http://localhost:5174'] } })

		expect(overrideOrigins(manifest, 'serve')).toEqual([
			'http://localhost:5174',
			'http://localhost:5173',
		])
	})

	it('emits _headers into the bundle from spool.json', () => {
		const manifest = workspace()
		const plugin = spoolPlugin('dashboard', manifest, dashboard(manifest))
		const emitted: { type: string; fileName: string; source: string }[] = []

		plugin.generateBundle.call({
			emitFile: file => {
				emitted.push(file)

				return 'ref'
			},
		})

		expect(emitted).toHaveLength(1)
		expect(emitted[0]).toMatchObject({ type: 'asset', fileName: '_headers' })
		expect(emitted[0]!.source).toBe(headersFile('dashboard', manifest, dashboard(manifest)))
	})
})

/*
 *   SENTRY AND PER-MODE RULES
 ***************************************************************************************************/
describe('strict csp with a Sentry DSN', () => {
	it('adds the ingest origin to connect-src only', () => {
		const manifest = workspace({ csp: 'strict' })
		const policy = contentSecurityPolicy(manifest, shell(manifest), {
			mode: 'build',
			connectOrigins: ['https://o1.ingest.sentry.io'],
		})

		expect(policy).toMatch(/connect-src [^;]*https:\/\/o1\.ingest\.sentry\.io/)
		expect(policy).not.toMatch(/script-src [^;]*sentry/)
	})

	it('is unchanged when no origins are given', () => {
		const manifest = workspace({ csp: 'strict' })

		expect(contentSecurityPolicy(manifest, shell(manifest), { mode: 'build' })).not.toContain(
			'sentry',
		)
	})

	it('reaches the emitted _headers through the plugin from the DSN in the environment', () => {
		const manifest = workspace({ csp: 'strict', addons: ['sentry'] })
		const plugin = spoolPlugin('shell', manifest, shell(manifest), 'build', {
			root: process.cwd(),
			env: { VITE_SENTRY_DSN: 'https://pubkey@o1.ingest.sentry.io/1' },
		})
		let source = ''

		plugin.generateBundle.call({
			emitFile: file => {
				source = file.source

				return 'ref'
			},
		})

		expect(source).toContain('https://o1.ingest.sentry.io')
	})
})

describe('headerRules', () => {
	it('gives preview the strict policy and the caching a static host applies', () => {
		const manifest = workspace({ csp: 'strict' })
		const rules = headerRules(manifest, shell(manifest), { mode: 'preview' })
		const all = rules.find(rule => rule.path === '/*')!
		const assets = rules.find(rule => rule.path === '/assets/*')!

		expect(all.headers['Content-Security-Policy']).toContain('script-src')
		expect(assets.headers['Cache-Control']).toContain('immutable')
	})

	it('keeps dev loose enough for hot reload but still sets the manifest headers', () => {
		const manifest = workspace({ csp: 'strict' })
		const rules = headerRules(manifest, dashboard(manifest), { mode: 'dev' })
		const manifestRule = rules.find(rule => rule.path === '/mf-manifest.json')!
		const all = rules.find(rule => rule.path === '/*')!

		expect(all.headers['Content-Security-Policy']).not.toContain('script-src')
		expect(rules.some(rule => rule.path === '/assets/*')).toBe(false)
		expect(manifestRule.headers['Cache-Control']).toBe('no-cache')
	})

	it('sets the matching rules on a request path the way _headers reads them', () => {
		const manifest = workspace()
		const headers: Record<string, string> = {}
		const middleware = rulesMiddleware(
			headerRules(manifest, shell(manifest), { mode: 'preview' }),
		)

		middleware(
			{ url: '/assets/index-abc.js?v=1' },
			{ setHeader: (key, value) => (headers[key] = value) },
			() => undefined,
		)

		expect(headers['Cache-Control']).toContain('immutable')
		expect(headers['X-Content-Type-Options']).toBe('nosniff')
	})
})

describe('plugin servers', () => {
	it('registers the headers middleware for dev and preview', () => {
		const manifest = workspace()
		const plugin = spoolPlugin('shell', manifest, shell(manifest))
		const used: unknown[] = []
		const server = { middlewares: { use: (handler: unknown) => used.push(handler) } }

		plugin.configureServer(server)
		plugin.configurePreviewServer(server)

		expect(used).toHaveLength(2)
	})
})

/*
 *   SERVER ORDER AND PREVIEW HEADERS
 ***************************************************************************************************/
describe('plugin and the servers it sits in', () => {
	it('runs first, so its middleware is registered before the federation manifest one', () => {
		const manifest = workspace()

		expect(spoolPlugin('shell', manifest, shell(manifest)).enforce).toBe('pre')
	})

	it('puts the strict policy and the Sentry origin in preview.headers, which vite applies last', () => {
		const manifest = workspace({ csp: 'strict', addons: ['sentry'] })
		const plugin = spoolPlugin('shell', manifest, shell(manifest), 'serve', {
			root: process.cwd(),
			env: { VITE_SENTRY_DSN: 'https://pubkey@o1.ingest.sentry.io/1' },
		})
		const { headers } = plugin.config().preview

		expect(headers['Content-Security-Policy']).toContain('script-src')
		expect(headers['Content-Security-Policy']).toContain('https://o1.ingest.sentry.io')
		expect(headers['X-Content-Type-Options']).toBe('nosniff')
	})

	it('keeps the custom headers in preview.headers', () => {
		const manifest = workspace({}, { shell: host({ headers: { 'X-QA': 'yes' } }) })
		const plugin = spoolPlugin('shell', manifest, shell(manifest))

		expect(plugin.config().preview.headers['X-QA']).toBe('yes')
	})

	it('serves the manifest and entry headers in dev: nosniff, no-cache, custom headers, plain CSP', () => {
		const manifest = workspace(
			{ csp: 'strict' },
			{ dashboard: remote({ headers: { 'X-QA': 'yes' } }) },
		)
		const headers: Record<string, string> = {}
		const middleware = rulesMiddleware(
			headerRules(manifest, dashboard(manifest), { mode: 'dev' }),
		)

		for (const url of ['/mf-manifest.json', '/remoteEntry.js?t=1']) {
			middleware(
				{ url },
				{ setHeader: (key, value) => (headers[key] = value) },
				() => undefined,
			)

			expect(headers['Cache-Control']).toBe('no-cache')
			expect(headers['X-Content-Type-Options']).toBe('nosniff')
			expect(headers['X-QA']).toBe('yes')
			expect(headers['Content-Security-Policy']).not.toContain('script-src')
		}
	})
})

/*
 *   PREVIEW WITHOUT A DSN
 ***************************************************************************************************/
describe('preview with strict csp, sentry and no DSN in an .env file', () => {
	const sentry = (extra: Record<string, unknown> = {}) =>
		workspace({ csp: 'strict', addons: ['sentry'], ...extra })

	it('warns that connect-src leaves Sentry out', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const manifest = sentry()
		const plugin = spoolPlugin('shell', manifest, shell(manifest), 'serve', {
			root: process.cwd(),
			env: {},
		})

		plugin.config({}, { isPreview: true })

		expect(warn).toHaveBeenCalledWith(expect.stringContaining('connect-src leaves out Sentry'))
		warn.mockRestore()
	})

	it('stays quiet in dev, without strict csp, or when the DSN is known', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		const strict = sentry()
		const loose = workspace({ addons: ['sentry'] })
		const withDsn = spoolPlugin('shell', strict, shell(strict), 'serve', {
			root: process.cwd(),
			env: { VITE_SENTRY_DSN: 'https://k@o1.ingest.sentry.io/1' },
		})

		spoolPlugin('shell', strict, shell(strict), 'serve', {
			root: process.cwd(),
			env: {},
		}).config({}, {})
		spoolPlugin('shell', loose, shell(loose), 'serve', {
			root: process.cwd(),
			env: {},
		}).config({}, { isPreview: true })
		withDsn.config({}, { isPreview: true })

		expect(warn).not.toHaveBeenCalled()
		warn.mockRestore()
	})
})
