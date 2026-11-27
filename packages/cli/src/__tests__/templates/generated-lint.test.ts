/*
 *   IMPORTS
 ***************************************************************************************************/
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { ESLint } from 'eslint'
import { ADDON_NAMES } from '../../core/addons.js'
import { SCAFFOLDS, scaffold } from './scaffolds.js'
import type { AddonName } from '../../core/config.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
const CLI_ROOT = join(import.meta.dirname, '../../..')
// Inside the package, so react, vue, svelte, the Sentry SDKs and the lint plugins resolve from its
// node_modules the way they would from a generated workspace's own.
const SCRATCH = join(CLI_ROOT, `.spool-lint-${process.pid}`)
const STUBS = join(import.meta.dirname, 'lint-stubs')

/** The packages a generated workspace installs that are not worth installing here. Their types
 * are written out in `lint-stubs`, to the shape of the real ones. */
const STUBBED_PACKAGES: Record<string, string> = {
	clutch: '@zerosumstudio/clutch',
	ui: 'ui',
	ladle: '@ladle/react',
	'mf-vite': '@module-federation/vite',
	'plugin-react': '@vitejs/plugin-react',
	'plugin-vue': '@vitejs/plugin-vue',
	'plugin-svelte': '@sveltejs/vite-plugin-svelte',
	'sentry-vite': '@sentry/vite-plugin',
	spool: '@zerosumstudio/spool',
}

const NO_ADDONS: AddonName[] = []

let counter = 0

/** Writes a generated workspace and its stubbed packages under the scratch folder. */
function writeWorkspace(files: Record<string, string>): string {
	const dir = join(SCRATCH, `w${++counter}`)

	for (const [path, content] of Object.entries(files)) {
		const target = join(dir, path)
		mkdirSync(dirname(target), { recursive: true })
		writeFileSync(target, content)
	}
	for (const [folder, name] of Object.entries(STUBBED_PACKAGES)) {
		cpSync(join(STUBS, folder), join(dir, 'node_modules', name), { recursive: true })
	}

	return dir
}

/** typescript-eslint keeps programs, project services and every config's `tsconfigRootDir` for the
 * life of the process. Left alone, a dozen workspaces run out of memory, and files it parses
 * without a program (.vue, .svelte) refuse to guess between their roots. One workspace at a time
 * is how a real one is linted, so the caches start empty and are emptied again after. */
function clearParserCaches(dir: string): void {
	const fromWorkspace = createRequire(join(dir, 'eslint.config.js'))
	const fromTypescriptEslint = createRequire(fromWorkspace.resolve('typescript-eslint'))
	const parser = fromTypescriptEslint('@typescript-eslint/parser') as { clearCaches(): void }

	parser.clearCaches()
}

/** What the generated workspace's own `eslint.config.js` says about its own files. */
async function lintWorkspace(dir: string): Promise<string[]> {
	// Files typescript-eslint parses without a program fall back to the working directory.
	const previous = process.cwd()
	process.chdir(dir)
	clearParserCaches(dir)

	try {
		const eslint = new ESLint({
			cwd: dir,
			overrideConfigFile: join(dir, 'eslint.config.js'),
			errorOnUnmatchedPattern: false,
		})
		const results = await eslint.lintFiles(['apps', 'packages', '*.ts'])

		return results.flatMap(result =>
			result.messages.map(
				message =>
					`${result.filePath.slice(dir.length + 1)}:${message.line} ${message.ruleId ?? 'parse'}: ${message.message}`,
			),
		)
	} finally {
		clearParserCaches(dir)
		process.chdir(previous)
	}
}

/** Removes a scratch folder if it can be. The language service keeps a folder open until the
 * process exits, so the last run's own folder is swept by the next run instead. */
function tryRemove(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
	} catch {
		// Still held; a later run removes it.
	}
}

function isRunning(pid: number): boolean {
	try {
		process.kill(pid, 0)

		return true
	} catch {
		return false
	}
}

beforeAll(() => {
	for (const entry of readdirSync(CLI_ROOT)) {
		const pid = Number(entry.slice('.spool-lint-'.length))

		if (entry.startsWith('.spool-lint-') && !isRunning(pid)) tryRemove(join(CLI_ROOT, entry))
	}
})

afterAll(() => {
	tryRemove(SCRATCH)
})

/*
 *   STRICT LINT
 ***************************************************************************************************/
describe('generated workspaces pass their own strict lint', () => {
	for (const [label, build] of Object.entries(SCAFFOLDS)) {
		for (const [addonLabel, addons] of [
			['no addons', NO_ADDONS],
			['every addon', ADDON_NAMES],
		] as const) {
			it(`${label}, ${addonLabel}`, { timeout: 180_000 }, async () => {
				// Linting is the point, so the lint addon is always there.
				const withLint = [...new Set<AddonName>([...addons, 'lint'])]
				const dir = writeWorkspace(scaffold(build(), withLint))

				expect(await lintWorkspace(dir)).toEqual([])
			})
		}
	}
})

/*
 *   SFC SCRIPTS ARE TYPE-CHECKED
 ***************************************************************************************************/
describe('typed rules reach the script of a .vue and a .svelte file', () => {
	it.each([
		[
			'vue',
			'apps/shell/src/control.vue',
			'<script setup lang="ts">\nPromise.resolve(1)\n</script>\n',
		],
		[
			'svelte',
			'apps/shell/src/control.svelte',
			'<script lang="ts">\n\tPromise.resolve(1)\n</script>\n',
		],
	] as const)(
		'flags a floating promise in %s',
		{ timeout: 180_000 },
		async (label, path, source) => {
			const files = scaffold(SCAFFOLDS[label]!(), ['lint'])
			const dir = writeWorkspace({ ...files, [path]: source })

			expect(await lintWorkspace(dir)).toEqual([
				expect.stringContaining('@typescript-eslint/no-floating-promises'),
			])
		},
	)
})
