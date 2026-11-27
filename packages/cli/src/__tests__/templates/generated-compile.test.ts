/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import * as ts from 'typescript'
import { transform } from 'esbuild'
import { compile } from 'svelte/compiler'
import { compileScript, compileTemplate, parse, registerTS } from 'vue/compiler-sfc'
import { ADDON_NAMES } from '../../core/addons.js'
import { SCAFFOLDS, scaffold } from './scaffolds.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
function checkSvelte(path: string, source: string): string[] {
	const { warnings } = compile(source, { filename: path, generate: 'client', runes: true })

	return warnings.map(warning => `${path}: ${warning.code} ${warning.message}`)
}

// Type-based props are resolved against the files they import, so the compiler reads the scaffold.
registerTS(() => ts)

function checkVue(path: string, source: string, files: Record<string, string>): string[] {
	const read = (file: string) =>
		file.startsWith('/ws/') ? files[file.slice('/ws/'.length)] : undefined

	const { descriptor, errors } = parse(source, { filename: `/ws/${path}` })
	const problems = errors.map(error => `${path}: ${error.message}`)
	if (descriptor.scriptSetup) {
		compileScript(descriptor, {
			id: path,
			inlineTemplate: false,
			fs: {
				fileExists: file => read(file) !== undefined,
				readFile: read,
			},
		})
	}
	if (descriptor.template) {
		const { errors: templateErrors } = compileTemplate({
			source: descriptor.template.content,
			filename: path,
			id: path,
		})
		problems.push(...templateErrors.map(error => `${path}: ${String(error)}`))
	}

	return problems
}

async function checkScript(path: string, source: string): Promise<string[]> {
	try {
		await transform(source, {
			loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
			jsx: 'automatic',
			format: 'esm',
		})

		return []
	} catch (error) {
		return [`${path}: ${error instanceof Error ? error.message : String(error)}`]
	}
}

/*
 *   COMPILES
 ***************************************************************************************************/
describe('generated source compiles with the real compilers', () => {
	for (const [label, build] of Object.entries(SCAFFOLDS)) {
		it(`${label}, every addon`, async () => {
			const files = scaffold(build(), [...ADDON_NAMES])
			const problems: string[] = []

			for (const [path, source] of Object.entries(files)) {
				if (path.endsWith('.svelte')) problems.push(...checkSvelte(path, source))
				else if (path.endsWith('.vue')) problems.push(...checkVue(path, source, files))
				else if (/\.tsx?$/.test(path)) problems.push(...(await checkScript(path, source)))
			}

			expect(problems).toEqual([])
		})
	}
})
