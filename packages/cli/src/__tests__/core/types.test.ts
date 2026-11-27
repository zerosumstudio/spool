/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
	emitRemoteTypes,
	exposeDeclarationPath,
	resolveTsc,
	typesOutDir,
} from '../../core/types.js'
import { freshDir, removeDir, host, remote, makeManifest } from '../helpers.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
let root: string

beforeEach(() => {
	root = freshDir('spool-types-')
})

afterEach(() => {
	removeDir(root)
})

function plantFakeTypescript(): void {
	const bin = join(root, 'node_modules', 'typescript', 'bin')
	mkdirSync(bin, { recursive: true })
	writeFileSync(join(root, 'node_modules', 'typescript', 'package.json'), '{"name":"typescript"}')
	writeFileSync(join(bin, 'tsc'), '')
}

/*
 *   PATHS
 ***************************************************************************************************/
describe('typesOutDir / exposeDeclarationPath', () => {
	it('keys the output dir by app name under .spool/types', () => {
		expect(typesOutDir('dashboard')).toBe(join('.spool', 'types', 'dashboard'))
	})

	it('mirrors the expose source under outDir, swapping the extension for .d.ts', () => {
		expect(
			exposeDeclarationPath('/ws', 'dashboard', 'apps/dashboard', './src/app/app.tsx'),
		).toBe(
			join(
				'/ws',
				'.spool',
				'types',
				'dashboard',
				'apps',
				'dashboard',
				'src',
				'app',
				'app.d.ts',
			),
		)
	})
})

/*
 *   EMIT
 ***************************************************************************************************/
describe('resolveTsc', () => {
	it('finds the typescript the workspace installed', () => {
		plantFakeTypescript()

		expect(resolveTsc(root)).toBe(join(root, 'node_modules', 'typescript', 'bin', 'tsc'))
	})

	it('finds it in a parent folder, as a hoisted install would', () => {
		plantFakeTypescript()
		const nested = join(root, 'apps', 'shell')
		mkdirSync(nested, { recursive: true })

		expect(resolveTsc(nested)).toBe(join(root, 'node_modules', 'typescript', 'bin', 'tsc'))
	})

	it('never falls back to a typescript the CLI itself can load, through NODE_PATH or otherwise', () => {
		// The CLI has its own typescript. A workspace with none must not borrow it.
		expect(createRequire(import.meta.url).resolve('typescript/bin/tsc')).toBeTruthy()

		expect(resolveTsc(root)).toBeUndefined()
	})
})

describe('emitRemoteTypes', () => {
	it('skips cleanly when the workspace has no typescript installed', async () => {
		const m = makeManifest({ dashboard: remote() })
		const result = await emitRemoteTypes(root, m)
		expect(result).toEqual({ built: [], failed: [], skipped: true })
	})

	it('builds nothing, without skipping, when no app exposes anything', async () => {
		plantFakeTypescript()
		const m = makeManifest({ shell: host() })
		const result = await emitRemoteTypes(root, m)
		expect(result).toEqual({ built: [], failed: [], skipped: false })
	})

	it('leaves an exposing app out when it has no tsconfig.json yet', async () => {
		plantFakeTypescript()
		const m = makeManifest({ dashboard: remote({ path: 'apps/dashboard' }) })
		const result = await emitRemoteTypes(root, m)
		expect(result).toEqual({ built: [], failed: [], skipped: false })
	})

	it('honours an --only filter without touching apps outside it', async () => {
		plantFakeTypescript()
		const m = makeManifest({
			dashboard: remote({ path: 'apps/dashboard' }),
			billing: remote({ path: 'apps/billing', port: 5175 }),
		})
		const result = await emitRemoteTypes(root, m, ['billing'])
		expect(result.built).toEqual([])
	})
})
