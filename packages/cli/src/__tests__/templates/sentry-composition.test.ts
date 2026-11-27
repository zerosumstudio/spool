/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import { transform } from 'esbuild'
import { ADDONS, templateExtras } from '../../core/addons.js'
import {
	sentryFiles,
	sentryEnvFiles,
	sentryVitePlugin,
	sentryNotes,
} from '../../core/templates/sentry.js'
import {
	exposeKey,
	remotesRegistry,
	federationFiles,
	federationNotes,
} from '../../core/templates/composition.js'
import { NO_EXTRAS } from '../../core/templates/index.js'
import { readStaticFile } from '../../core/templates/static-files.js'
import { appFiles, hostWiringFiles } from '../../core/generators.js'
import { validateDsn } from '../../commands/create.js'
import { host, remote, makeManifest } from '../helpers.js'

import type { Manifest } from '../../core/config.js'

/** The two addons that used to be one, merged so path assertions stay in one place. */
const compositionFiles = (m: Manifest) => ({
	...ADDONS.navigation.files(m),
	...federationOf(m),
})

/** What every host and every remote that consumes remotes gets, addon or not. */
function federationOf(m: Manifest): Record<string, string> {
	const files: Record<string, string> = {}

	for (const app of Object.values(m.apps)) {
		if (app.type !== 'host' && !app.remotes.length) continue

		for (const [rel, content] of Object.entries(federationFiles(m, app))) {
			files[`${app.path}/${rel}`] = content
		}
	}

	return files
}

/*
 *   DSN VALIDATION
 ***************************************************************************************************/
describe('validateDsn', () => {
	it('accepts a blank or undefined value (skip) and a well-formed DSN', () => {
		expect(validateDsn('')).toBeUndefined()
		expect(validateDsn(undefined)).toBeUndefined()
		expect(validateDsn('https://key@o1.ingest.sentry.io/42')).toBeUndefined()
	})

	it('rejects a value that is not a DSN', () => {
		expect(validateDsn('not-a-dsn')).toMatch(/Sentry DSN/)
	})
})

/*
 *   TEMPLATE EXTRAS
 ***************************************************************************************************/
describe('templateExtras', () => {
	it('flags sentry and shell from the addon list', () => {
		expect(templateExtras(['sentry'])).toMatchObject({ sentry: true, composed: false })
		expect(templateExtras(['navigation'])).toMatchObject({ sentry: false, composed: true })
	})
})

/*
 *   SENTRY
 ***************************************************************************************************/
describe('sentry addon', () => {
	const mixed = makeManifest({
		shell: host({ remotes: ['dash'] }),
		dash: remote({ path: 'apps/dash', framework: 'vue' }),
	})

	it('is available anywhere and enables through the manifest', () => {
		const m = makeManifest({ shell: host() })
		expect(ADDONS.sentry.unavailable(m)).toBeUndefined()
		ADDONS.sentry.apply?.(m)
		expect(m.addons).toContain('sentry')
		expect(ADDONS.sentry.present('', m)).toBe(true)
		ADDONS.sentry.apply?.(m)
		expect(m.addons.filter(a => a === 'sentry')).toHaveLength(1)
	})

	it('writes an init per app with the framework SDK and app tag', () => {
		const files = sentryFiles(mixed)
		expect(files['apps/shell/src/sentry.ts']).toContain('@sentry/react')
		expect(files['apps/shell/src/sentry.ts']).toContain("mfe: 'shell'")
		const vue = files['apps/dash/src/sentry.ts']!
		expect(vue).toContain('@sentry/vue')
		expect(vue).toContain('initSentry(app: App)')
	})

	it('writes one shared DSN into every app .env', () => {
		const env = sentryEnvFiles(mixed, 'https://k@o.ingest.sentry.io/1')
		expect(env['apps/shell/.env']).toBe('VITE_SENTRY_DSN=https://k@o.ingest.sentry.io/1\n')
		expect(env['apps/dash/.env']).toBeDefined()
	})

	it('stamps each chunk with the app that owns it', () => {
		const plugin = sentryVitePlugin('dash')
		expect(plugin.importLine).toContain('@sentry/vite-plugin')
		expect(plugin.entry).toContain("moduleMetadata: { mfe: 'dash' }")
	})

	it('mounts the vite plugin with or without the token, and gates only the upload', () => {
		const { entry, helper } = sentryVitePlugin('dash')
		expect(entry.startsWith('sentryVitePlugin(')).toBe(true)
		expect(entry).toContain('disable: !process.env.SENTRY_AUTH_TOKEN')
		expect(entry).toContain("filesToDeleteAfterUpload: ['./dist/**/*.map']")
		expect(entry).toContain('telemetry: false')
		expect(entry).toContain('process.env.SENTRY_RELEASE ?? gitSha(command)')
		expect(helper).toContain('function gitSha(command: string)')
		expect(helper).toContain("command !== 'build'")
	})

	it('reads the stamp back off the failing frame, typed', () => {
		const m = makeManifest({ shell: host() })
		ADDONS.sentry.apply?.(m)
		const init = sentryFiles(m)['apps/shell/src/sentry.ts']!
		expect(init).toContain('Sentry.moduleMetadataIntegration()')
		expect(init).toContain('scrubEvent(tagOriginMfe(event))')
		expect(init).toContain('readMfe(frames[i]?.module_metadata)')
		// module_metadata is any in the SDK types, so it is only ever read through unknown.
		expect(init).not.toContain('module_metadata?.mfe')
	})

	it('starts only with a DSN, and sends no PII, console breadcrumbs or default tracing', () => {
		const init = sentryFiles(mixed)['apps/shell/src/sentry.ts']!

		expect(init).toContain('const dsn = import.meta.env.VITE_SENTRY_DSN')
		expect(init).toContain('if (!dsn) return')
		expect(init.indexOf('if (!dsn) return')).toBeLessThan(init.indexOf('Sentry.init('))
		// dataCollection replaces sendDefaultPii, which Sentry 11 removes.
		expect(init).not.toContain('sendDefaultPii')
		expect(init).toContain('userInfo: false')
		expect(init).toContain('cookies: false')
		expect(init).toContain('httpHeaders: { request: false, response: false }')
		expect(init).toContain('httpBodies: []')
		// Sentry 11 has no console option on breadcrumbsIntegration: the Console integration is filtered out.
		expect(init).not.toMatch(/console:/)
		expect(init).not.toContain('breadcrumbsIntegration')
		expect(init).toContain("...defaults.filter(integration => integration.name !== 'Console')")
		expect(init).toContain('Sentry.moduleMetadataIntegration()')
		expect(init).toContain('dataCollection: {')
		expect(init).not.toContain('tracesSampleRate')
		expect(init).not.toContain('VITE_SENTRY_TRACES_SAMPLE_RATE')
	})

	it('scrubs breadcrumbs and errors before they are sent, and leaves transactions to whoever enables tracing', () => {
		const init = sentryFiles(mixed)['apps/shell/src/sentry.ts']!

		expect(init).toContain("import { scrubBreadcrumb, scrubEvent } from './sentry-scrub'")
		expect(init).toContain('beforeBreadcrumb: scrubBreadcrumb')
		// Tracing is off by default, and Sentry 11 warns about this hook without a tracing integration.
		expect(init).not.toContain('beforeSendTransaction')
	})

	it('keeps component props out of vue errors, in both places the SDK can attach them', () => {
		const files = sentryFiles(mixed)

		expect(files['apps/dash/src/sentry.ts']).toContain('\t\tapp,\n\t\tattachProps: false,\n')
		expect(files['apps/shell/src/sentry.ts']).not.toContain('attachProps')
	})

	it('ships the scrub next to every init, unchanged', () => {
		const files = sentryFiles(mixed)

		expect(files['apps/shell/src/sentry-scrub.ts']).toBe(readStaticFile('sentry', 'scrub.ts'))
		expect(files['apps/dash/src/sentry-scrub.ts']).toBe(readStaticFile('sentry', 'scrub.ts'))
	})

	it('hands the vue app to Sentry.init, and only that framework', () => {
		const files = sentryFiles(mixed)

		expect(files['apps/dash/src/sentry.ts']).toContain('\t\tapp,\n')
		expect(files['apps/shell/src/sentry.ts']).not.toContain('\t\tapp,\n')
	})

	it.each(['react', 'vue', 'svelte'] as const)('emits %s init source that compiles', async fw => {
		const m = makeManifest({ shell: host({ framework: fw }) })
		const init = sentryFiles(m)['apps/shell/src/sentry.ts']!

		await expect(transform(init, { loader: 'ts' })).resolves.toBeDefined()
	})

	it('has distinct notes for create and retroactive add', () => {
		expect(sentryNotes(true)[0]).toContain('.env')
		expect(sentryNotes(false)[0]).toContain('initSentry')
	})

	it('adds the SDK, the vite plugin, and a hidden sourcemap to an app', () => {
		const m = makeManifest({ shell: host() })
		ADDONS.sentry.apply?.(m)
		const files = appFiles(m, 'shell', m.apps.shell!)
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.dependencies['@sentry/react']).toBe('^11.19.0')
		expect(pkg.devDependencies['@sentry/vite-plugin']).toBe('^11.19.0')
		expect(files['vite.config.ts']).toContain('sentryVitePlugin')
		// Hidden: the browser gets no sourceMappingURL comment, but the map is
		// still emitted so it can be uploaded before deletion from dist.
		expect(files['vite.config.ts']).toContain("sourcemap: 'hidden'")
		expect(files['vite.config.ts']).not.toContain('minify')
	})

	it('leaves the vite config untouched without the addon', () => {
		const vite = appFiles(makeManifest({ shell: host() }), 'shell', host())['vite.config.ts']!
		expect(vite).not.toContain('sentryVitePlugin')
		expect(vite).not.toContain('sourcemap')
	})

	it('composes initSentry into every framework entry', () => {
		const extras = { ...NO_EXTRAS, sentry: true }
		const reactMain = appFiles(makeManifest({ shell: host() }), 'shell', host(), extras)[
			'src/main.tsx'
		]!
		expect(reactMain).toContain('initSentry()')
		const svelteMain = appFiles(
			makeManifest({ shell: host({ framework: 'svelte' }) }),
			'shell',
			host({ framework: 'svelte' }),
			extras,
		)['src/main.ts']!
		expect(svelteMain).toContain('initSentry()')
		const vueMain = appFiles(
			makeManifest({ shell: host({ framework: 'vue' }) }),
			'shell',
			host({ framework: 'vue' }),
			extras,
		)['src/main.ts']!
		expect(vueMain).toContain('initSentry(app)')
	})
})

/*
 *   COMPOSITION
 ***************************************************************************************************/
describe('navigation and federation addons', () => {
	const build = () =>
		makeManifest({
			shell: host({ remotes: ['browse'] }),
			browse: remote({ path: 'apps/browse', framework: 'svelte' }),
		})

	it('is no longer an addon you can pick: every host has it', () => {
		expect(Object.keys(ADDONS)).not.toContain('federation')
		expect(federationOf(build())['apps/shell/src/federation/remotes.ts']).toBeDefined()
	})

	it('is available to a remote that consumes remotes', () => {
		const m = makeManifest({
			widgets: remote({ path: 'apps/widgets' }),
			feature: remote({ path: 'apps/feature', port: 5175, remotes: ['widgets'] }),
		})

		expect(federationOf(m)['apps/feature/src/federation/remotes.ts']).toContain(
			"import('widgets/App')",
		)
		expect(federationOf(m)['apps/widgets/src/federation/remotes.ts']).toBeUndefined()
	})

	it('enables through the manifest without touching apps', () => {
		const m = build()
		const appsBefore = structuredClone(m.apps)
		ADDONS.navigation.apply?.(m)
		expect(m.addons).toContain('navigation')
		expect(m.addons).not.toContain('federation')
		expect(m.apps).toEqual(appsBefore)
	})

	it('writes the history substrate everywhere and the registry + primitive on hosts', () => {
		const m = build()
		const files = compositionFiles(m)
		expect(files['apps/shell/src/navigation/history.ts']).toContain(
			'export function matchRoute',
		)
		expect(files['apps/browse/src/navigation/location.ts']).toContain('svelte/reactivity')
		expect(files['apps/shell/src/federation/remotes.ts']).toContain("import('browse/App')")
		expect(files['apps/shell/src/federation/remotes.ts']).toContain("contract: 'mount'")
		expect(files['apps/shell/src/federation/remote.tsx']).toContain('export function Remote')
		expect(files['apps/shell/src/federation/core.ts']).toContain('export function loadRemote')
		// Remotes get the substrate but not the registry or primitive.
		expect(files['apps/browse/src/federation/remotes.ts']).toBeUndefined()
	})

	it('bridges react remotes in the registry of a svelte or vue host, never in the <Remote>', () => {
		const mixed = (framework: 'svelte' | 'vue', remoteFramework: 'react' | 'svelte') =>
			compositionFiles(
				makeManifest({
					shell: host({ framework, remotes: ['r'] }),
					r: remote({ path: 'apps/r', framework: remoteFramework }),
				}),
			)

		for (const framework of ['svelte', 'vue'] as const) {
			const withReact = mixed(framework, 'react')
			expect(withReact['apps/shell/src/federation/remotes.ts']).toContain('mountReact')
			expect(withReact['apps/shell/src/federation/remotes.ts']).toContain(
				'\t\tmountComponent: mountReact,\n',
			)

			const without = mixed(framework, 'svelte')
			expect(without['apps/shell/src/federation/remotes.ts']).not.toContain('mountReact')
		}

		const reactHost = compositionFiles(build())
		expect(reactHost['apps/shell/src/federation/remotes.ts']).not.toContain('mountReact')
		expect(reactHost['apps/shell/src/federation/remote.tsx']).not.toContain('mountReact')
	})

	it('generates the vue <Remote> and binding', () => {
		const files = compositionFiles(
			makeManifest({
				shell: host({ framework: 'vue', remotes: ['r'] }),
				r: remote({ path: 'apps/r', framework: 'react' }),
			}),
		)

		expect(files['apps/shell/src/federation/Remote.vue']).toContain('defineSlots')
		expect(files['apps/shell/src/navigation/use-location.ts']).toContain('shallowRef')
	})

	it('regenerates the registry and primitive for hosts only, never for remotes', () => {
		const m = build()
		expect(hostWiringFiles(m, m.apps.shell!)['src/federation/remotes.ts']).toBeDefined()
		expect(hostWiringFiles(m, m.apps.browse!)['src/federation/remotes.ts']).toBeUndefined()
	})

	it('regenerates the registry with a bridge once a react remote is wired in', () => {
		const m = makeManifest({
			shell: host({ framework: 'svelte', remotes: ['r'] }),
			r: remote({ path: 'apps/r', framework: 'react' }),
		})
		expect(hostWiringFiles(m, m.apps.shell!)['src/federation/remotes.ts']).toContain(
			'mountReact',
		)
	})

	it('replaces the host app with the starter shell that imports the split primitives', () => {
		const m = build()
		const shellHost = appFiles(m, 'shell', m.apps.shell!, { ...NO_EXTRAS, composed: true })[
			'src/app/app.tsx'
		]!
		expect(shellHost).toContain('matchRoute')
		expect(shellHost).toContain('<Remote name={active} />')
		expect(shellHost).toContain("from '@/navigation'")
		expect(shellHost).toContain("from '@/federation'")
	})

	it('barrels navigation everywhere and federation on hosts only', () => {
		const files = compositionFiles(build())

		const hostNav = files['apps/shell/src/navigation/index.ts']!
		expect(hostNav).toContain("export * from './history'")
		expect(hostNav).toContain("export { useLocation } from './use-location'")
		expect(hostNav).not.toContain('Remote')

		const hostFederation = files['apps/shell/src/federation/index.ts']!
		expect(hostFederation).toContain("export { Remote, type RemoteProps } from './remote'")
		expect(hostFederation).toContain(
			"export { remotes, type RemoteEntry, type RemoteName, isRemoteName, preloadRemote } from './remotes'",
		)
		expect(hostFederation).toContain('installRemoteOverrides()')

		const remoteNav = files['apps/browse/src/navigation/index.ts']!
		expect(remoteNav).toContain("export { location } from './location'")
		expect(files['apps/browse/src/federation/index.ts']).toBeUndefined()
	})

	it('re-exports the framework component the right way in the barrel', () => {
		const svelte = compositionFiles(makeManifest({ shell: host({ framework: 'svelte' }) }))
		expect(svelte['apps/shell/src/federation/index.ts']).toContain(
			"export { default as Remote } from './Remote.svelte'",
		)
		const vue = compositionFiles(makeManifest({ shell: host({ framework: 'vue' }) }))
		expect(vue['apps/shell/src/federation/index.ts']).toContain(
			"export { default as Remote } from './Remote.vue'",
		)
	})

	it('wires the @ alias into every app tsconfig and vite config', () => {
		const files = appFiles(build(), 'shell', build().apps.shell!)
		const tsconfig = JSON.parse(files['tsconfig.json']!)
		expect(tsconfig.compilerOptions.baseUrl).toBeUndefined()
		expect(tsconfig.compilerOptions.paths['@/*']).toEqual(['./src/*'])
		expect(files['vite.config.ts']).toContain("alias: { '@': resolvePath(import.meta.dirname")
	})

	it('has distinct notes for create and retroactive add', () => {
		expect(federationNotes(true)[0]).toContain('routed shell')
		expect(federationNotes(false)[0]).toContain('Remote')
	})
})

/*
 *   SHELL HOSTS PER FRAMEWORK
 ***************************************************************************************************/
describe('starter shell per framework', () => {
	const shell = { ...NO_EXTRAS, composed: true }
	const shellHost = (fw: 'svelte' | 'vue', remoteFw: 'react' | 'svelte') => {
		const m = makeManifest({
			shell: host({ framework: fw, remotes: ['r'] }),
			r: remote({ path: 'apps/r', framework: remoteFw }),
		})
		return appFiles(m, 'shell', m.apps.shell!, shell)[
			fw === 'svelte' ? 'src/app/app.svelte' : 'src/app/app.vue'
		]!
	}

	it('maps the first remote to "/" and drives the shared history', () => {
		for (const app of [shellHost('svelte', 'react'), shellHost('vue', 'svelte')]) {
			expect(app).toContain('matchRoute')
			expect(app).toContain('navigate')
			expect(app).toContain("'/': 'r'")
		}
	})
})

/*
 *   REGISTRY
 ***************************************************************************************************/
describe('remotesRegistry', () => {
	it('records each remote by name with its contract and loader', () => {
		const registry = remotesRegistry([
			{
				name: 'a',
				path: 'apps/a',
				framework: 'react',
				contract: 'component',
				exposes: ['App'],
				exposeSources: { App: './src/app/app.tsx' },
			},
			{
				name: 'b',
				path: 'apps/b',
				framework: 'vue',
				contract: 'mount',
				exposes: ['App'],
				exposeSources: { App: './src/mount.ts' },
			},
		])
		expect(registry).toContain("a: {\n\t\tcontract: 'component'")
		expect(registry).toContain("b: {\n\t\tcontract: 'mount'")
		expect(registry).toContain("import('a/App')")
	})

	it('gives every named expose its own row', () => {
		const registry = remotesRegistry([
			{
				name: 'a',
				path: 'apps/a',
				framework: 'react',
				contract: 'component',
				exposes: ['App', 'Panel'],
				exposeSources: { App: './src/app/app.tsx', Panel: './src/panel.tsx' },
			},
		])
		expect(registry).toContain("'a/Panel': {\n\t\tcontract: 'component'")
		expect(registry).toContain("import('a/Panel')")
	})

	it('keeps App keyed by the bare remote name', () => {
		const registry = remotesRegistry([
			{
				name: 'a',
				path: 'apps/a',
				framework: 'react',
				contract: 'component',
				exposes: ['App', 'Panel'],
				exposeSources: { App: './src/app/app.tsx', Panel: './src/panel.tsx' },
			},
		])
		expect(registry).toContain('\ta: {\n\t\tcontract')
		expect(registry).not.toContain("'a/App':")
	})
})

describe('exposeKey', () => {
	it('keeps App bare and namespaces the rest', () => {
		expect(exposeKey('a', 'App')).toBe('a')
		expect(exposeKey('a', 'Panel')).toBe('a/Panel')
	})
})
