/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	EJECTED_HELPER_FILES,
	ejectedImport,
	readBundledHelper,
} from '../../core/ejected-helper.js'
import { freshDir, removeDir } from '../helpers.js'

/*
 *   SETUP
 ***************************************************************************************************/
let dir: string | undefined

afterEach(() => {
	if (dir) removeDir(dir)
	dir = undefined
})

/*
 *   BUNDLE
 ***************************************************************************************************/
describe('readBundledHelper', () => {
	it('reads the built entry and its types from beside the CLI', () => {
		dir = freshDir('spool-dist-')
		writeFileSync(join(dir, 'vite.js'), 'export const spoolApp = 1\n')
		writeFileSync(join(dir, 'vite.d.ts'), 'export declare const spoolApp: 1\n')

		const { files } = readBundledHelper(dir)

		expect(Object.keys(files)).toEqual([...EJECTED_HELPER_FILES])
		expect(files['spool.vite.js']).toBe('export const spoolApp = 1\n')
		expect(files['spool.vite.d.ts']).toContain('declare')
	})

	it('fails with a message, not a stack, when there is no build next to it', () => {
		const empty = freshDir('spool-dist-empty-')
		dir = empty
		mkdirSync(join(empty, 'nothing'))

		expect(() => readBundledHelper(join(empty, 'nothing'))).toThrow('Could not read the built')
	})
})

/*
 *   IMPORT PATH
 ***************************************************************************************************/
describe('ejectedImport', () => {
	it('climbs one folder per segment of the app path', () => {
		expect(ejectedImport('apps/shell')).toBe('../../spool.vite.js')
		expect(ejectedImport('shell')).toBe('../spool.vite.js')
		expect(ejectedImport('packages/web/shell')).toBe('../../../spool.vite.js')
	})
})
