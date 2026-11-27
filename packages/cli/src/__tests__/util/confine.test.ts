/*
 *   IMPORTS
 ***************************************************************************************************/
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertConfined } from '../../util/confine.js'
import { writeFiles } from '../../core/fswrite.js'
import { freshDir, removeDir } from '../helpers.js'

/*
 *   FIXTURE
 ***************************************************************************************************/
// Every folder and link here lives inside the test's own temp folders and nowhere else.
let root: string
let outside: string

beforeEach(() => {
	root = freshDir('spool-confine-root-')
	outside = freshDir('spool-confine-outside-')
	mkdirSync(join(outside, 'dash'), { recursive: true })
	writeFileSync(join(outside, 'dash', 'keep.txt'), 'keep')
})

afterEach(() => {
	// Links go first so removing the folders can never follow them.
	removeDir(root)
	removeDir(outside)
})

const link = (to: string, at: string): void => symlinkSync(to, at, 'junction')

/*
 *   ASSERT CONFINED
 ***************************************************************************************************/
describe('assertConfined', () => {
	it('accepts a path inside the root, existing or not', () => {
		mkdirSync(join(root, 'apps/dash'), { recursive: true })

		expect(() => assertConfined(root, join(root, 'apps/dash'))).not.toThrow()
		expect(() => assertConfined(root, join(root, 'apps/new/src/a.ts'))).not.toThrow()
	})

	it('refuses a path that leaves the root', () => {
		expect(() => assertConfined(root, join(root, '..', 'elsewhere'))).toThrow('outside')
	})

	it('refuses a link in a parent segment, which is how a committed apps -> ~ deletes elsewhere', () => {
		link(outside, join(root, 'apps'))

		expect(() => assertConfined(root, join(root, 'apps/dash'))).toThrow('symlink or junction')
		expect(() => assertConfined(root, join(root, 'apps/dash/keep.txt'))).toThrow(
			'symlink or junction',
		)
	})

	it('refuses a link in the middle of a deeper path', () => {
		mkdirSync(join(root, 'packages'))
		link(outside, join(root, 'packages', 'ui'))

		expect(() => assertConfined(root, join(root, 'packages/ui/dash'))).toThrow(
			'symlink or junction',
		)
	})

	it('lets a folder delete target a link itself, because removing it unlinks and never follows', () => {
		mkdirSync(join(root, 'apps'))
		link(outside, join(root, 'apps', 'dash'))

		expect(() =>
			assertConfined(root, join(root, 'apps/dash'), { allowFinalLink: true }),
		).not.toThrow()
		expect(() => assertConfined(root, join(root, 'apps/dash'))).toThrow('symlink or junction')
	})

	it('reports UNSAFE_PATH', () => {
		link(outside, join(root, 'apps'))

		try {
			assertConfined(root, join(root, 'apps/dash'))
			expect.unreachable()
		} catch (error) {
			expect(error).toMatchObject({ code: 'UNSAFE_PATH' })
		}
	})
})

/*
 *   WRITES
 ***************************************************************************************************/
describe('writeFiles through a link', () => {
	it('writes nothing outside the folder it was given', async () => {
		link(outside, join(root, 'apps'))

		await expect(writeFiles(root, { 'apps/dash/pwned.txt': 'x' })).rejects.toThrow(
			'symlink or junction',
		)

		expect(existsSync(join(outside, 'dash', 'pwned.txt'))).toBe(false)
	})

	it('still writes ordinary files', async () => {
		await writeFiles(root, { 'apps/dash/a.txt': 'x' })

		expect(existsSync(join(root, 'apps/dash/a.txt'))).toBe(true)
	})
})
