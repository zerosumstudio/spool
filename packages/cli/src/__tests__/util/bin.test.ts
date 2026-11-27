/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	findInstalledManifest,
	ladleInvocation,
	resolvePackageBin,
	viteInvocation,
} from '../../util/bin.js'
import { freshDir, removeDir } from '../helpers.js'

/*
 *   FIXTURE
 ***************************************************************************************************/
let root: string
let app: string

/** A package in node_modules whose exports hide its bin, as vite's do. */
function install(
	dir: string,
	name: string,
	bin: string | Record<string, string> | undefined,
): void {
	const folder = join(dir, 'node_modules', name)

	mkdirSync(join(folder, 'bin'), { recursive: true })
	writeFileSync(
		join(folder, 'package.json'),
		JSON.stringify({
			name,
			version: '1.0.0',
			exports: { '.': './index.js', './package.json': './package.json' },
			...(bin === undefined ? {} : { bin }),
		}),
	)
	writeFileSync(join(folder, 'index.js'), '')
}

beforeEach(() => {
	root = freshDir('spool-bin-')
	app = join(root, 'apps', 'shell')
	mkdirSync(app, { recursive: true })
	writeFileSync(join(app, 'package.json'), '{}')
})

afterEach(() => {
	removeDir(root)
})

/*
 *   RESOLVE
 ***************************************************************************************************/
describe('resolvePackageBin', () => {
	it('finds the bin script through the exported package.json, since bin/ is not an export', () => {
		install(app, 'vite', { vite: 'bin/vite.js' })

		expect(resolvePackageBin(app, 'vite', 'vite', root)).toBe(
			join(app, 'node_modules', 'vite', 'bin/vite.js'),
		)
	})

	it('reads a bin written as a string', () => {
		install(app, 'tool', 'cli.js')

		expect(resolvePackageBin(app, 'tool', 'anything', root)).toBe(
			join(app, 'node_modules', 'tool', 'cli.js'),
		)
	})

	it('resolves from the workspace root when the app has no copy of its own', () => {
		install(root, 'vite', { vite: 'bin/vite.js' })

		expect(resolvePackageBin(app, 'vite', 'vite', root)).toBe(
			join(root, 'node_modules', 'vite', 'bin/vite.js'),
		)
	})

	it('says to install when the package is missing', () => {
		expect(() => resolvePackageBin(app, 'spool-no-such-package-xyz', 'x', root)).toThrow(
			'Install the workspace',
		)
	})

	it('names the command a package lacks', () => {
		install(app, 'vite', { other: 'bin/other.js' })

		expect(() => resolvePackageBin(app, 'vite', 'vite', root)).toThrow('has no "vite" command')
	})
})

/*
 *   INVOCATIONS
 ***************************************************************************************************/
describe('viteInvocation', () => {
	it('runs the installed vite under the node running spool, never a package manager', () => {
		install(app, 'vite', { vite: 'bin/vite.js' })
		const script = join(app, 'node_modules', 'vite', 'bin/vite.js')

		expect(viteInvocation(app, 'dev', root)).toEqual({
			command: process.execPath,
			args: [script],
		})
		expect(viteInvocation(app, 'preview', root)).toEqual({
			command: process.execPath,
			args: [script, 'preview'],
		})
		expect(viteInvocation(app, 'build', root)).toEqual({
			command: process.execPath,
			args: [script, 'build'],
		})
	})
})

describe('ladleInvocation', () => {
	it('serves the workshop from the ui package', () => {
		install(app, '@ladle/react', { ladle: 'lib/cli/cli.js' })

		expect(ladleInvocation(app, root)).toEqual({
			command: process.execPath,
			args: [join(app, 'node_modules', '@ladle/react', 'lib/cli/cli.js'), 'serve'],
		})
	})
})

/*
 *   STOPS AT THE WORKSPACE
 ***************************************************************************************************/
describe('findInstalledManifest', () => {
	it('finds a package hoisted to the workspace root', () => {
		install(root, 'prettier', undefined)

		expect(findInstalledManifest(app, 'prettier', root)).toBe(
			join(root, 'node_modules', 'prettier', 'package.json'),
		)
	})

	it('never looks above the workspace, where anything could have been planted', () => {
		const workspace = join(root, 'ws')
		const inner = join(workspace, 'apps', 'shell')

		mkdirSync(inner, { recursive: true })
		install(root, 'prettier', undefined)

		expect(findInstalledManifest(inner, 'prettier', workspace)).toBeUndefined()
		expect(() => resolvePackageBin(inner, 'prettier', 'prettier', workspace)).toThrow(
			'Could not find "prettier"',
		)
	})

	it('only checks the folder itself when it is not inside the workspace at all', () => {
		const elsewhere = join(root, 'elsewhere')

		mkdirSync(elsewhere, { recursive: true })
		install(root, 'prettier', undefined)

		expect(findInstalledManifest(elsewhere, 'prettier', join(root, 'ws'))).toBeUndefined()
	})
})
