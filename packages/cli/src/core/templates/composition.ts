/*
 *   IMPORTS
 ***************************************************************************************************/
import type { AppConfig, Framework, Manifest } from '../config.js'
import { SENTRY_SDK } from '../versions.js'
import type { FileMap } from '../filemap.js'
import { remoteRefs, type RemoteRef } from './index.js'
import { fitsOnLine } from './layout.js'
import { readStaticFile, type StaticFile } from './static-files.js'

export const FEDERATION_REMOTES_FILE = 'src/federation/remotes.ts'
export const NAV_PATH_TESTID = 'route-path'

/*
 *   NAVIGATION
 ***************************************************************************************************/
const LOCATION_BINDING = {
	react: { source: 'binding.react.ts', file: 'use-location.ts', export: 'useLocation' },
	vue: { source: 'binding.vue.ts', file: 'use-location.ts', export: 'useLocation' },
	svelte: { source: 'binding.svelte.ts', file: 'location.ts', export: 'location' },
} as const satisfies Record<
	Framework,
	{ source: StaticFile<'navigation'>; file: string; export: string }
>

/** Substrate every app gets: the shared history plus a framework binding to
 * read it reactively. Coordination rides on window.history so independent
 * copies stay in sync with no shared singleton. */
export function navigationFiles(app: AppConfig): FileMap {
	const binding = LOCATION_BINDING[app.framework]

	return {
		'src/navigation/history.ts': readStaticFile('navigation', 'history.ts'),
		[`src/navigation/${binding.file}`]: readStaticFile('navigation', binding.source),
		'src/navigation/index.ts': navigationBarrel(app.framework),
	}
}

function navigationBarrel(framework: Framework): string {
	const binding = LOCATION_BINDING[framework]
	const module = binding.file.replace(/\.ts$/, '')

	return `export * from './history'\nexport { ${binding.export} } from './${module}'\n`
}

/*
 *   FEDERATION
 ***************************************************************************************************/
const REMOTE_FILE = {
	react: 'remote.tsx',
	svelte: 'Remote.svelte',
	vue: 'Remote.vue',
} as const satisfies Record<Framework, StaticFile<'federation'>>

/** Host-only files: the remote registry (regenerated when remotes change), the error
 * reporter, and the runtime and <Remote> that are copied from `templates/federation`. */
export function federationFiles(m: Manifest, host: AppConfig): FileMap {
	const refs = remoteRefs(m, host)
	const sentry = m.addons.includes('sentry')
	const remoteFile = REMOTE_FILE[host.framework]

	return {
		[FEDERATION_REMOTES_FILE]: remotesRegistry(refs, host.framework),
		'src/federation/report.ts': reportFile(host.framework, sentry),
		'src/federation/index.ts': federationBarrel(host),
		'src/federation/core.ts': readStaticFile('federation', 'core.ts'),
		'src/federation/overrides.ts': readStaticFile('federation', 'overrides.ts'),
		[`src/federation/${remoteFile}`]: readStaticFile('federation', remoteFile),
	}
}

function federationBarrel(app: AppConfig): string {
	const remote = REMOTE_FILE[app.framework]
	const remoteExport =
		app.framework === 'react'
			? `export { Remote, type RemoteProps } from './remote'`
			: `export { default as Remote } from './${remote}'`

	return `import { installRemoteOverrides } from './overrides'

installRemoteOverrides()

${remoteExport}
export { RemoteError, type RemoteErrorCode } from './core'
export { remotes, type RemoteEntry, type RemoteName, isRemoteName, preloadRemote } from './remotes'
export { setRemoteOverride, listRemoteOverrides } from './overrides'
`
}

/** `src/federation/report.ts`: where a failed <Remote> load is reported. */
function reportFile(framework: Framework, sentry: boolean): string {
	if (!sentry) {
		return `/** Called with every remote that failed to load. Send it wherever you collect errors. */
export function reportRemoteError(name: string, error: Error): void {
	console.error(\`[federation] remote "\${name}" failed to load\`, error)
}
`
	}

	// "remote": the name a host asked for and could not load. Compare
	// src/sentry.ts's "mfe" tag, which names the chunk that actually threw.
	return `import * as Sentry from '${SENTRY_SDK[framework]}'

/** Called with every remote that failed to load. */
export function reportRemoteError(name: string, error: Error): void {
	Sentry.captureException(error, { tags: { remote: name } })
}
`
}

export function exposeKey(name: string, expose: string): string {
	return expose === 'App' ? name : `${name}/${expose}`
}

/** The name-keyed loader table, regenerated whenever a host's remotes change. A host on
 * another framework mounts a component-contract remote through its react bridge. */
export function remotesRegistry(refs: RemoteRef[], framework: Framework = 'react'): string {
	const bridged = framework !== 'react' && refs.some(r => r.contract === 'component')
	const entries = refs.flatMap(r =>
		r.exposes.map(expose => {
			const id = `${r.name}/${expose}`
			const mount =
				bridged && r.contract === 'component' ? '\n\t\tmountComponent: mountReact,' : ''

			return `\t${propertyKey(exposeKey(r.name, expose))}: {
		contract: '${r.contract}',
		load: () => loadRemote('${id}', { importRemote: () => import('${id}') }),${mount}
	},`
		}),
	)
	// A host with no remotes yet has nothing to load.
	const imports = [
		...(entries.length ? [`import { loadRemote } from './core'`] : []),
		...(bridged ? [`import { mountReact } from '../react-bridge'`] : []),
	]
	const table = entries.length ? `{\n${entries.join('\n')}\n}` : '{}'

	return `${imports.length ? `${imports.join('\n')}\n\n` : ''}export interface RemoteEntry {
	contract: 'component' | 'mount'
	load: () => Promise<{ default: unknown }>
	/** Mounts a component-contract remote into a host of another framework. */
	mountComponent?: (component: unknown, target: HTMLElement, props?: object) => () => void
}

export const remotes = ${table} satisfies Record<string, RemoteEntry>

/** Every name <Remote> and preloadRemote accept. */
export type RemoteName = keyof typeof remotes

/** Narrows a name that only arrives at runtime, from a url or a CMS say. */
export function isRemoteName(name: string): name is RemoteName {
	return Object.hasOwn(remotes, name)
}

/** Fetches a remote before it is mounted, e.g. on route hover. Errors are
 * swallowed; the real mount attempt is what surfaces them. */
export function preloadRemote(name: RemoteName): Promise<void> {
	const entry = remotes[name] as RemoteEntry | undefined

	return (entry?.load() ?? Promise.resolve()).then(
		() => undefined,
		() => undefined,
	)
}
`
}

function propertyKey(value: string): string {
	if (/^[A-Za-z_$][\w$]*$/.test(value)) return value

	return `'${value.replace(/[\\']/g, match => `\\${match}`)}'`
}

/*
 *   NOTES
 ***************************************************************************************************/
export function navigationNotes(): string[] {
	return [
		'navigation: import { useLocation, navigate } from "@/navigation" to read the url and change it. Every bundle on the page sees the same one.',
	]
}

export function federationNotes(composed: boolean): string[] {
	const overrides =
		'federation: run `spool types` to type <Remote> from a remote’s real export, and setRemoteOverride(name, url) from the console to point one remote at another build. The origin has to be in spool.json "overrides.origins", and the override lasts 24 hours.'

	if (composed) {
		return [
			'federation: the host starts as a routed shell in src/app. Mount any remote with <Remote name="..." /> from "@/federation".',
			overrides,
		]
	}

	return [
		'federation: import { Remote } from "@/federation" to mount a remote by name. Compose them into your host however you like.',
		overrides,
	]
}

/*
 *   COMPOSED HOST
 ***************************************************************************************************/
/** A starting route table for the generated shell: the first remote at "/",
 * the rest at "/<name>". Written into the host's own App, which is yours to edit. */
export function defaultRoutes(names: string[]): Record<string, string> {
	const routes: Record<string, string> = {}
	names.forEach((name, i) => {
		routes[i === 0 ? '/' : `/${name}`] = name
	})

	return routes
}

export function compositionHostApp(
	framework: Framework,
	appName: string,
	refs: RemoteRef[],
): string {
	const routes = defaultRoutes(refs.map(r => r.name))

	if (framework === 'svelte') return svelteCompositionHost(appName, routes)

	if (framework === 'vue') return vueCompositionHost(appName, routes)

	return reactCompositionHost(appName, routes)
}

/** The `routes` declaration, broken over lines once it passes the print width. */
function routesDeclaration(routes: Record<string, string>, indent: string): string {
	const entries = Object.entries(routes).map(([path, name]) => `'${path}': '${name}'`)
	const head = `${indent}const routes: Record<string, RemoteName> =`
	const oneLine = `${head} { ${entries.join(', ')} }`

	if (!entries.length) return `${head} {}`

	if (fitsOnLine(oneLine)) return oneLine

	const rows = entries.map(entry => `${indent}\t${entry},`).join('\n')

	return `${head} {\n${rows}\n${indent}}`
}

function reactCompositionHost(appName: string, routes: Record<string, string>): string {
	return `import { useLocation, matchRoute, navigateOnClick } from '@/navigation'
import { Remote, type RemoteName } from '@/federation'

import styles from './app.module.css'

// Map url prefixes to remote names. Edit freely. For a region that stays put,
// render <Remote name="..." /> outside the routed <main>.
${routesDeclaration(routes, '')}

export default function App() {
	const location = useLocation()
	const active = matchRoute(location.pathname, routes)

	return (
		<div className={styles.shell}>
			<nav className={styles.nav}>
				<strong>${appName}</strong>
				{Object.entries(routes).map(([path, name]) => (
					<a
						key={name}
						href={path}
						aria-current={name === active ? 'page' : undefined}
						onClick={navigateOnClick}
					>
						{name}
					</a>
				))}
			</nav>
			<p data-testid="${NAV_PATH_TESTID}" className={styles.path}>
				{location.pathname}
			</p>
			<main className={styles.main}>
				{active ? <Remote name={active} /> : <p>Pick a section above.</p>}
			</main>
		</div>
	)
}
`
}

function svelteCompositionHost(appName: string, routes: Record<string, string>): string {
	return `<script lang="ts">
	import { location, matchRoute, navigateOnClick } from '@/navigation'
	import { Remote, type RemoteName } from '@/federation'

${routesDeclaration(routes, '\t')}
	const active = $derived(matchRoute(location.current.pathname, routes))
</script>

<div class="shell">
	<nav>
		<strong>${appName}</strong>
		{#each Object.entries(routes) as [path, name] (name)}
			<a
				href={path}
				aria-current={name === active ? 'page' : undefined}
				onclick={navigateOnClick}
			>
				{name}
			</a>
		{/each}
	</nav>
	<p data-testid="${NAV_PATH_TESTID}" class="path">{location.current.pathname}</p>
	<main>
		{#if active}
			<Remote name={active} />
		{:else}
			<p>Pick a section above.</p>
		{/if}
	</main>
</div>

<style>
	.shell {
		font-family: system-ui;
	}

	nav {
		display: flex;
		gap: 8px;
		padding: 12px;
		border-bottom: 1px solid #ccc;
	}

	.path {
		padding: 8px 12px;
		color: #666;
	}

	main {
		padding: 12px;
	}
</style>
`
}

function vueCompositionHost(appName: string, routes: Record<string, string>): string {
	return `<script setup lang="ts">
import { computed } from 'vue'
import { useLocation, matchRoute, navigateOnClick } from '@/navigation'
import { Remote, type RemoteName } from '@/federation'

${routesDeclaration(routes, '')}
const location = useLocation()
const active = computed(() => matchRoute(location.value.pathname, routes))
</script>

<template>
	<div class="shell">
		<nav>
			<strong>${appName}</strong>
			<a
				v-for="(name, path) in routes"
				:key="name"
				:href="path"
				:aria-current="name === active ? 'page' : undefined"
				@click="navigateOnClick"
			>
				{{ name }}
			</a>
		</nav>
		<p data-testid="${NAV_PATH_TESTID}" class="path">{{ location.pathname }}</p>
		<main>
			<Remote v-if="active" :name="active" />
			<p v-else>Pick a section above.</p>
		</main>
	</div>
</template>

<style scoped>
.shell {
	font-family: system-ui;
}

nav {
	display: flex;
	gap: 8px;
	padding: 12px;
	border-bottom: 1px solid #ccc;
}

.path {
	padding: 8px 12px;
	color: #666;
}

main {
	padding: 12px;
}
</style>
`
}
