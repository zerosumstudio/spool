/*
 *   IMPORTS
 ***************************************************************************************************/
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import * as prettier from 'prettier'
import { ADDON_NAMES } from '../../core/addons.js'
import { SCAFFOLDS, scaffold } from './scaffolds.js'
import type { AddonName } from '../../core/config.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
const REPO_ROOT = join(import.meta.dirname, '../../../../..')

const NO_ADDONS: AddonName[] = []

async function houseOptions(): Promise<prettier.Options> {
	const config = await prettier.resolveConfig(join(REPO_ROOT, 'package.json'), {
		config: join(REPO_ROOT, '.prettierrc'),
	})

	return { ...config, endOfLine: 'lf' }
}

/** The files with a parser that is installed here. The rest (.gitignore, .npmrc) pass through. */
async function parserFor(path: string): Promise<string | undefined> {
	if (path.endsWith('.svelte')) return 'svelte'
	const { inferredParser } = await prettier.getFileInfo(path)

	return inferredParser ?? undefined
}

/** The first line prettier would change, so a failure says where to look. */
function firstDifference(content: string, formatted: string): string {
	const before = content.split('\n')
	const after = formatted.split('\n')
	const index = before.findIndex((line, i) => line !== after[i])

	return `line ${index + 1}, ${JSON.stringify(before[index])} should be ${JSON.stringify(after[index])}`
}

/*
 *   HOUSE STYLE
 ***************************************************************************************************/
describe('generated files are already in the house style', () => {
	const everyAddon = ADDON_NAMES

	for (const [label, build] of Object.entries(SCAFFOLDS)) {
		for (const [addonLabel, addons] of [
			['no addons', NO_ADDONS],
			['every addon', everyAddon],
		] as const) {
			it(`${label}, ${addonLabel}`, async () => {
				const options = await houseOptions()
				const files = scaffold(build(), [...addons])
				const changed: string[] = []

				const ignored = (files['.prettierignore'] ?? '').split('\n')

				for (const [path, content] of Object.entries(files)) {
					if (ignored.includes(path)) continue

					const parser = await parserFor(path)
					if (!parser) continue

					const formatted = await prettier.format(content, {
						...options,
						parser,
						plugins: parser === 'svelte' ? ['prettier-plugin-svelte'] : [],
					})
					if (formatted !== content)
						changed.push(`${path}: ${firstDifference(content, formatted)}`)
				}

				expect(changed).toEqual([])
			})
		}
	}
})
