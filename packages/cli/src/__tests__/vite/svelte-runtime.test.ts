/*
 *   IMPORTS
 ***************************************************************************************************/
import { createRequire } from 'node:module'
import { describe, it, expect } from 'vitest'
import { withoutSvelte } from '../../vite/app.js'

/*
 *   COMPILER OUTPUT
 ***************************************************************************************************/
const require = createRequire(import.meta.url)
const { compile } = require('svelte/compiler') as {
	compile: (source: string, options: Record<string, unknown>) => { js: { code: string } }
}

const COMPONENTS = [
	'<script>let a = $state(1)</script><button onclick={() => a++}>{a}</button>',
	'<script>export let name; $: shout = name.toUpperCase()</script><p>{shout}</p><slot />',
	'<script>let { items } = $props()</script>{#each items as item}<li>{item}</li>{/each}',
	'<script>import { fade } from "svelte/transition"; let on = $state(true)</script>{#if on}<div transition:fade>x</div>{/if}',
	'<script>let v = $state(1); const x = await Promise.resolve(v)</script><svelte:boundary><p>{x}</p></svelte:boundary>',
]

/** Every `svelte/internal/*` module the client compiler emits an import for. */
function emittedRuntime(): string[] {
	const found = new Set<string>()

	for (const source of COMPONENTS) {
		for (const dev of [true, false]) {
			const { code } = compile(source, {
				filename: 'App.svelte',
				generate: 'client',
				dev,
				experimental: { async: true },
			}).js

			for (const match of code.matchAll(
				/(?:from|import) ['"](svelte\/internal\/[^'"]+)['"]/g,
			)) {
				found.add(match[1]!)
			}
		}
	}

	return [...found].sort()
}

/*
 *   SVELTE IS NOT SHARED
 ***************************************************************************************************/
describe('withoutSvelte', () => {
	it('drops svelte and its subpaths, and keeps everything else', () => {
		expect(
			withoutSvelte([
				'react',
				'svelte',
				'svelte/store',
				'svelte/internal/client',
				'@sentry/svelte',
				'@zerosumstudio/clutch',
				'sveltekit-thing',
			]),
		).toEqual(['react', '@sentry/svelte', '@zerosumstudio/clutch', 'sveltekit-thing'])
	})

	it('drops every module the installed compiler imports, so a runtime is never split', () => {
		const emitted = emittedRuntime()

		expect(emitted.length).toBeGreaterThan(0)
		expect(withoutSvelte(['svelte', ...emitted])).toEqual([])
	})

	it('leaves an app that shares no svelte alone', () => {
		expect(withoutSvelte(['react', 'react-dom'])).toEqual(['react', 'react-dom'])
	})
})
