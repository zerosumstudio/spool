/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import { transform } from 'esbuild'
import { compositionHostApp } from '../../core/templates/composition.js'
import { NO_EXTRAS, TEMPLATES, remoteRef } from '../../core/templates/index.js'
import type { Framework } from '../../core/config.js'
import type { TemplateExtras } from '../../core/templates/index.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
const PLAIN = NO_EXTRAS
const WITH_STATE: TemplateExtras = { ...NO_EXTRAS, stateExample: true }

const refs = [remoteRef('dash', 'react'), remoteRef('widget', 'svelte')]

function hostApp(framework: Framework, extras: TemplateExtras, remotes = refs): string {
	const files = TEMPLATES[framework].sourceFiles('shell', true, remotes, extras)

	return files[framework === 'react' ? 'src/app/app.tsx' : `src/app/app.${framework}`]!
}

function scriptOf(component: string): string {
	return /<script[^>]*>([\s\S]*?)<\/script>/.exec(component)?.[1] ?? ''
}

/*
 *   HOST APPS
 ***************************************************************************************************/
describe('host apps', () => {
	it('mount every remote through <Remote>, with a loading fallback', () => {
		expect(hostApp('react', PLAIN)).toContain(
			'<Remote name="dash" fallback={<p>Loading dash...</p>} />',
		)
		expect(hostApp('vue', PLAIN)).toContain(
			'<template #fallback><p>Loading widget...</p></template>',
		)
		expect(hostApp('svelte', PLAIN)).toContain(
			'{#snippet fallback()}<p>Loading widget...</p>{/snippet}',
		)
	})

	it('carry none of the old no-Remote mounting code', () => {
		for (const framework of ['react', 'vue', 'svelte'] as const) {
			const app = hostApp(framework, WITH_STATE)

			expect(app, framework).not.toMatch(/MountRemote|lazy\(|Suspense|mountReact|cancelled/)
			expect(app, framework).not.toMatch(/onMounted|onMount\b|cleanups/)
		}
	})

	it('import nothing when there are no remotes and no state', () => {
		expect(hostApp('react', PLAIN, [])).not.toContain('import { Remote }')
		expect(hostApp('vue', PLAIN, [])).not.toContain('<script')
		expect(hostApp('svelte', PLAIN, [])).not.toContain('<script')
		for (const framework of ['react', 'vue', 'svelte'] as const) {
			expect(hostApp(framework, PLAIN, [])).toContain('No remotes mounted yet.')
		}
	})

	it('compile, with remotes and without', async () => {
		for (const remotes of [refs, []]) {
			await expect(
				transform(hostApp('react', WITH_STATE, remotes), {
					loader: 'tsx',
					jsx: 'automatic',
				}),
			).resolves.toBeDefined()
			for (const framework of ['vue', 'svelte'] as const) {
				await expect(
					transform(scriptOf(hostApp(framework, WITH_STATE, remotes)), { loader: 'ts' }),
				).resolves.toBeDefined()
			}
		}
	})

	it('do not have a mount hint any more', () => {
		for (const framework of ['react', 'vue', 'svelte'] as const) {
			expect(TEMPLATES[framework]).not.toHaveProperty('mountHint')
		}
	})
})

/*
 *   SVELTE RUNES
 ***************************************************************************************************/
describe('svelte templates', () => {
	const LEGACY = /\bon:[a-z]+=|export let |^\s*\$:|\bonMount\b|\bonDestroy\b/m

	it('use runes everywhere', () => {
		const sources = {
			host: hostApp('svelte', WITH_STATE),
			remote: TEMPLATES.svelte.sourceFiles('widget', false, [], WITH_STATE)[
				'src/app/app.svelte'
			]!,
			composed: compositionHostApp('svelte', 'shell', refs),
		}

		for (const [name, source] of Object.entries(sources)) {
			expect(source, name).not.toMatch(LEGACY)
		}
		expect(sources.host).toContain(
			'const track = createSubscriber(update => counterStore.subscribe(update))',
		)
		expect(sources.host).toContain('{count}')
		expect(sources.remote).toContain('<button onclick={handleIncrement}>Increment</button>')
		expect(sources.composed).toContain(
			'const active = $derived(matchRoute(location.current.pathname, routes))',
		)
		expect(sources.composed).toContain('onclick={navigateOnClick}')
	})
})

/*
 *   VUE SENTRY
 ***************************************************************************************************/
describe('vue remote mount.ts', () => {
	const mount = (sentry: boolean) =>
		TEMPLATES.vue.sourceFiles('widget', false, [], { ...NO_EXTRAS, sentry })['src/mount.ts']!

	it('attaches the sentry error handler to the app it creates, before mounting it', () => {
		const source = mount(true)

		expect(source).toContain("import * as Sentry from '@sentry/vue'")
		expect(source).toContain('Sentry.attachErrorHandler(app, { attachProps: false })')
		expect(
			source.indexOf('Sentry.attachErrorHandler(app, { attachProps: false })'),
		).toBeLessThan(source.indexOf('app.mount(target)'))
	})

	it('does not touch sentry without the addon', () => {
		expect(mount(false)).not.toContain('Sentry')
	})

	it('compiles', async () => {
		await expect(transform(mount(true), { loader: 'ts' })).resolves.toBeDefined()
	})
})
