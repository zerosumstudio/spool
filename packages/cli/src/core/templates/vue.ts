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

export const vueTemplate: FrameworkTemplate = {
	remoteContract: 'mount',
	exposeEntry: './src/mount.ts',
	htmlEntry: '/src/main.ts',
	// vue-tsc reads .vue files itself; the declaration is for typescript-eslint and
	// plain tsc, which resolve a .vue import to it.
	viteEnv: viteEnvFile(`
declare module '*.vue' {
	import type { DefineComponent } from 'vue'
	const component: DefineComponent
	export default component
}
`),
	compilerOptions: {},
	vitePlugin: {
		importLine: "import vue from '@vitejs/plugin-vue'",
		call: 'vue()',
	},
	remoteTyping: mountContractTyping,
	sourceFiles: (appName, isHost, refs, extras) => {
		const files: Record<string, string> = {
			'src/main.ts': vueMain(extras),
			'src/app/app.vue': isHost
				? vueHostAppFile(appName, refs, extras)
				: vueRemoteApp(appName, extras),
		}

		if (!isHost) files['src/mount.ts'] = vueMount(extras)

		return { ...files, ...(isHost ? reactBridgeFiles(refs) : {}) }
	},
	bridgeFiles: reactBridgeFiles,
}

/*
 *   FILE BUILDERS
 ***************************************************************************************************/
function vueMain(extras: TemplateExtras): string {
	if (!extras.sentry) {
		return `import { createApp } from 'vue'
import App from './app/app.vue'

createApp(App).mount('#root')
`
	}

	return `import { createApp } from 'vue'
import App from './app/app.vue'
import { initSentry } from './sentry'

const app = createApp(App)
initSentry(app)
app.mount('#root')
`
}

function vueMount(extras: TemplateExtras): string {
	const sentryImport = extras.sentry ? `import * as Sentry from '@sentry/vue'\n` : ''
	// main.ts never runs when a host mounts this app, so it is registered here. That
	// is attachErrorHandler, not another vueIntegration: the client skips an
	// integration it already has, and a Vue host has one.
	const sentryCall = extras.sentry
		? `	// Reports this app's errors to the client the host initialised, without its props.
	Sentry.attachErrorHandler(app, { attachProps: false })
`
		: ''

	return `import { createApp } from 'vue'
${sentryImport}import App from './app/app.vue'

// What non-react remotes expose. A host mounts this into a node it owns and
// calls the returned cleanup on teardown.
export default function mountApp(target: HTMLElement): () => void {
	const app = createApp(App)
${sentryCall}	app.mount(target)

	return () => {
		app.unmount()
	}
}
`
}

/** The counter every Vue app with the state addon shows, from the shared store. */
function counterScript(): string {
	return `const count = ref(counterStore.getState().count)
onBeforeUnmount(
	counterStore.subscribe(state => {
		count.value = state.count
	}),
)
`
}

function vueRemoteApp(appName: string, extras: TemplateExtras): string {
	if (!extras.stateExample) {
		return `<template>
	<section class="app">
		<p><strong>${appName}</strong>: a Vue remote exposed via Module Federation.</p>
	</section>
</template>

<style scoped>
.app {
	font-family: system-ui;
	padding: 16px;
	border: 1px solid #ccc;
}
</style>
`
	}

	return `<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { counterStore } from '${STATE_STORE_IMPORT}'

${counterScript()}
const handleIncrement = () => {
	counterStore.set(s => ({ count: s.count + 1 }))
}
</script>

<template>
	<section class="app">
		<p><strong>${appName}</strong>: a Vue remote exposed via Module Federation.</p>
		<p>${STATE_COUNT_TEXT} {{ count }}</p>
		<button @click="handleIncrement">Increment</button>
	</section>
</template>

<style scoped>
.app {
	font-family: system-ui;
	padding: 16px;
	border: 1px solid #ccc;
}
</style>
`
}

function vueHostAppFile(appName: string, refs: RemoteRef[], extras: TemplateExtras): string {
	return extras.composed
		? compositionHostApp('vue', appName, refs)
		: vueHostApp(appName, refs, extras)
}

function vueHostApp(appName: string, refs: RemoteRef[], extras: TemplateExtras): string {
	const stateImport = extras.stateExample
		? `import { onBeforeUnmount, ref } from 'vue'\nimport { counterStore } from '${STATE_STORE_IMPORT}'\n`
		: ''
	const stateLines = extras.stateExample ? `\n${counterScript()}` : ''
	const stateMarkup = extras.stateExample
		? `\n		<p data-testid="${STATE_COUNT_TESTID}">${STATE_COUNT_TEXT} {{ count }}</p>`
		: ''

	const sections = refs
		.map(
			r => `		<section>
			<h2>${r.name}</h2>
			<Remote name="${r.name}">
				<template #fallback><p>Loading ${r.name}...</p></template>
			</Remote>
		</section>`,
		)
		.join('\n')
	const noRemotes = `		<p>No remotes mounted yet.</p>`

	const imports = `${stateImport}${refs.length ? `import { Remote } from '@/federation'\n` : ''}`
	const script = imports ? `<script setup lang="ts">\n${imports}${stateLines}</script>\n\n` : ''

	return `${script}<template>
	<main class="host">
		<h1>${appName} (host)</h1>${stateMarkup}
${sections || noRemotes}
	</main>
</template>

<style scoped>
.host {
	font-family: system-ui;
	padding: 24px;
}
</style>
`
}
