/*
 *   IMPORTS
 ***************************************************************************************************/
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { transform } from 'esbuild'
import * as prettier from 'prettier'
import { federationFiles, remotesRegistry } from '../../core/templates/composition.js'
import {
	STATIC_FILES,
	readStaticFile,
	type StaticFile,
	type StaticFolder,
} from '../../core/templates/static-files.js'
import { remoteRefs } from '../../core/templates/index.js'
import { host, remote, makeManifest } from '../helpers.js'
import type { AddonName, Framework } from '../../core/config.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
const FEDERATION_FILES = STATIC_FILES.federation
const readFederationFile = (name: StaticFile<'federation'>) => readStaticFile('federation', name)

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../core/templates')
const FEDERATION_DIR = join(TEMPLATES_DIR, 'federation')

function generated(
	framework: Framework = 'react',
	addons: AddonName[] = [],
	remoteFramework: Framework = framework,
): Record<string, string> {
	const manifest = makeManifest({
		shell: host({ framework, remotes: ['browse'] }),
		browse: remote({ framework: remoteFramework, path: 'apps/browse' }),
	})
	manifest.addons = addons

	return federationFiles(manifest, manifest.apps.shell!)
}

/** The <script> body of a single-file component, which is what esbuild can check. */
function scriptOf(component: string): string {
	const match = /<script[^>]*>([\s\S]*?)<\/script>/.exec(component)
	if (!match) throw new Error('no <script> block')

	return match[1]!
}

async function compiles(source: string, loader: 'ts' | 'tsx'): Promise<void> {
	await expect(
		transform(source, { loader, jsx: 'automatic', format: 'esm' }),
	).resolves.toBeDefined()
}

const REMOTE_FILE: Record<Framework, string> = {
	react: 'remote.tsx',
	vue: 'Remote.vue',
	svelte: 'Remote.svelte',
}

/*
 *   STATIC FILES
 ***************************************************************************************************/
describe('templates/federation static files', () => {
	it.each(Object.keys(STATIC_FILES) as StaticFolder[])(
		'lists every file in templates/%s, so none is left out of the build copy',
		folder => {
			const onDisk = readdirSync(join(TEMPLATES_DIR, folder), { withFileTypes: true })
				.filter(entry => entry.isFile() && !entry.name.startsWith('tsconfig'))
				.map(entry => entry.name)

			expect([...onDisk].sort()).toEqual([...STATIC_FILES[folder]].sort())
		},
	)

	it('copies every static folder into dist in the build', () => {
		const config = readFileSync(join(TEMPLATES_DIR, '../../../tsdown.config.ts'), 'utf8')

		// One copy entry per folder in STATIC_FILES, so none can be left out.
		expect(config).toContain('Object.keys(STATIC_FILES).map(folder => ({')
		expect(config).toContain('/*.{ts,tsx,vue,svelte}')
		expect(config).toContain('dist/')
	})

	it('reads each file with LF endings', () => {
		for (const name of FEDERATION_FILES) expect(readFederationFile(name)).not.toContain('\r')
	})

	it('compiles the runtime and the react <Remote>', async () => {
		await compiles(readFederationFile('core.ts'), 'ts')
		await compiles(readFederationFile('overrides.ts'), 'ts')
		await compiles(readFederationFile('remote.tsx'), 'tsx')
	})

	it('compiles the script of the vue and svelte <Remote>', async () => {
		await compiles(scriptOf(readFederationFile('Remote.vue')), 'ts')
		await compiles(scriptOf(readFederationFile('Remote.svelte')), 'ts')
	})

	it('has no semicolons or double quotes in code, as the house style asks', () => {
		for (const name of ['core.ts', 'overrides.ts', 'remote.tsx'] as const) {
			const code = readFederationFile(name)
				.split('\n')
				.filter(line => !/^\s*(\/?\*|\/\/)/.test(line))
				.join('\n')

			expect(code, name).not.toMatch(/;\s*$/m)
			expect(code, name).not.toMatch(/import .* from "/)
		}
	})
})

/*
 *   GENERATED FILES
 ***************************************************************************************************/
describe('federationFiles', () => {
	it.each(['react', 'vue', 'svelte'] as const)(
		'writes the %s files, unchanged where static',
		fw => {
			const files = generated(fw)

			expect(Object.keys(files).sort()).toEqual(
				[
					'src/federation/core.ts',
					'src/federation/index.ts',
					'src/federation/overrides.ts',
					'src/federation/remotes.ts',
					'src/federation/report.ts',
					`src/federation/${REMOTE_FILE[fw]}`,
				].sort(),
			)
			expect(files['src/federation/core.ts']).toBe(readFederationFile('core.ts'))
			expect(files['src/federation/overrides.ts']).toBe(readFederationFile('overrides.ts'))
			expect(files[`src/federation/${REMOTE_FILE[fw]}`]).toBe(
				readFederationFile(REMOTE_FILE[fw] as StaticFile<'federation'>),
			)
		},
	)

	it('no longer writes load.ts, and takes no override flag from the manifest', () => {
		const files = generated('react')

		expect(files['src/federation/load.ts']).toBeUndefined()
		expect(files['src/federation/overrides.ts']).not.toContain('enabledInProd')
	})

	it.each(['react', 'vue', 'svelte'] as const)('generates %s sources that compile', async fw => {
		const files = generated(fw, ['sentry'])

		await compiles(files['src/federation/remotes.ts']!, 'ts')
		await compiles(files['src/federation/report.ts']!, 'ts')
		await compiles(files['src/federation/index.ts']!, 'ts')
	})

	it('writes the generated files already formatted to the house style', async () => {
		const config = (await prettier.resolveConfig(join(FEDERATION_DIR, 'core.ts'))) ?? {}

		for (const fw of ['react', 'vue', 'svelte'] as const) {
			const files = generated(fw, ['sentry'], 'react')
			for (const name of ['remotes', 'report', 'index']) {
				const source = files[`src/federation/${name}.ts`]!

				expect(
					await prettier.format(source, { ...config, parser: 'typescript' }),
					`${fw} ${name}.ts`,
				).toBe(source)
			}
		}
	})
})

/*
 *   BARREL
 ***************************************************************************************************/
describe('src/federation/index.ts', () => {
	it('installs the override plugin and re-exports the public surface', () => {
		const barrel = generated('react')['src/federation/index.ts']!

		expect(barrel).toContain("import { installRemoteOverrides } from './overrides'")
		expect(barrel).toContain('installRemoteOverrides()')
		expect(barrel).toContain("export { Remote, type RemoteProps } from './remote'")
		expect(barrel).toContain("export { RemoteError, type RemoteErrorCode } from './core'")
		expect(barrel).toContain(
			"export { setRemoteOverride, listRemoteOverrides } from './overrides'",
		)
		expect(barrel).toContain(
			"export { remotes, type RemoteEntry, type RemoteName, isRemoteName, preloadRemote } from './remotes'",
		)
	})

	it('re-exports the framework component the right way', () => {
		expect(generated('svelte')['src/federation/index.ts']).toContain(
			"export { default as Remote } from './Remote.svelte'",
		)
		expect(generated('vue')['src/federation/index.ts']).toContain(
			"export { default as Remote } from './Remote.vue'",
		)
	})
})

/*
 *   ERROR REPORTING
 ***************************************************************************************************/
describe('src/federation/report.ts', () => {
	it('logs to the console until you wire one, without the sentry addon', () => {
		const report = generated('react')['src/federation/report.ts']!

		expect(report).toContain('export function reportRemoteError(name: string, error: Error)')
		expect(report).toContain('console.error(')
		expect(report).not.toContain('Sentry')
	})

	it.each([
		['react', '@sentry/react'],
		['vue', '@sentry/vue'],
		['svelte', '@sentry/svelte'],
	] as const)('tags the failed remote in %s when sentry is on', (fw, sdk) => {
		const report = generated(fw, ['sentry'])['src/federation/report.ts']!

		expect(report).toContain(`import * as Sentry from '${sdk}'`)
		expect(report).toContain('Sentry.captureException(error, { tags: { remote: name } })')
	})
})

/*
 *   <Remote> OPTIONS
 ***************************************************************************************************/
describe('<Remote> options', () => {
	it('gives react fallback, renderError and onError', () => {
		const source = readFederationFile('remote.tsx')

		expect(source).toContain('fallback?: ReactNode')
		expect(source).toContain(
			'renderError?: (error: RemoteError, retry: () => void) => ReactNode',
		)
		expect(source).toContain('onError?: (error: RemoteError, name: RemoteName) => void')
	})

	it('gives vue #fallback and #error="{ error, retry }" slots and an error event', () => {
		const source = readFederationFile('Remote.vue')

		expect(source).toContain('<slot v-if="state?.status === \'loading\'" name="fallback" />')
		expect(source).toContain('<slot name="error" :error="state.error" :retry="retry">')
		expect(source).toContain('error: [error: RemoteError, name: RemoteName]')
		expect(source).toContain("emit('error', next.error, name)")
	})

	it('gives svelte fallback and error snippets and onError, on runes', () => {
		const source = readFederationFile('Remote.svelte')

		expect(source).toContain('let { name, props, fallback, error, onError }: Props = $props()')
		expect(source).toContain('fallback?: Snippet')
		expect(source).toContain('error?: Snippet<[RemoteError, () => void]>')
		expect(source).toContain('onError?: (error: RemoteError, name: RemoteName) => void')
		expect(source).toContain('{@render error(remote.error, retry)}')
		expect(source).not.toMatch(/export let|on:click|\$:/)
	})

	it.each(['remote.tsx', 'Remote.vue', 'Remote.svelte'] as const)(
		'offers "Reload page" instead of "Try again" when the error needs one: %s',
		name => {
			const source = readFederationFile(name)

			expect(source).toContain('Reload page')
			expect(source).toContain('Try again')
			expect(source).toContain('needsReload')
			expect(source).toContain('data-remote-error')
		},
	)

	it.each(['remote.tsx', 'Remote.vue', 'Remote.svelte'] as const)(
		'reports a failed load and warns once about an unknown name: %s',
		name => {
			const source = readFederationFile(name)

			expect(source).toContain('reportRemoteError(')
			expect(source).toContain('warnUnknownRemote(')
			expect(source).toContain('createRemoteLoader(')
		},
	)

	it('mounts a component-contract remote in a vue or svelte host through the registry', () => {
		for (const name of ['Remote.vue', 'Remote.svelte'] as const) {
			expect(readFederationFile(name)).toContain('entry.mountComponent?.(')
		}
		expect(readFederationFile('remote.tsx')).not.toContain('mountComponent')
	})

	it('keeps no separate no-Remote mounting code', () => {
		for (const name of FEDERATION_FILES) {
			expect(readFederationFile(name)).not.toContain('MountRemote')
		}
	})
})

/*
 *   REGISTRY
 ***************************************************************************************************/
describe('remotesRegistry', () => {
	function registry(framework: Framework, remoteFramework: Framework): string {
		const manifest = makeManifest({
			shell: host({ framework, remotes: ['browse'] }),
			browse: remote({ framework: remoteFramework, path: 'apps/browse' }),
		})

		return remotesRegistry(remoteRefs(manifest, manifest.apps.shell!), framework)
	}

	it('sends every loader through loadRemote, keeping the import the bundler needs', () => {
		const source = registry('react', 'react')

		expect(source).toContain("import { loadRemote } from './core'")
		expect(source).toContain(
			"load: () => loadRemote('browse/App', { importRemote: () => import('browse/App') })",
		)
		expect(source).not.toContain('mountComponent: mountReact,')
		expect(source).not.toContain('react-bridge')
	})

	it('gives a vue or svelte host a bridge only for react remotes', () => {
		const bridged = registry('svelte', 'react')
		expect(bridged).toContain("import { mountReact } from '../react-bridge'")
		expect(bridged).toContain('\t\tmountComponent: mountReact,\n')
		expect(bridged).not.toContain('as never')

		const plain = registry('vue', 'svelte')
		expect(plain).not.toContain('mountReact')
		expect(plain).not.toContain('mountComponent: mountReact,')
	})

	it('writes an empty table, and no unused import, for a host with no remotes', async () => {
		const source = remotesRegistry([])

		expect(source).not.toContain("from './core'")
		expect(source).toContain('export const remotes = {} satisfies Record<string, RemoteEntry>')
		await compiles(source, 'ts')
	})
})
