/*
 *   IMPORTS
 ***************************************************************************************************/
import {
	mountContractTyping,
	reactBridgeFiles,
	STATE_COUNT_TESTID,
	STATE_COUNT_TEXT,
	STATE_STORE_IMPORT,
} from './bridges.js'
import { compositionHostApp } from './composition.js'
import { viteEnvFile } from './vite-env.js'
import type { FrameworkTemplate, RemoteRef, TemplateExtras } from './types.js'

export const svelteTemplate: FrameworkTemplate = {
	remoteContract: 'mount',
	exposeEntry: './src/mount.ts',
	htmlEntry: '/src/main.ts',
	// svelte-check reads .svelte files itself; the declaration is for typescript-eslint and
	// plain tsc, which resolve a .svelte import to it.
	viteEnv: viteEnvFile(`
declare module '*.svelte' {
	import type { Component } from 'svelte'
	const component: Component
	export default component
}
`),
	compilerOptions: {},
	vitePlugin: {
		importLine: "import { svelte } from '@sveltejs/vite-plugin-svelte'",
		call: 'svelte()',
	},
	remoteTyping: mountContractTyping,
	sourceFiles: (appName, isHost, refs, extras) => {
		const files: Record<string, string> = {
			'src/main.ts': svelteMain(extras),
			'src/app/app.svelte': isHost
				? svelteHostAppFile(appName, refs, extras)
				: svelteRemoteApp(appName, extras),
		}

		if (!isHost) files['src/mount.ts'] = svelteMount()

		return { ...files, ...(isHost ? reactBridgeFiles(refs) : {}) }
	},
	bridgeFiles: reactBridgeFiles,
}

/*
 *   FILE BUILDERS
 ***************************************************************************************************/
function svelteMain(extras: TemplateExtras): string {
	const sentryImport = extras.sentry ? `import { initSentry } from './sentry'\n` : ''
	const sentryCall = extras.sentry ? `initSentry()\n\n` : ''

	return `${sentryImport}import { mount } from 'svelte'
import App from './app/app.svelte'

${sentryCall}const root = document.getElementById('root')

if (!root) throw new Error('index.html has no #root element')

mount(App, { target: root })
`
}

function svelteMount(): string {
	return `import { mount, unmount } from 'svelte'
import App from './app/app.svelte'

// What non-react remotes expose. A host mounts this into a node it owns and
// calls the returned cleanup on teardown.
export default function mountApp(target: HTMLElement): () => void {
	const app = mount(App, { target })

	return () => {
		void unmount(app)
	}
}
`
}

/** The shared count as a rune: whatever reads \`count\` re-runs when the store changes. */
function counterScript(): string {
	return `	const track = createSubscriber(update => counterStore.subscribe(update))
	const count = $derived.by(() => {
		track()

		return counterStore.getState().count
	})
`
}

function svelteRemoteApp(appName: string, extras: TemplateExtras): string {
	if (!extras.stateExample) {
		return `<section class="app">
	<strong>${appName}</strong>: a Svelte remote exposed via Module Federation.
</section>

<style>
	.app {
		font-family: system-ui;
		padding: 16px;
		border: 1px solid #ccc;
	}
</style>
`
	}

	return `<script lang="ts">
	import { createSubscriber } from 'svelte/reactivity'
	import { counterStore } from '${STATE_STORE_IMPORT}'

${counterScript()}	const handleIncrement = () => {
		counterStore.set(s => ({ count: s.count + 1 }))
	}
</script>

<section class="app">
	<p><strong>${appName}</strong>: a Svelte remote exposed via Module Federation.</p>
	<p>${STATE_COUNT_TEXT} {count}</p>
	<button onclick={handleIncrement}>Increment</button>
</section>

<style>
	.app {
		font-family: system-ui;
		padding: 16px;
		border: 1px solid #ccc;
	}
</style>
`
}

function svelteHostAppFile(appName: string, refs: RemoteRef[], extras: TemplateExtras): string {
	return extras.composed
		? compositionHostApp('svelte', appName, refs)
		: svelteHostApp(appName, refs, extras)
}

function svelteHostApp(appName: string, refs: RemoteRef[], extras: TemplateExtras): string {
	const stateImports = extras.stateExample
		? `\timport { createSubscriber } from 'svelte/reactivity'\n\timport { counterStore } from '${STATE_STORE_IMPORT}'\n`
		: ''
	const remoteImport = refs.length ? `\timport { Remote } from '@/federation'\n` : ''
	const stateLines = extras.stateExample ? `\n${counterScript()}` : ''
	const stateMarkup = extras.stateExample
		? `\n	<p data-testid="${STATE_COUNT_TESTID}">${STATE_COUNT_TEXT} {count}</p>`
		: ''

	const sections = refs
		.map(
			r => `	<section>
		<h2>${r.name}</h2>
		<Remote name="${r.name}">
			{#snippet fallback()}<p>Loading ${r.name}...</p>{/snippet}
		</Remote>
	</section>`,
		)
		.join('\n')
	const noRemotes = `	<p>No remotes mounted yet.</p>`

	const imports = `${stateImports}${remoteImport}`
	const script = imports ? `<script lang="ts">\n${imports}${stateLines}</script>\n\n` : ''

	return `${script}<main class="host">
	<h1>${appName} (host)</h1>${stateMarkup}
${sections || noRemotes}
</main>

<style>
	.host {
		font-family: system-ui;
		padding: 24px;
	}
</style>
`
}
