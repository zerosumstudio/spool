/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { formatFile, formatFiles, resetFormatCache, PRETTIER_OPTIONS } from '../../core/format.js'
import { freshDir, removeDir } from '../helpers.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
let root: string

const UNFORMATTED = { 'a.ts': 'export const list = [\n\t1,\n\t2,\n]\n' }

/** The real prettier this repo develops with, linked in as if the workspace had installed it. */
function installPrettier(into: string): void {
	const manifest = createRequire(import.meta.url).resolve('prettier/package.json')
	const target = join(into, 'node_modules', 'prettier')

	mkdirSync(dirname(target), { recursive: true })
	symlinkSync(dirname(manifest), target, 'junction')
}

/** A stand-in that only records that it ran, to tell whose prettier did the work. */
function installFakePrettier(into: string, tag: string): void {
	const dir = join(into, 'node_modules', 'prettier')

	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'prettier', version: '0.0.0', main: 'index.js' }),
	)
	writeFileSync(
		join(dir, 'index.js'),
		`export const format = async source => '${tag}:' + source
export const getFileInfo = async () => ({ inferredParser: 'typescript' })
export const resolveConfig = async () => null
`,
	)
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify({ name: 'prettier', type: 'module', main: 'index.js' }),
	)
}

beforeEach(() => {
	root = freshDir('spool-format-')
	resetFormatCache()
})

afterEach(() => {
	removeDir(root)
})

/*
 *   HOUSE STYLE
 ***************************************************************************************************/
describe('PRETTIER_OPTIONS', () => {
	it('is the house style, with a trailing comma everywhere it is valid', () => {
		expect(PRETTIER_OPTIONS).toMatchObject({
			trailingComma: 'all',
			useTabs: true,
			tabWidth: 4,
			singleQuote: true,
			semi: false,
			printWidth: 100,
			arrowParens: 'avoid',
		})
	})
})

/*
 *   WITHOUT PRETTIER
 ***************************************************************************************************/
describe('formatFiles in a workspace with no prettier', () => {
	it('writes source files exactly as generated', async () => {
		const out = await formatFiles(UNFORMATTED, root)

		expect(out).toEqual(UNFORMATTED)
	})

	it('writes them as generated when no root is given either', async () => {
		expect(await formatFiles(UNFORMATTED)).toEqual(UNFORMATTED)
	})

	it('prints JSON itself, in prettier style', async () => {
		const out = await formatFiles(
			{
				'tsconfig.json': '{"extends":"./base.json","include":["src"]}',
				'package.json': '{"a":{"b":1}}',
			},
			root,
		)

		expect(out['tsconfig.json']).toBe('{ "extends": "./base.json", "include": ["src"] }\n')
		expect(out['package.json']).toBe('{\n\t"a": {\n\t\t"b": 1\n\t}\n}\n')
	})

	it('leaves JSON it cannot parse alone', async () => {
		expect(await formatFiles({ 'broken.json': '{ not json' }, root)).toEqual({
			'broken.json': '{ not json',
		})
	})

	it('passes files with no parser through, such as .gitignore', async () => {
		expect(await formatFiles({ '.gitignore': 'node_modules/\n' }, root)).toEqual({
			'.gitignore': 'node_modules/\n',
		})
	})

	it('does not borrow the prettier the CLI itself can load', async () => {
		// This repo has prettier installed, and the tmp workspace has none.
		const out = await formatFile('a.ts', "export const name = 'x';\n", root)

		expect(out).toBe("export const name = 'x';\n")
	})
})

/*
 *   WITH THE WORKSPACE'S PRETTIER
 ***************************************************************************************************/
describe('formatFiles in a workspace that installed prettier', () => {
	it('formats with the workspace prettier, found from its own node_modules', async () => {
		installFakePrettier(root, 'ws')

		const out = await formatFiles({ 'a.ts': 'x' }, root)

		expect(out['a.ts']).toBe('ws:x')
	})

	it('does not look above the folder it formats for, which is the workspace root', async () => {
		installFakePrettier(root, 'hoisted')
		const nested = join(root, 'apps', 'shell')
		mkdirSync(nested, { recursive: true })

		expect((await formatFiles({ 'a.ts': 'x' }, nested))['a.ts']).toBe('x')
	})

	it('follows the workspace prettier config', async () => {
		installPrettier(root)
		writeFileSync(join(root, '.prettierrc'), JSON.stringify({ semi: true, singleQuote: false }))

		const out = await formatFiles({ 'a.ts': "export const name = 'x'\n" }, root)

		expect(out['a.ts']).toBe('export const name = "x";\n')
	})

	it('keeps the house style for anything the workspace does not set', async () => {
		installPrettier(root)
		writeFileSync(join(root, '.prettierrc'), JSON.stringify({ semi: true }))

		const out = await formatFiles({ 'a.ts': 'export const name = "x"\n' }, root)

		expect(out['a.ts']).toBe("export const name = 'x';\n")
	})

	it('formats with the house style when the workspace has prettier but no config', async () => {
		installPrettier(root)

		const out = await formatFiles({ 'a.ts': 'export const list = [\n\t1,\n\t2,\n]\n' }, root)

		expect(out['a.ts']).toBe('export const list = [1, 2]\n')
	})

	it('falls back to writing as generated when the installed prettier cannot be loaded', async () => {
		const dir = join(root, 'node_modules', 'prettier')
		mkdirSync(dir, { recursive: true })
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({ name: 'prettier', main: 'missing.js' }),
		)

		expect(await formatFiles(UNFORMATTED, root)).toEqual(UNFORMATTED)
	})
})
