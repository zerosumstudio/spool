/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as prettier from 'prettier'
import { PRETTIER_OPTIONS, resetFormatCache } from '../../core/format.js'
import { ADDONS } from '../../core/addons.js'
import { appFiles, workspaceFiles } from '../../core/generators.js'
import { syncRemoteTypings } from '../../core/typings.js'
import {
	appDependencies,
	NODE_RANGE,
	NODE_VERSION,
	rootDevDependencies,
	SHARED_EXTRAS,
} from '../../core/versions.js'
import { isUpgrade, rangeFloor } from '../../util/semver.js'
import { makeWorkspace, makeManifest, host, remote, freshDir, removeDir } from '../helpers.js'

/*
 *   HELPERS
 ***************************************************************************************************/
const withAddons = (pm: 'pnpm' | 'npm' | 'yarn', addons: string[] = []) => {
	const m = makeManifest({ shell: host({ remotes: ['dashboard'] }), dashboard: remote() })

	m.packageManager = pm
	m.addons = addons as typeof m.addons
	return m
}

/*
 *   ROOT FILES
 ***************************************************************************************************/
describe('workspace root files', () => {
	it('pins node 26 for engines and .nvmrc', () => {
		const files = workspaceFiles(withAddons('pnpm'))

		expect(NODE_RANGE).toBe('>=26')
		expect(NODE_VERSION).toBe('26')
		expect(files['.nvmrc']).toBe('26\n')
		expect(JSON.parse(files['package.json']!).engines).toEqual({ node: '>=26' })
	})

	it('pins the same engines in every app', () => {
		const m = withAddons('pnpm')
		const pkg = JSON.parse(appFiles(m, 'shell', m.apps.shell!)['package.json']!)

		expect(pkg.engines).toEqual({ node: '>=26' })
	})

	it('shares clutch 1.0 across the federation boundary', () => {
		expect(SHARED_EXTRAS['@zerosumstudio/clutch']).toBe('^1.0.0')
	})

	it('reads a bare major as a range floor, so an older workspace is upgraded to node 26', () => {
		expect(rangeFloor('>=26')).toEqual([26, 0, 0])
		expect(isUpgrade('>=22.13.0', '>=26')).toBe(true)
		expect(isUpgrade('^20.19.0 || >=22.12.0', '>=26')).toBe(true)
		expect(isUpgrade('>=26', '>=26')).toBe(false)
		expect(isUpgrade('>=28', '>=26')).toBe(false)
	})

	it('adds prettier and the format scripts with the lint addon, and only then', () => {
		const lint = withAddons('pnpm', ['lint'])
		const plain = withAddons('pnpm')
		const scripts = JSON.parse(workspaceFiles(lint)['package.json']!).scripts

		expect(rootDevDependencies(lint)).toHaveProperty('prettier')
		expect(scripts.format).toBe('prettier --write .')
		expect(scripts['format:check']).toBe('prettier --check .')
		expect(rootDevDependencies(plain)).not.toHaveProperty('prettier')
		expect(JSON.parse(workspaceFiles(plain)['package.json']!).scripts).not.toHaveProperty(
			'format',
		)
	})

	it('ships the house .prettierrc with a trailing comma everywhere', () => {
		const rc = workspaceFiles(withAddons('pnpm'))['.prettierrc']!

		expect(rc).toBe(
			`${Object.entries(PRETTIER_OPTIONS)
				.map(([key, value]) => `${key}: ${String(value)}`)
				.join('\n')}\n`,
		)
		expect(rc).not.toContain('{')
		expect(PRETTIER_OPTIONS.trailingComma).toBe('all')
	})
})

/*
 *   ALREADY FORMATTED
 ***************************************************************************************************/
describe('the files spool owns are already prettier clean', () => {
	for (const pm of ['pnpm', 'npm', 'yarn'] as const) {
		it(`for the ${pm} root files and every app's package, tsconfig and index.html`, async () => {
			const m = withAddons(pm, ['lint', 'turbo'])
			const files: Record<string, string> = { ...workspaceFiles(m) }

			for (const [name, app] of Object.entries(m.apps)) {
				const generated = appFiles(m, name, app)

				for (const rel of ['package.json', 'tsconfig.json', 'index.html']) {
					files[`${app.path}/${rel}`] = generated[rel]!
				}
			}

			const ignored = files['.prettierignore']!.split('\n')

			for (const [rel, content] of Object.entries(files)) {
				if (ignored.includes(rel)) continue

				const { inferredParser } = await prettier.getFileInfo(rel)
				if (!inferredParser) continue

				const clean = await prettier.check(content, { ...PRETTIER_OPTIONS, filepath: rel })

				expect(clean, rel).toBe(true)
			}
		})
	}

	it('also holds for an app that exposes and consumes, with a nested path', async () => {
		const m = makeManifest({
			shell: host({ path: 'packages/web/shell', remotes: ['widget'] }),
			widget: remote({ path: 'packages/web/widget', remotes: [] }),
		})
		const content = appFiles(m, 'shell', m.apps.shell!)['package.json']!

		expect(
			await prettier.check(content, { ...PRETTIER_OPTIONS, filepath: 'package.json' }),
		).toBe(true)
	})
})

describe('app dependencies', () => {
	it('gives every host the federation runtime', () => {
		const m = withAddons('pnpm')

		expect(appDependencies(m, m.apps.shell!).dependencies).toHaveProperty(
			'@module-federation/runtime',
		)
	})
})

/*
 *   TYPINGS DO NOT LOAD PRETTIER
 ***************************************************************************************************/
describe('syncRemoteTypings', () => {
	let root: string

	/** A workspace prettier that leaves a marker file the moment anything imports it. */
	function installProbePrettier(into: string): string {
		const dir = join(into, 'node_modules', 'prettier')
		const marker = join(into, 'prettier-was-loaded.txt')

		mkdirSync(dir, { recursive: true })
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({ name: 'prettier', type: 'module', main: 'index.js' }),
		)
		writeFileSync(
			join(dir, 'index.js'),
			`import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'loaded')
export const format = async source => source
export const getFileInfo = async () => ({ inferredParser: 'typescript' })
export const resolveConfig = async () => null
`,
		)

		return marker
	}

	beforeEach(() => {
		root = freshDir('spool-typings-')
		resetFormatCache()
	})

	afterEach(() => {
		removeDir(root)
	})

	const seed = () => {
		const ws = makeWorkspace(root, {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		const typings = join(root, 'apps/shell/src/remotes.d.ts')

		mkdirSync(dirname(typings), { recursive: true })
		return { ws, typings }
	}

	it('never loads prettier when the typings on disk are already what is generated', async () => {
		const marker = installProbePrettier(root)
		const { ws, typings } = seed()

		await syncRemoteTypings(ws)
		expect(readFileSync(typings, 'utf8')).toContain('dashboard')

		await syncRemoteTypings(ws)
		await syncRemoteTypings(ws)

		expect(() => readFileSync(marker, 'utf8')).toThrow()
	})

	it('asks the workspace prettier only once the generated typings differ from the file', async () => {
		const marker = installProbePrettier(root)
		const { ws, typings } = seed()

		writeFileSync(typings, '// something else\n')
		await syncRemoteTypings(ws)

		expect(readFileSync(marker, 'utf8')).toBe('loaded')
	})
})

/*
 *   RUNTIME DEPENDENCIES
 ***************************************************************************************************/
describe('the CLI package', () => {
	it('depends on @clack/prompts alone at run time, and keeps prettier for its own tests', () => {
		const pkg = JSON.parse(
			readFileSync(join(import.meta.dirname, '../../../package.json'), 'utf8'),
		) as {
			dependencies: Record<string, string>
			devDependencies: Record<string, string>
			engines: { node: string }
		}

		expect(Object.keys(pkg.dependencies)).toEqual(['@clack/prompts'])
		expect(pkg.devDependencies).toHaveProperty('prettier')
		expect(pkg.engines.node).toBe('>=26')
	})
})

/*
 *   TYPE-CHECK PER FRAMEWORK
 ***************************************************************************************************/
describe('each app type-checks with the checker its framework needs', () => {
	const build = (framework: 'react' | 'vue' | 'svelte') => {
		const m = makeManifest({ shell: host({ framework }) })
		const files = appFiles(m, 'shell', m.apps.shell!)

		return JSON.parse(files['package.json']!) as {
			scripts: Record<string, string>
			devDependencies: Record<string, string>
		}
	}

	it('runs plain tsc for react', () => {
		const pkg = build('react')

		expect(pkg.scripts['type-check']).toBe('tsc --noEmit')
		expect(pkg.devDependencies).not.toHaveProperty('vue-tsc')
		expect(pkg.devDependencies).not.toHaveProperty('svelte-check')
	})

	it('runs vue-tsc for vue and installs it', () => {
		const pkg = build('vue')

		expect(pkg.scripts['type-check']).toBe('vue-tsc --noEmit')
		expect(pkg.devDependencies['vue-tsc']).toBe('^3.3.14')
		expect(pkg.devDependencies).not.toHaveProperty('svelte-check')
	})

	it('runs svelte-check for svelte and installs it', () => {
		const pkg = build('svelte')

		expect(pkg.scripts['type-check']).toBe('svelte-check --tsconfig ./tsconfig.json')
		expect(pkg.devDependencies['svelte-check']).toBe('^4.7.8')
		expect(pkg.devDependencies).not.toHaveProperty('vue-tsc')
	})
})

/*
 *   ADDON JSON
 ***************************************************************************************************/
describe('addon JSON files are printed the way prettier prints them', () => {
	it('for turbo.json and the e2e and ui packages', async () => {
		const m = withAddons('pnpm', ['turbo', 'playwright', 'ladle'])
		const printed: string[] = []

		for (const addon of ['turbo', 'playwright', 'ladle'] as const) {
			for (const [rel, content] of Object.entries(ADDONS[addon].files(m))) {
				if (!rel.endsWith('.json')) continue

				printed.push(rel)
				expect(
					await prettier.check(content, { ...PRETTIER_OPTIONS, filepath: rel }),
					rel,
				).toBe(true)
			}
		}

		expect(printed).toEqual(expect.arrayContaining(['turbo.json']))
		expect(printed.some(rel => rel.startsWith('packages/'))).toBe(true)
	})
})
