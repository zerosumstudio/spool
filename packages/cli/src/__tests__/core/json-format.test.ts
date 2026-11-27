/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import * as prettier from 'prettier'
import { PRETTIER_OPTIONS } from '../../core/format.js'
import { printJson, printJsonFor, printStringifiedJson } from '../../core/json-format.js'
import { makeManifest, host, remote } from '../helpers.js'

/*
 *   HELPERS
 ***************************************************************************************************/
/** What prettier makes of the compact JSON `JSON.stringify` writes, which is what spool used to feed it. */
async function prettierFormat(value: unknown, filepath: string): Promise<string> {
	return prettier.format(JSON.stringify(value), { ...PRETTIER_OPTIONS, filepath })
}

const words = (count: number, size = 9): string[] =>
	Array.from({ length: count }, (_, index) => `word${String(index).padStart(size - 4, '0')}`)

const FIXTURES: Record<string, unknown> = {
	scalars: { a: 1, b: 'two', c: true, d: null, e: -1.5 },
	empty: { object: {}, array: [], nested: { inner: {} } },
	'small nesting': { a: { b: { c: 1 } }, list: [1, 2, 3], names: ['x', 'y'] },
	unicode: { name: 'café ’ —', quote: 'say "hi"', slash: 'a\\b', tab: 'a\tb' },
	'array of small objects': {
		apps: [
			{ name: 'shell', port: 5173 },
			{ name: 'dashboard', port: 5174 },
		],
	},
	'array of one object': { apps: [{ name: 'shell', port: 5173 }] },
	'array of single-key objects': { apps: [{ a: 1 }, { a: 2 }] },
	'array of arrays': {
		pairs: [
			[1, 2],
			[3, 4],
		],
		single: [[1], [2]],
	},
	'mixed array': { list: [{ a: 1, b: 2 }, 3] },
	'long array of words': { list: words(30) },
	'long object': Object.fromEntries(words(14).map(word => [word, word])),
	'long value on a key': { key: 'x'.repeat(120), other: 1 },
	'deep nesting': { a: { b: { c: { d: { e: { f: words(12) } } } } } },
	'object holding a forced break': {
		outer: {
			tasks: [
				{ a: 1, b: 2 },
				{ a: 3, b: 4 },
			],
		},
	},
	'array at the top': [
		{ a: 1, b: 2 },
		{ a: 3, b: 4 },
	],
	'a top level string': 'hello',
	'a top level number': 42,
}

/*
 *   MATCHING PRETTIER
 ***************************************************************************************************/
describe('printJson', () => {
	for (const [name, value] of Object.entries(FIXTURES)) {
		it(`matches prettier for ${name}`, async () => {
			expect(printJson(value)).toBe(await prettierFormat(value, 'data.json'))
		})
	}

	it('matches prettier at the print width boundary, one column either side', async () => {
		// An array whose one-line form is exactly 99, 100 and 101 columns wide inside a key.
		for (const extra of [-2, -1, 0, 1, 2, 3]) {
			const filler = 'x'.repeat(100 - '{ "k": ["", ""] }'.length + extra)
			const value = { k: [filler, ''] }

			expect(printJson(value), `extra ${extra}`).toBe(
				await prettierFormat(value, 'data.json'),
			)
		}
	})

	it('matches prettier when a trailing comma pushes a line over the width', async () => {
		for (const extra of [-2, -1, 0, 1, 2]) {
			const filler = 'x'.repeat(100 - '\t"a": { "k": "" },'.length + 3 + extra)
			const value = { a: { k: filler }, b: 1 }

			expect(printJson(value), `extra ${extra}`).toBe(
				await prettierFormat(value, 'data.json'),
			)
		}
	})

	it('matches prettier for the files spool writes', async () => {
		const manifest = makeManifest({
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote({ headers: { 'X-Test': '1' }, frameAncestors: ['self'] }),
		})

		for (const [value, file] of [
			[manifest, 'spool.json'],
			[
				{
					extends: './tsconfig.base.json',
					compilerOptions: { types: ['node'] },
					include: ['src'],
				},
				'tsconfig.json',
			],
		] as const) {
			expect(printJsonFor(file, value), file).toBe(await prettierFormat(value, file))
		}
	})

	it('ends with one newline and uses tabs', () => {
		const out = printJson({ list: words(30) })

		expect(out.endsWith('}\n')).toBe(true)
		expect(out).toContain('\n\t\t"word')
		expect(out).not.toMatch(/^ +/m)
	})

	it('round-trips through JSON.parse', () => {
		for (const value of Object.values(FIXTURES)) {
			expect(JSON.parse(printJson(value))).toEqual(value)
		}
	})
})

/*
 *   PACKAGE FILES
 ***************************************************************************************************/
describe('printStringifiedJson', () => {
	it('matches the json-stringify parser prettier uses for package.json', async () => {
		for (const [name, value] of Object.entries(FIXTURES)) {
			expect(printStringifiedJson(value), name).toBe(
				await prettierFormat(value, 'package.json'),
			)
		}
	})

	it('is what printJsonFor picks for package.json, package-lock.json and composer.json', async () => {
		const value = { name: 'x', scripts: { build: 'vite build' }, files: ['dist'] }

		for (const file of [
			'package.json',
			'apps/shell/package.json',
			'package-lock.json',
			'composer.json',
		]) {
			expect(printJsonFor(file, value), file).toBe(await prettierFormat(value, file))
		}
		expect(printJsonFor('tsconfig.json', value)).toBe(printJson(value))
	})
})
