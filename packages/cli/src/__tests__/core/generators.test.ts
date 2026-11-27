/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workspaceFiles, appFiles, hostWiringFiles } from '../../core/generators.js'
import { rootDevDependencies } from '../../core/versions.js'
import { federationFiles } from '../../core/templates/composition.js'
import { ciWorkflows } from '../../core/templates/workflows.js'
import { NO_EXTRAS } from '../../core/templates/index.js'
import { parseManifest, type Manifest } from '../../core/config.js'
import { host, remote, makeManifest, freshDir, removeDir } from '../helpers.js'

/*
 *   FIXTURES
 ***************************************************************************************************/
const manifest = (): Manifest =>
	makeManifest({
		shell: host({ remotes: ['dashboard'] }),
		dashboard: remote(),
	})

/*
 *   WORKSPACE FILES
 ***************************************************************************************************/
describe('workspaceFiles', () => {
	const files = workspaceFiles(manifest())

	it('generates the expected root files', () => {
		expect(Object.keys(files).sort()).toEqual(
			[
				'.gitattributes',
				'.gitignore',
				'.prettierignore',
				'.nvmrc',
				'.prettierrc',
				'README.md',
				'package.json',
				'pnpm-workspace.yaml',
				'spool.json',
				'spool.workspace.ts',
				'tsconfig.base.json',
				'tsconfig.json',
			].sort(),
		)
	})

	it('ignores real .env files but keeps a checked-in .env.example', () => {
		expect(files['.gitignore']).toContain('.env\n')
		expect(files['.gitignore']).toContain('.env.*\n')
		expect(files['.gitignore']).toContain('!.env.example')
	})

	it('ignores spool types output, since spool types regenerates it on every run', () => {
		expect(files['.gitignore']).toContain('.spool/')
	})

	it('normalises line endings for anyone cloning on Windows', () => {
		expect(files['.gitattributes']).toBe('* text=auto eol=lf\n')
	})

	it('generates no vite helper: it ships as @zerosumstudio/spool/vite', () => {
		expect(files['spool.vite.ts']).toBeUndefined()
		expect(files['spool.workspace.ts']).toContain('spool.json')
		expect(JSON.parse(files['tsconfig.json']!).include).toEqual(['spool.workspace.ts'])
	})

	it('writes spool.json as the manifest', () => {
		expect(JSON.parse(files['spool.json']!)).toEqual(manifest())
	})

	it('emits valid JSON for every json file', () => {
		for (const name of ['spool.json', 'package.json', 'tsconfig.base.json']) {
			expect(() => JSON.parse(files[name]!)).not.toThrow()
		}
	})

	it('ships the house prettier config', () => {
		const rc = files['.prettierrc']!

		expect(rc).toContain('useTabs: true\n')
		expect(rc).toContain('semi: false\n')
		expect(rc).toContain('singleQuote: true\n')
		expect(rc).toContain('tabWidth: 4\n')
		expect(rc).toContain('trailingComma: all\n')
	})

	it('allows the esbuild build script for both pnpm 10 and 11', () => {
		expect(files['pnpm-workspace.yaml']).toContain('allowBuilds:')
		expect(files['pnpm-workspace.yaml']).toContain('esbuild: true')
		expect(files['pnpm-workspace.yaml']).toContain('onlyBuiltDependencies:')
		expect(files['pnpm-workspace.yaml']).toContain('- esbuild')
		expect(files['pnpm-workspace.yaml']).toContain('apps/*')
	})

	it('carries spool as a dev dependency so fresh clones can run the scripts', () => {
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.devDependencies['@zerosumstudio/spool']).toMatch(/^\^\d+\.\d+\.\d+/)
		expect(pkg.scripts).toMatchObject({ dev: 'spool dev', build: 'spool build' })
	})

	it('names the workspace in the readme', () => {
		expect(files['README.md']).toContain('# acme')
	})

	it('tells the reader what the readme can no longer leave implicit', () => {
		const readme = files['README.md']

		expect(readme).toContain('Requires Node 26 or newer.')
		expect(readme).toContain('`deployEnv` in `spool.json`, then rerun `spool ci --force`')
		expect(readme).toContain('Commit `.spool/generated.json`')
		expect(readme).toContain('spool eject')
	})

	it('uses pnpm-workspace.yaml and a pnpm install hint for pnpm', () => {
		expect(files['pnpm-workspace.yaml']).toBeDefined()
		expect(JSON.parse(files['package.json']!).workspaces).toBeUndefined()
		expect(files['README.md']).toContain('pnpm install')
	})

	it('pins the pnpm version so CI and corepack agree', () => {
		expect(JSON.parse(files['package.json']!).packageManager).toMatch(/^pnpm@\d/)
	})
})

/*
 *   WORKSPACE FILES - NPM / YARN
 ***************************************************************************************************/
describe.each(['npm', 'yarn'] as const)('workspaceFiles (%s)', pm => {
	const files = workspaceFiles(
		parseManifest({
			name: 'acme',
			version: 2,
			packageManager: pm,
			apps: { shell: host({ remotes: ['dashboard'] }), dashboard: remote() },
		}),
	)

	it('declares workspaces in package.json instead of pnpm-workspace.yaml', () => {
		expect(files['pnpm-workspace.yaml']).toBeUndefined()
		expect(JSON.parse(files['package.json']!).workspaces).toEqual(['apps/*', 'packages/*'])
	})

	it('uses the chosen package manager in the readme install hint', () => {
		expect(files['README.md']).toContain(`${pm} install`)
	})
})

/*
 *   WORKSPACE FILES - YARN (v1 + Berry)
 ***************************************************************************************************/
describe('workspaceFiles (yarn)', () => {
	const files = workspaceFiles(
		parseManifest({
			name: 'acme',
			version: 2,
			packageManager: 'yarn',
			apps: { shell: host() },
		}),
	)

	it('pins the node_modules linker so Berry works with Vite and federation', () => {
		expect(files['.yarnrc.yml']).toBeDefined()
		expect(files['.yarnrc.yml']).toContain('nodeLinker: node-modules')
	})

	it('ignores Berry cache and PnP artifacts in .gitignore', () => {
		expect(files['.gitignore']).toContain('.yarn/*')
		expect(files['.gitignore']).toContain('.pnp.*')
	})

	it('does not emit a yarnrc for npm or pnpm', () => {
		const npm = workspaceFiles(
			parseManifest({ name: 'acme', version: 2, packageManager: 'npm', apps: {} }),
		)
		const pnpm = workspaceFiles(parseManifest({ name: 'acme', version: 2, apps: {} }))
		expect(npm['.yarnrc.yml']).toBeUndefined()
		expect(pnpm['.yarnrc.yml']).toBeUndefined()
	})
})

/*
 *   APP FILES - HOST
 ***************************************************************************************************/
describe('appFiles (host)', () => {
	const m = manifest()
	const files = appFiles(m, 'shell', m.apps.shell!)

	it('includes the host source and config', () => {
		expect(Object.keys(files).sort()).toEqual(
			[
				'index.html',
				'package.json',
				'src/app/app.module.css',
				'src/app/app.tsx',
				'src/main.tsx',
				'src/remotes.d.ts',
				...Object.keys(federationFiles(m, m.apps.shell!)),
				'src/vite-env.d.ts',
				'tsconfig.json',
				'vite.config.ts',
			].sort(),
		)
	})

	it('reads its wiring from the spool/vite entry instead of baking it in', () => {
		expect(files['vite.config.ts']).toContain(
			"spoolApp('shell', { root: import.meta.dirname, command })",
		)
		expect(files['vite.config.ts']).toContain("from '@zerosumstudio/spool/vite'")
		expect(files['vite.config.ts']).not.toContain('spool.vite')
		expect(files['vite.config.ts']).toContain('app.plugin')
		// No generated federation config that could drift from spool.json.
		expect(files['vite.config.ts']).not.toContain('localhost')
		expect(files['vite.config.ts']).not.toContain('remotes:')
	})

	it('renders each remote through <Remote> in app.tsx', () => {
		expect(files['src/app/app.tsx']).toContain("import { Remote } from '@/federation'")
		expect(files['src/app/app.tsx']).toContain('<Remote name="dashboard"')
		expect(files['src/app/app.tsx']).not.toContain('lazy(')
	})

	it('declares ambient modules for the remotes', () => {
		expect(files['src/remotes.d.ts']).toContain("declare module 'dashboard/App'")
	})

	it('locks the build target for top-level await', () => {
		expect(files['vite.config.ts']).toContain("target: 'esnext'")
	})
})

/*
 *   APP FILES - HOST WITHOUT REMOTES
 ***************************************************************************************************/
describe('appFiles (host with no remotes)', () => {
	const m = makeManifest({ shell: host() })
	const files = appFiles(m, 'shell', m.apps.shell!)

	it('omits the remotes typing file', () => {
		expect(files['src/remotes.d.ts']).toBeUndefined()
	})

	it('says so in app.tsx, and imports nothing it does not use', () => {
		expect(files['src/app/app.tsx']).toContain('No remotes mounted yet')
		expect(files['src/app/app.tsx']).not.toContain('@/federation')
	})
})

/*
 *   APP FILES - REMOTE
 ***************************************************************************************************/
describe('appFiles (remote)', () => {
	const m = manifest()
	const files = appFiles(m, 'dashboard', m.apps.dashboard!)

	it('writes no public/_headers: the vite plugin emits it at build', () => {
		expect(files['public/_headers']).toBeUndefined()
	})

	it('derives its exposes from the manifest at startup', () => {
		expect(files['vite.config.ts']).toContain("spoolApp('dashboard'")
		expect(files['src/remotes.d.ts']).toBeUndefined()
	})

	it('passes the vite command through so deployed urls only apply to builds', () => {
		expect(files['vite.config.ts']).toContain('({ command })')
		expect(files['vite.config.ts']).toContain('root: import.meta.dirname, command')
	})

	it('pins the modern federation toolchain', () => {
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.devDependencies.vite).toBe('^8.0.0')
		expect(pkg.devDependencies['@vitejs/plugin-react']).toBe('^6.0.0')
		expect(pkg.devDependencies['@module-federation/vite']).toBe('^1.16.0')
	})
})

/*
 *   TYPED EXPOSES
 ***************************************************************************************************/
describe('remotes.d.ts: typed vs fallback', () => {
	it('falls back to the contract typing and a spool-types hint when nothing was emitted', () => {
		const dir = freshDir('spool-types-fallback-')
		const m = manifest()
		const typings = appFiles(m, 'shell', m.apps.shell!, NO_EXTRAS, dir)['src/remotes.d.ts']!

		expect(typings).toContain('Run `spool types`')
		expect(typings).toContain('const Component: React.ComponentType')
		removeDir(dir)
	})

	it('types a remote from its real export once spool types has run', () => {
		const dir = freshDir('spool-types-typed-')
		const declDir = join(dir, '.spool', 'types', 'dashboard', 'apps', 'dashboard', 'src', 'app')
		mkdirSync(declDir, { recursive: true })
		writeFileSync(
			join(declDir, 'app.d.ts'),
			'declare const Component: () => null;\nexport default Component;\n',
		)

		const m = manifest()
		const typings = appFiles(m, 'shell', m.apps.shell!, NO_EXTRAS, dir)['src/remotes.d.ts']!

		expect(typings).toContain('Typed by `spool types`')
		expect(typings).toContain('typeof import(')
		expect(typings).not.toContain('React.ComponentType')
		removeDir(dir)
	})
})

/*
 *   HOST WIRING FILES
 ***************************************************************************************************/
describe('hostWiringFiles', () => {
	it('regenerates the typings and the federation files when a host has remotes', () => {
		const m = manifest()
		const files = hostWiringFiles(m, m.apps.shell!)
		expect(Object.keys(files)).toEqual([
			'src/remotes.d.ts',
			...Object.keys(federationFiles(m, m.apps.shell!)),
		])
		expect(files['src/remotes.d.ts']).toContain("declare module 'dashboard/App'")
	})

	it('writes only the federation files when a host has no remotes yet', () => {
		const m = makeManifest({ shell: host() })
		expect(Object.keys(hostWiringFiles(m, m.apps.shell!))).toEqual(
			Object.keys(federationFiles(m, m.apps.shell!)),
		)
	})

	it('declares every expose a remote offers, not just App', () => {
		const m = makeManifest({
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote({
				exposes: {
					'./App': './src/app/app.tsx',
					'./Panel': './src/widgets/panel.tsx',
				},
			}),
		})
		const typings = hostWiringFiles(m, m.apps.shell!)['src/remotes.d.ts']!
		expect(typings).toContain("declare module 'dashboard/App'")
		expect(typings).toContain("declare module 'dashboard/Panel'")
	})

	it('keeps the registry keyed by App for a remote that only exposes App', () => {
		const m = makeManifest({
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		const typings = hostWiringFiles(m, m.apps.shell!)['src/remotes.d.ts']!
		expect(typings).toBe(
			"// Run `spool types` to type this from the remote's real export.\n" +
				"declare module 'dashboard/App' {\n\tconst Component: React.ComponentType\n\texport default Component\n}\n",
		)
	})
})

/*
 *   APP FILES - SVELTE
 ***************************************************************************************************/
describe('appFiles (svelte remote)', () => {
	const m = makeManifest({
		shell: host({ remotes: ['widget'] }),
		widget: remote({
			framework: 'svelte',
			path: 'apps/widget',
			exposes: { './App': './src/mount.ts' },
		}),
	})
	const files = appFiles(m, 'widget', m.apps.widget!)

	it('scaffolds svelte sources and the mount contract', () => {
		expect(files['src/app/app.svelte']).toContain('Svelte remote')
		expect(files['src/mount.ts']).toContain('export default function mountApp')
		expect(files['src/main.ts']).toContain('mount(App')
		expect(files['src/app/app.tsx']).toBeUndefined()
		expect(files['src/main.tsx']).toBeUndefined()
	})

	it('uses the svelte vite plugin and entry point', () => {
		expect(files['vite.config.ts']).toContain('@sveltejs/vite-plugin-svelte')
		expect(files['vite.config.ts']).not.toContain('@vitejs/plugin-react')
		expect(files['index.html']).toContain('/src/main.ts"')
	})

	it('declares svelte deps and no react deps', () => {
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.dependencies.svelte).toBeDefined()
		expect(pkg.dependencies.react).toBeUndefined()
		expect(pkg.devDependencies['@sveltejs/vite-plugin-svelte']).toBeDefined()
	})

	it('lets plain tsc resolve .svelte imports', () => {
		expect(files['src/vite-env.d.ts']).toContain("declare module '*.svelte'")
	})
})

describe('appFiles (react host with a svelte remote)', () => {
	const m = makeManifest({
		shell: host({ remotes: ['dashboard', 'widget'] }),
		dashboard: remote(),
		widget: remote({
			framework: 'svelte',
			path: 'apps/widget',
			port: 5175,
			exposes: { './App': './src/mount.ts' },
		}),
	})
	const files = appFiles(m, 'shell', m.apps.shell!)

	it('renders every remote through <Remote>, whatever its contract', () => {
		expect(files['src/app/app.tsx']).toContain('<Remote name="dashboard"')
		expect(files['src/app/app.tsx']).toContain('<Remote name="widget"')
		expect(files['src/app/app.tsx']).not.toContain('MountRemote')
	})

	it('types each remote by its contract', () => {
		const typings = files['src/remotes.d.ts']!
		expect(typings).toContain('const Component: React.ComponentType')
		expect(typings).toContain(
			'const mount: (target: HTMLElement, props?: Record<string, unknown>) => () => void',
		)
	})

	it('needs no svelte deps, since mount-contract remotes are self-contained', () => {
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.dependencies.svelte).toBeUndefined()
		expect(pkg.devDependencies['@sveltejs/vite-plugin-svelte']).toBeUndefined()
	})
})

describe('appFiles (svelte host with a react remote)', () => {
	const m = makeManifest({
		shell: host({ framework: 'svelte', remotes: ['dashboard'] }),
		dashboard: remote(),
	})
	const files = appFiles(m, 'shell', m.apps.shell!)

	it('bridges react remotes and ships both frameworks', () => {
		expect(files['src/react-bridge.ts']).toContain('createRoot')
		expect(files['src/app/app.svelte']).toContain('<Remote name="dashboard">')
		expect(files['src/app/app.svelte']).not.toContain('mountReact')
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.dependencies.svelte).toBeDefined()
		expect(pkg.dependencies.react).toBeDefined()
		expect(pkg.dependencies['react-dom']).toBeDefined()
	})

	it('takes the react types for the bridge but not the react vite plugin', () => {
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.devDependencies['@types/react']).toBeDefined()
		expect(pkg.devDependencies['@vitejs/plugin-react']).toBeUndefined()
	})

	it('leaves mounting, and its unmount races, to <Remote>', () => {
		expect(files['src/app/app.svelte']).not.toContain('onMount')
		expect(files['src/app/app.svelte']).not.toContain('cancelled')
	})
})

/*
 *   APP FILES - VUE
 ***************************************************************************************************/
describe('appFiles (vue remote)', () => {
	const m = makeManifest({
		shell: host({ remotes: ['widget'] }),
		widget: remote({
			framework: 'vue',
			path: 'apps/widget',
			exposes: { './App': './src/mount.ts' },
		}),
	})
	const files = appFiles(m, 'widget', m.apps.widget!)

	it('scaffolds vue sources and the mount contract', () => {
		expect(files['src/app/app.vue']).toContain('Vue remote')
		expect(files['src/mount.ts']).toContain('export default function mountApp')
		expect(files['src/main.ts']).toContain('createApp(App)')
		expect(files['src/app/app.tsx']).toBeUndefined()
		expect(files['src/main.tsx']).toBeUndefined()
	})

	it('uses the vue vite plugin and entry point', () => {
		expect(files['vite.config.ts']).toContain('@vitejs/plugin-vue')
		expect(files['vite.config.ts']).not.toContain('@vitejs/plugin-react')
		expect(files['index.html']).toContain('/src/main.ts"')
	})

	it('declares vue deps and no react deps', () => {
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.dependencies.vue).toBeDefined()
		expect(pkg.dependencies.react).toBeUndefined()
		expect(pkg.devDependencies['@vitejs/plugin-vue']).toBeDefined()
	})

	it('lets plain tsc resolve .vue imports', () => {
		expect(files['src/vite-env.d.ts']).toContain("declare module '*.vue'")
	})
})

describe('appFiles (react host with a vue remote)', () => {
	const m = makeManifest({
		shell: host({ remotes: ['widget'] }),
		widget: remote({
			framework: 'vue',
			path: 'apps/widget',
			exposes: { './App': './src/mount.ts' },
		}),
	})
	const files = appFiles(m, 'shell', m.apps.shell!)

	it('mounts the vue remote through <Remote>', () => {
		expect(files['src/app/app.tsx']).toContain('<Remote name="widget"')
		expect(files['src/app/app.tsx']).not.toContain('MountRemote')
	})

	it('needs no vue deps, since mount-contract remotes are self-contained', () => {
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.dependencies.vue).toBeUndefined()
		expect(pkg.devDependencies['@vitejs/plugin-vue']).toBeUndefined()
	})
})

describe('appFiles (vue host with mixed remotes)', () => {
	const m = makeManifest({
		shell: host({ framework: 'vue', remotes: ['dashboard', 'widget'] }),
		dashboard: remote(),
		widget: remote({
			framework: 'svelte',
			path: 'apps/widget',
			port: 5175,
			exposes: { './App': './src/mount.ts' },
		}),
	})
	const files = appFiles(m, 'shell', m.apps.shell!)

	it('bridges react remotes and mounts contract remotes directly', () => {
		expect(files['src/react-bridge.ts']).toContain('createRoot')
		expect(files['src/app/app.vue']).toContain('<Remote name="dashboard">')
		expect(files['src/app/app.vue']).toContain('<Remote name="widget">')
		expect(files['src/app/app.vue']).not.toContain('mountReact')
	})

	it('ships the react bridge runtime but neither vite plugin nor svelte', () => {
		const pkg = JSON.parse(files['package.json']!)
		expect(pkg.dependencies.vue).toBeDefined()
		expect(pkg.dependencies.react).toBeDefined()
		expect(pkg.devDependencies['@types/react']).toBeDefined()
		expect(pkg.devDependencies['@vitejs/plugin-react']).toBeUndefined()
		expect(pkg.dependencies.svelte).toBeUndefined()
	})

	it('leaves mounting, and its unmount races, to <Remote>', () => {
		expect(files['src/app/app.vue']).not.toContain('onMounted')
		expect(files['src/app/app.vue']).not.toContain('cancelled')
	})

	it('types each remote by its contract', () => {
		const typings = files['src/remotes.d.ts']!
		expect(typings).toContain('const Component: React.ComponentType')
		expect(typings).toContain(
			'const mount: (target: HTMLElement, props?: Record<string, unknown>) => () => void',
		)
	})
})

describe('appFiles (mount-contract hosts with no remotes)', () => {
	it('imports nothing, so fresh scaffolds pass unused-import lint', () => {
		const svelteM = makeManifest({ shell: host({ framework: 'svelte' }) })
		expect(appFiles(svelteM, 'shell', svelteM.apps.shell!)['src/app/app.svelte']).not.toContain(
			'import',
		)
		const vueM = makeManifest({ shell: host({ framework: 'vue' }) })
		expect(appFiles(vueM, 'shell', vueM.apps.shell!)['src/app/app.vue']).not.toContain('import')
	})
})

/*
 *   APP FILES - STATE EXAMPLE EXTRAS
 ***************************************************************************************************/
describe('appFiles (state example extras)', () => {
	const plain = { ...NO_EXTRAS, stateExample: true }
	const withUi = { ...NO_EXTRAS, stateExample: true, uiButton: true }
	const m = makeManifest({
		shell: host({ remotes: ['dash', 'widget', 'vapp'] }),
		dash: remote({ path: 'apps/dash' }),
		widget: remote({
			framework: 'svelte',
			path: 'apps/widget',
			port: 5175,
			exposes: { './App': './src/mount.ts' },
		}),
		vapp: remote({
			framework: 'vue',
			path: 'apps/vapp',
			port: 5176,
			exposes: { './App': './src/mount.ts' },
		}),
	})

	it('gives react remotes a counter with a plain button by default', () => {
		const app = appFiles(m, 'dash', m.apps.dash!, plain)['src/app/app.tsx']!
		expect(app).toContain('useStore(counterStore, s => s.count)')
		expect(app).toContain('<button onClick={handleIncrement}>Increment</button>')
		expect(app).not.toContain("from 'ui'")
	})

	it('uses the ladle ui button when both addons are picked', () => {
		const files = appFiles(m, 'dash', m.apps.dash!, withUi)
		expect(files['src/app/app.tsx']).toContain("import { Button } from 'ui'")
		expect(files['src/app/app.tsx']).toContain(
			'<Button onClick={handleIncrement}>Increment</Button>',
		)
		expect(JSON.parse(files['package.json']!).dependencies.ui).toBe('workspace:*')
	})

	it('never puts the ui dep on hosts or non-react apps', () => {
		expect(
			JSON.parse(appFiles(m, 'shell', m.apps.shell!, withUi)['package.json']!).dependencies
				.ui,
		).toBeUndefined()
		expect(
			JSON.parse(appFiles(m, 'widget', m.apps.widget!, withUi)['package.json']!).dependencies
				.ui,
		).toBeUndefined()
	})

	it('shows the shared count on the host with a stable test id', () => {
		const app = appFiles(m, 'shell', m.apps.shell!, plain)['src/app/app.tsx']!
		expect(app).toContain('data-testid="shared-count"')
		expect(app).toContain('useStore(counterStore, s => s.count)')
	})

	it('wires the counter into svelte and vue remotes with their own syntax', () => {
		const svelteApp = appFiles(m, 'widget', m.apps.widget!, plain)['src/app/app.svelte']!
		expect(svelteApp).toContain('counterStore.set(s => ({ count: s.count + 1 }))')
		expect(svelteApp).toContain('<button onclick={handleIncrement}>Increment</button>')
		expect(svelteApp).toContain('{count}')

		const vueApp = appFiles(m, 'vapp', m.apps.vapp!, plain)['src/app/app.vue']!
		expect(vueApp).toContain('counterStore.set(s => ({ count: s.count + 1 }))')
		expect(vueApp).toContain('<button @click="handleIncrement">Increment</button>')
	})

	it('shows the shared count on svelte and vue hosts too', () => {
		const svelteM = makeManifest({ shell: host({ framework: 'svelte' }) })
		expect(
			appFiles(svelteM, 'shell', svelteM.apps.shell!, plain)['src/app/app.svelte'],
		).toContain('data-testid="shared-count"')
		const vueM = makeManifest({ shell: host({ framework: 'vue' }) })
		expect(appFiles(vueM, 'shell', vueM.apps.shell!, plain)['src/app/app.vue']).toContain(
			'data-testid="shared-count"',
		)
	})

	it('changes nothing when no extras are passed', () => {
		const app = appFiles(m, 'dash', m.apps.dash!)['src/app/app.tsx']!
		expect(app).not.toContain('counterStore')
		expect(
			JSON.parse(appFiles(m, 'dash', m.apps.dash!)['package.json']!).dependencies.ui,
		).toBeUndefined()
	})
})

/*
 *   TSCONFIG - PER-FRAMEWORK COMPILER OPTIONS
 ***************************************************************************************************/
describe('app tsconfig', () => {
	it('keeps the JSX runtime per react app, out of the shared base', () => {
		const m = makeManifest({
			shell: host({ remotes: ['widget'] }),
			widget: remote({ framework: 'svelte', path: 'apps/widget' }),
		})
		expect(workspaceFiles(m)['tsconfig.base.json']).not.toContain('jsx')
		expect(appFiles(m, 'shell', m.apps.shell!)['tsconfig.json']).toContain('react-jsx')
		expect(appFiles(m, 'widget', m.apps.widget!)['tsconfig.json']).not.toContain('jsx')
	})
})

/*
 *   CI WORKFLOWS
 ***************************************************************************************************/
describe('ciWorkflows', () => {
	const m = makeManifest({
		shell: host({ remotes: ['dashboard'], deploy: 'deploy-shell-cmd' }),
		dashboard: remote({ deploy: 'wrangler pages deploy dist --project-name=dash' }),
		orphan: remote({ path: 'apps/orphan', port: 5175 }),
	})
	const files = ciWorkflows(m)

	it('generates a check workflow plus one deploy workflow per deployable app', () => {
		expect(Object.keys(files).sort()).toEqual([
			'.github/workflows/ci.yml',
			'.github/workflows/deploy-dashboard.yml',
			'.github/workflows/deploy-shell.yml',
		])
	})

	describe('the check workflow', () => {
		const scripts = { build: 'spool build', doctor: 'spool doctor', lint: 'eslint .' }
		const check = () => ciWorkflows(m, scripts)['.github/workflows/ci.yml']!

		it('runs the root scripts that exist, in a sensible order', () => {
			const yaml = check()

			expect(yaml.indexOf('run doctor')).toBeLessThan(yaml.indexOf('run lint'))
			expect(yaml.indexOf('run lint')).toBeLessThan(yaml.indexOf('run build'))
		})

		it('leaves out a script the workspace does not have', () => {
			expect(check()).not.toContain('run test')
			expect(check()).not.toContain('run type-check')
		})

		it('has no path filters', () => {
			expect(check()).not.toContain('paths:')
		})

		it('says the branch list needs checking', () => {
			expect(check()).toContain('change the branches list below if it is not main')
		})

		it('runs on pull requests', () => {
			expect(check()).toContain('pull_request:')
		})

		it('installs with the workspace package manager', () => {
			expect(check()).toContain('pnpm install --frozen-lockfile')
			expect(check()).toContain('pnpm/action-setup')
		})

		it('skips the pnpm setup action for npm', () => {
			const npm = makeManifest({ dashboard: remote() })
			npm.packageManager = 'npm'
			const yaml = ciWorkflows(npm, scripts)['.github/workflows/ci.yml']!

			expect(yaml).toContain('npm ci')
			expect(yaml).not.toContain('pnpm/action-setup')
		})
	})

	it('path-filters to the app folder plus the workspace-level files', () => {
		const yml = files['.github/workflows/deploy-dashboard.yml']!
		expect(yml).toContain("'apps/dashboard/**'")
		expect(yml).toContain("'spool.json'")
		expect(yml).not.toContain('spool.vite.ts')
		expect(yml).toContain("'pnpm-lock.yaml'")
		expect(yml).not.toContain("'apps/shell/**'")
	})

	it('bakes the deploy command in and builds in the app folder', () => {
		const yml = files['.github/workflows/deploy-dashboard.yml']!
		expect(yml).toContain('wrangler pages deploy dist --project-name=dash')
		expect(yml).toContain("working-directory: 'apps/dashboard'")
		expect(yml).toContain('pnpm run build')
	})

	it('supports manual runs', () => {
		expect(files['.github/workflows/deploy-shell.yml']).toContain('workflow_dispatch')
	})

	it('adapts the setup to the package manager', () => {
		const npm = ciWorkflows(
			parseManifest({
				name: 'acme',
				version: 2,
				packageManager: 'npm',
				apps: { dash: { ...remote(), deploy: 'x' } },
			}),
		)['.github/workflows/deploy-dash.yml']!
		expect(npm).toContain('npm ci')
		expect(npm).toContain("'package-lock.json'")
		expect(npm).not.toContain('pnpm/action-setup')

		const pnpm = files['.github/workflows/deploy-dashboard.yml']!
		expect(pnpm).toContain('pnpm/action-setup')
		expect(pnpm).toContain('pnpm install --frozen-lockfile')
	})
})

/*
 *   STYLE GUARANTEES
 ***************************************************************************************************/
describe('generated content', () => {
	it('never contains an em dash', () => {
		const m = manifest()
		const all = [
			...Object.values(workspaceFiles(m)),
			...Object.values(appFiles(m, 'shell', m.apps.shell!)),
			...Object.values(appFiles(m, 'dashboard', m.apps.dashboard!)),
		].join('\n')
		expect(all).not.toContain('—')
	})
})

/*
 *   WORKSPACE FILE STYLE AND ROOT NAME
 ***************************************************************************************************/
describe('pnpm-workspace.yaml', () => {
	const yaml = workspaceFiles(manifest(), ['@sentry/cli'])['pnpm-workspace.yaml']!

	it('is written in the 2-space form pnpm re-serialises, so an install leaves it as it was', () => {
		expect(yaml).toContain("packages:\n  - 'apps/*'\n  - 'packages/*'")
		expect(yaml).toContain("allowBuilds:\n  '@sentry/cli': true\n  esbuild: true")
		expect(yaml).not.toMatch(/^ {4}/m)
	})

	it('is left out of prettier, which would fight pnpm over it', () => {
		const ignored = workspaceFiles(manifest())['.prettierignore']!.split('\n')

		expect(ignored).toContain('pnpm-workspace.yaml')
	})
})

describe('root package name', () => {
	it.each(['ws', 'typescript', 'eslint', 'acme'])(
		'never equals the workspace name %s, which pnpm would resolve as a dependency',
		name => {
			const files = workspaceFiles(parseManifest({ ...manifest(), name }))
			const pkg = JSON.parse(files['package.json']!) as { name: string }

			expect(pkg.name).toBe(`${name}-workspace`)
		},
	)
})

/*
 *   PRETTIER AND SVELTE
 ***************************************************************************************************/
describe('.prettierrc and the Svelte plugin', () => {
	const withApps = (framework: 'react' | 'svelte', addons: string[]): Manifest => {
		const m = makeManifest({
			shell: host({ remotes: ['dashboard'], framework }),
			dashboard: remote({ framework }),
		})

		m.addons = addons as Manifest['addons']

		return m
	}

	it('lists prettier-plugin-svelte, and installs it, when a Svelte workspace lints', () => {
		const m = withApps('svelte', ['lint'])

		expect(workspaceFiles(m)['.prettierrc']).toContain('plugins:\n    - prettier-plugin-svelte')
		expect(rootDevDependencies(m)).toHaveProperty('prettier-plugin-svelte')
	})

	it('lists no plugin where nothing would install it', () => {
		for (const m of [withApps('svelte', []), withApps('react', ['lint'])]) {
			expect(workspaceFiles(m)['.prettierrc']).not.toContain('plugins')
			expect(rootDevDependencies(m)).not.toHaveProperty('prettier-plugin-svelte')
		}
	})
})
