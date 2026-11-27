/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spoolApp } from '../../vite/app.js'
import { host, remote, makeManifest, freshDir, removeDir } from '../helpers.js'

/*
 *   FIXTURE
 ***************************************************************************************************/
const manifest = makeManifest({
	shell: host({ remotes: ['dashboard', 'billing'] }),
	dashboard: remote(),
	billing: remote({
		path: 'apps/billing',
		port: 5175,
		url: 'https://cdn.example.com/mf-manifest.json',
		urls: { staging: 'https://staging.example.com/mf-manifest.json' },
	}),
})

let dir: string

/** Shared entries only survive when the app declares them, so plant a package.json. */
function plantDeclaredDeps(root: string, deps: string[]) {
	writeFileSync(
		join(root, 'package.json'),
		JSON.stringify({ dependencies: Object.fromEntries(deps.map(dep => [dep, '*'])) }),
	)
}

/** A workspace folder holding this spool.json, with the shared deps declared. */
function workspace(spool: unknown, deps = ['react', 'react-dom']): string {
	const root = freshDir('spool-vite-')
	plantDeclaredDeps(root, deps)
	writeFileSync(join(root, 'spool.json'), JSON.stringify(spool))

	return root
}

beforeAll(() => {
	dir = workspace(manifest)
})

afterAll(() => {
	removeDir(dir)
})

afterEach(() => {
	delete process.env.SPOOL_REMOTE_DASHBOARD
	delete process.env.SPOOL_ENV
})

/*
 *   SPOOL APP
 ***************************************************************************************************/
describe('spoolApp', () => {
	it('derives a host config with local dev URLs for its remotes', () => {
		const app = spoolApp('shell', { root: dir })

		expect(app.server).toMatchObject({ port: 5173, strictPort: true })
		expect(app.server.cors).toEqual({
			origin: ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
		})
		expect(app.server.headers).toMatchObject({ 'X-Content-Type-Options': 'nosniff' })
		expect(app.federation.name).toBe('shell')
		expect(app.federation.remotes?.dashboard).toBe('http://localhost:5174/mf-manifest.json')
		expect(app.federation.shared).toEqual({
			react: { singleton: true },
			'react-dom': { singleton: true },
		})
		expect(app.federation.filename).toBeUndefined()
	})

	it('sends a policy with frame-ancestors, object-src and base-uri from the dev server', () => {
		const policy = spoolApp('shell', { root: dir }).server.headers['Content-Security-Policy']

		expect(policy).toBe("frame-ancestors 'self'; object-src 'none'; base-uri 'self'")
	})

	it('returns the plugin that writes _headers and defines the override origins', () => {
		const app = spoolApp('shell', { root: dir })

		expect(app.plugin.name).toBe('spool')
	})

	it('lets dev overrides reach the local apps, and a build only the configured origins', () => {
		const origins = (command: 'serve' | 'build'): string =>
			spoolApp('shell', { root: dir, command }).plugin.config().define
				.__SPOOL_OVERRIDE_ORIGINS__!

		expect(origins('serve')).toContain('http://localhost:5174')
		expect(origins('build')).toBe('[]')
	})

	it('marks every share singleton', () => {
		const app = spoolApp('shell', { root: dir })

		expect(Object.keys(app.federation.shared)).not.toHaveLength(0)
		for (const config of Object.values(app.federation.shared)) {
			expect(config).toEqual({ singleton: true })
		}
	})

	it("uses a remote's deployed url for production builds", () => {
		const app = spoolApp('shell', { root: dir, command: 'build' })

		expect(app.federation.remotes?.billing).toBe('https://cdn.example.com/mf-manifest.json')
	})

	it('keeps dev on the local server even when a deployed url is set', () => {
		const app = spoolApp('shell', { root: dir, command: 'serve' })

		expect(app.federation.remotes?.billing).toBe('http://localhost:5175/mf-manifest.json')
	})

	it('selects the urls entry for SPOOL_ENV in production builds', () => {
		process.env.SPOOL_ENV = 'staging'
		const app = spoolApp('shell', { root: dir, command: 'build' })

		expect(app.federation.remotes?.billing).toBe('https://staging.example.com/mf-manifest.json')
	})

	it('falls back to url when SPOOL_ENV has no urls entry', () => {
		process.env.SPOOL_ENV = 'production'
		const app = spoolApp('shell', { root: dir, command: 'build' })

		expect(app.federation.remotes?.billing).toBe('https://cdn.example.com/mf-manifest.json')
	})

	it('ignores urls in dev even when SPOOL_ENV is set', () => {
		process.env.SPOOL_ENV = 'staging'
		const app = spoolApp('shell', { root: dir, command: 'serve' })

		expect(app.federation.remotes?.billing).toBe('http://localhost:5175/mf-manifest.json')
	})

	it('lets a SPOOL_REMOTE env var override everything, dev included', () => {
		process.env.SPOOL_REMOTE_DASHBOARD = 'https://staging.example.com/mf-manifest.json'
		const app = spoolApp('shell', { root: dir })

		expect(app.federation.remotes?.dashboard).toBe(
			'https://staging.example.com/mf-manifest.json',
		)
	})

	it('derives a remote config with its exposes and entry filename', () => {
		const app = spoolApp('dashboard', { root: dir })

		expect(app.server).toMatchObject({ port: 5174, strictPort: true })
		expect(app.federation.filename).toBe('remoteEntry.js')
		expect(app.federation.exposes).toEqual({ './App': './src/app/app.tsx' })
		expect(app.federation.remotes).toBeUndefined()

		// Without this flag, production builds never emit mf-manifest.json and
		// deployed hosts cannot resolve the remote.
		expect(app.federation.manifest).toBe(true)
	})

	/** A feature app can mount a widget another app owns without becoming a host. */
	it('gives a remote that consumes remotes both exposes and a remotes map', () => {
		const consumer = workspace(
			makeManifest({
				shell: host({ remotes: ['dashboard'] }),
				dashboard: remote({ remotes: ['billing'] }),
				billing: remote({ path: 'apps/billing', port: 5175 }),
			}),
		)

		const app = spoolApp('dashboard', { root: consumer })

		expect(app.federation.filename).toBe('remoteEntry.js')
		expect(app.federation.exposes).toEqual({ './App': './src/app/app.tsx' })
		expect(app.federation.remotes?.billing).toBe('http://localhost:5175/mf-manifest.json')

		removeDir(consumer)
	})

	it('names an unknown app in its error', () => {
		expect(() => spoolApp('ghost', { root: dir })).toThrow('No app named "ghost"')
	})

	it('fails with the parser message when spool.json has an unknown remote', () => {
		const bad = workspace({ ...manifest, apps: { shell: host({ remotes: ['ghost'] }) } })

		expect(() => spoolApp('shell', { root: bad })).toThrow(
			'"ghost", which is not in this workspace',
		)
		removeDir(bad)
	})

	it('refuses a version 1 spool.json and points at spool upgrade', () => {
		const old = workspace({ ...manifest, version: 1 })

		expect(() => spoolApp('shell', { root: old })).toThrow('spool upgrade')
		removeDir(old)
	})

	it('refuses a spool.json with a typoed key instead of ignoring it', () => {
		const typo = workspace({ ...manifest, sharde: ['react'] })

		expect(() => spoolApp('shell', { root: typo })).toThrow('sharde')
		removeDir(typo)
	})

	it('fails with a clear message when there is no spool.json above the app', () => {
		const empty = freshDir('spool-vite-none-')

		expect(() => spoolApp('shell', { root: empty })).toThrow('[spool] No spool.json found')
		removeDir(empty)
	})

	it('drops shared entries the app does not declare', () => {
		const bare = workspace(manifest, ['react'])

		expect(spoolApp('shell', { root: bare }).federation.shared).toEqual({
			react: { singleton: true },
		})
		removeDir(bare)
	})

	it('defaults to loaded-first, and honours an explicit shareStrategy', () => {
		const pinned = workspace({ ...manifest, shareStrategy: 'version-first' })

		expect(spoolApp('shell', { root: dir }).federation.shareStrategy).toBe('loaded-first')
		expect(spoolApp('dashboard', { root: dir }).federation.shareStrategy).toBe('loaded-first')
		expect(spoolApp('shell', { root: pinned }).federation.shareStrategy).toBe('version-first')
		removeDir(pinned)
	})

	it('shares nothing and warns when the app package.json is unreadable', () => {
		const broken = workspace(manifest)
		writeFileSync(join(broken, 'package.json'), '{ not json')
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		expect(spoolApp('shell', { root: broken }).federation.shared).toEqual({})
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('package.json'))

		warn.mockRestore()
		removeDir(broken)
	})
})

/*
 *   SERVER SETTINGS
 ***************************************************************************************************/
describe('spoolApp server settings', () => {
	it('takes server.cors as the list of origins, replacing the localhost default', () => {
		const custom = workspace({
			...manifest,
			server: { cors: ['https://admin.example.com', 'http://localhost:3000'] },
		})

		expect(spoolApp('shell', { root: custom }).server.cors).toEqual({
			origin: ['https://admin.example.com', 'http://localhost:3000'],
		})
		removeDir(custom)
	})

	it('rejects the version 1 boolean instead of allowing every origin', () => {
		const old = workspace({ ...manifest, server: { cors: true } })

		expect(() => spoolApp('shell', { root: old })).toThrow('list of origins')
		removeDir(old)
	})

	it('passes proxy and host through and expands ${VAR} in them', () => {
		process.env.SPOOL_TEST_BACKEND = 'http://localhost:9000'
		const proxied = workspace({
			...manifest,
			server: { host: true, proxy: { '/api': '${SPOOL_TEST_BACKEND}' } },
		})

		const { server } = spoolApp('shell', { root: proxied })

		expect(server.host).toBe(true)
		expect(server.proxy).toEqual({ '/api': 'http://localhost:9000' })
		delete process.env.SPOOL_TEST_BACKEND
		removeDir(proxied)
	})

	it('merges manifest headers over the defaults but keeps the app port', () => {
		const custom = workspace({
			...manifest,
			server: { headers: { 'X-Team': 'platform' } },
			apps: {
				...manifest.apps,
				shell: { ...manifest.apps.shell, headers: { 'X-App': 'shell' } },
			},
		})

		const { server } = spoolApp('shell', { root: custom })

		expect(server.headers).toMatchObject({
			'X-Content-Type-Options': 'nosniff',
			'X-Team': 'platform',
			'X-App': 'shell',
		})
		expect(server.headers['Content-Security-Policy']).toContain('frame-ancestors')
		expect(server.port).toBe(5173)
		removeDir(custom)
	})

	it('resolves fs.allow against the spool.json folder and keeps the workspace root allowed', () => {
		const allowing = workspace({ ...manifest, server: { fs: { allow: ['../contracts'] } } })

		const allow = spoolApp('shell', { root: allowing }).server.fs?.allow

		expect(allow).toContain(resolve(allowing, '../contracts'))
		expect(allow).toHaveLength(2)
		removeDir(allowing)
	})
})

/*
 *   FAIL-CLOSED DEFAULTS AND UNTRUSTED VALUES
 ***************************************************************************************************/
describe('spoolApp defaults and inputs', () => {
	it('behaves as a build when no command is given, so a missing one never opens the dev origins', () => {
		const withOverrides = workspace({ ...manifest, overrides: { origins: [] } })
		const app = spoolApp('shell', { root: withOverrides })

		expect(app.plugin.config().define.__SPOOL_OVERRIDE_ORIGINS__).toBe('[]')
		expect(app.federation.remotes!.billing).toBe('https://cdn.example.com/mf-manifest.json')
		removeDir(withOverrides)
	})

	it('expands only SPOOL_ and VITE_ variables in the server block', () => {
		process.env.SPOOL_TEST_HOST = 'http://localhost:9000'
		process.env.VITE_TEST_HOST = 'http://localhost:9001'
		process.env.GITHUB_TOKEN = 'ghp_secret'
		const proxied = workspace({
			...manifest,
			server: {
				proxy: {
					'/a': '${SPOOL_TEST_HOST}',
					'/b': '${VITE_TEST_HOST}',
					'/c': 'https://x.example/${GITHUB_TOKEN}',
					'/d': 'https://x.example/${GITHUB_TOKEN:-none}',
				},
			},
		})

		const { server } = spoolApp('shell', { root: proxied })

		expect(server.proxy).toEqual({
			'/a': 'http://localhost:9000',
			'/b': 'http://localhost:9001',
			'/c': 'https://x.example/',
			'/d': 'https://x.example/none',
		})
		delete process.env.SPOOL_TEST_HOST
		delete process.env.VITE_TEST_HOST
		delete process.env.GITHUB_TOKEN
		removeDir(proxied)
	})

	it('rejects a SPOOL_REMOTE override that carries credentials', () => {
		process.env.SPOOL_REMOTE_DASHBOARD = 'https://user:pass@cdn.example.com/mf-manifest.json'

		expect(() => spoolApp('shell', { root: dir, command: 'build' })).toThrow(
			'SPOOL_REMOTE_DASHBOARD',
		)
	})

	it('accepts a plain SPOOL_REMOTE override', () => {
		process.env.SPOOL_REMOTE_DASHBOARD = 'https://cdn.example.com/dash/mf-manifest.json'

		expect(
			spoolApp('shell', { root: dir, command: 'build' }).federation.remotes!.dashboard,
		).toBe('https://cdn.example.com/dash/mf-manifest.json')
	})
})
