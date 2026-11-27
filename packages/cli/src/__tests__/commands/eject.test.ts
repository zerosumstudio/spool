/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { create } from '../../commands/create.js'
import { eject } from '../../commands/eject.js'
import type * as EjectedHelperModule from '../../core/ejected-helper.js'
import { readBundledHelper } from '../../core/ejected-helper.js'
import { CliError } from '../../util/errors.js'
import { log } from '../../util/logger.js'
import { freshDir, removeDir } from '../helpers.js'

/*
 *   MOCKS
 ***************************************************************************************************/
// The built ./vite entry only exists after a build; eject reads it from beside the CLI.
vi.mock('../../core/ejected-helper.js', async importOriginal => ({
	...(await importOriginal<typeof EjectedHelperModule>()),
	readBundledHelper: vi.fn(() => ({
		files: {
			'spool.vite.js': '// bundled helper\nexport function spoolApp() {}\n',
			'spool.vite.d.ts': 'export declare function spoolApp(): void\n',
		},
	})),
}))

/*
 *   TEST SETUP
 ***************************************************************************************************/
let dir: string
let cwd: string

const readJson = (rel: string) => JSON.parse(readFileSync(join(dir, rel), 'utf8'))

beforeEach(async () => {
	dir = freshDir('spool-eject-')
	cwd = process.cwd()
	vi.spyOn(console, 'log').mockImplementation(() => {})
	await create(dir, {
		name: 'acme',
		pm: 'pnpm',
		host: 'shell',
		remotes: 'dashboard',
		install: false,
	})
	process.chdir(dir)
})

afterEach(() => {
	process.chdir(cwd)
	removeDir(dir)
	vi.restoreAllMocks()
})

/*
 *   EJECT
 ***************************************************************************************************/
describe('eject', () => {
	it('removes the spool dependency and rewrites dev/build to native scripts', async () => {
		await eject({ yes: true })

		const pkg = readJson('package.json')
		expect(pkg.devDependencies['@zerosumstudio/spool']).toBeUndefined()
		expect(pkg.scripts.dev).not.toContain('spool')
		expect(pkg.scripts.build).not.toContain('spool')
		expect(pkg.scripts.dev).toContain('pnpm')
	})

	it('drops spool-only scripts that have no native equivalent', async () => {
		await eject({ yes: true })

		const pkg = readJson('package.json')
		expect(pkg.scripts.doctor).toBeUndefined()
		expect(pkg.scripts.preview).toBeUndefined()
	})

	it('deletes .spool', async () => {
		await eject({ yes: true })
		expect(existsSync(join(dir, '.spool'))).toBe(false)
	})

	it('leaves spool.json and the generated app files in place', async () => {
		await eject({ yes: true })

		expect(existsSync(join(dir, 'spool.json'))).toBe(true)
		expect(existsSync(join(dir, 'spool.workspace.ts'))).toBe(true)
		expect(existsSync(join(dir, 'apps/shell/vite.config.ts'))).toBe(true)
	})

	it('writes the vite helper out, so the apps no longer need the spool package', async () => {
		await eject({ yes: true })

		expect(readFileSync(join(dir, 'spool.vite.js'), 'utf8')).toContain('bundled helper')
		expect(readFileSync(join(dir, 'spool.vite.d.ts'), 'utf8')).toContain('spoolApp')
	})

	it('points every vite config at the written helper, from any folder depth', async () => {
		const before = readFileSync(join(dir, 'apps/shell/vite.config.ts'), 'utf8')
		expect(before).toContain('@zerosumstudio/spool/vite')

		await eject({ yes: true })

		for (const app of ['shell', 'dashboard']) {
			const config = readFileSync(join(dir, `apps/${app}/vite.config.ts`), 'utf8')

			expect(config).toContain("'../../spool.vite.js'")
			expect(config).not.toContain('@zerosumstudio/spool')
		}
	})

	it('changes nothing when the bundled helper cannot be read', async () => {
		vi.mocked(readBundledHelper).mockImplementationOnce(() => {
			throw new CliError('Could not read the built helper.')
		})

		await expect(eject({ yes: true })).rejects.toThrow('Could not read')

		expect(readJson('package.json').devDependencies['@zerosumstudio/spool']).toBeDefined()
		expect(existsSync(join(dir, 'spool.vite.js'))).toBe(false)
		expect(readFileSync(join(dir, 'apps/shell/vite.config.ts'), 'utf8')).toContain(
			'@zerosumstudio/spool/vite',
		)
	})

	it('prints what stays and notes remotes-before-hosts ordering is now on the user', async () => {
		const step = vi.spyOn(log, 'step').mockImplementation(() => {})
		await eject({ yes: true })

		expect(step).toHaveBeenCalledWith(expect.stringContaining('remotes before hosts'))
		expect(step).toHaveBeenCalledWith(expect.stringContaining('kept'))
	})

	it('refuses without --yes when there is no tty, and changes nothing', async () => {
		await expect(eject({})).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })

		const pkg = readJson('package.json')
		expect(pkg.devDependencies['@zerosumstudio/spool']).toBeDefined()
		expect(existsSync(join(dir, '.spool'))).toBe(true)
	})

	it('leaves an already-customized script alone', async () => {
		writeFileSync(
			join(dir, 'package.json'),
			JSON.stringify({
				...readJson('package.json'),
				scripts: { ...readJson('package.json').scripts, dev: 'turbo run dev' },
			}),
		)

		await eject({ yes: true })

		expect(readJson('package.json').scripts.dev).toBe('turbo run dev')
	})
})
