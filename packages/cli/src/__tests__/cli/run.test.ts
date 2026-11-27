/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli } from '../../cli/run.js'
import { COMMANDS } from '../../cli/commands.js'
import { create } from '../../commands/create.js'
import { freshDir, removeDir } from '../helpers.js'

/*
 *   SETUP
 ***************************************************************************************************/
let dir: string
let cwd: string
let stdout: string[]

beforeEach(async () => {
	cwd = process.cwd()
	dir = freshDir('spool-cli-')
	stdout = []

	vi.spyOn(console, 'log').mockImplementation((message: unknown) => {
		stdout.push(String(message))
	})
	vi.spyOn(console, 'error').mockImplementation(() => {})
	vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
		stdout.push(String(chunk))
		return true
	})

	await create(dir, {
		name: 'acme',
		pm: 'pnpm',
		host: 'shell',
		remotes: 'dashboard',
		install: false,
	})
	stdout = []
	process.chdir(dir)
})

afterEach(() => {
	process.chdir(cwd)
	removeDir(dir)
})

/** The single `--json` document, parsed. */
function document(): Record<string, unknown> {
	return JSON.parse(stdout.join('')) as Record<string, unknown>
}

/*
 *   USAGE
 ***************************************************************************************************/
describe('runCli usage', () => {
	it('prints a JSON failure document for a bad flag under --json, and exits 2', async () => {
		expect(await runCli(['build', '--json', '--bogus'])).toBe(2)

		const failure = document() as {
			ok: boolean
			command: string
			error: { code: string; message: string }
		}

		expect(failure.ok).toBe(false)
		expect(failure.command).toBe('build')
		expect(failure.error.code).toBe('USAGE')
		expect(failure.error.message).toContain('Unknown option --bogus')
	})

	it('says a flag that needs a value needs one, in its own words', async () => {
		expect(await runCli(['build', '--json', '--only'])).toBe(2)

		const failure = document() as { error: { message: string } }

		expect(failure.error.message).toContain('Option --only needs a value')
	})

	it('does not advertise an addon the parser refuses', async () => {
		for (const argv of [['create', '--help'], ['addon', '--help'], ['help']]) {
			stdout = []
			await runCli(argv)

			expect(stdout.join(' ')).not.toContain('federation')
		}
	})

	it('prints help and exits 0 with no arguments, --help and help', async () => {
		for (const argv of [[], ['--help'], ['help']]) {
			stdout = []

			expect(await runCli(argv)).toBe(0)
			expect(stdout.join('\n')).toContain('Usage: spool <command>')
		}
	})

	it('lists every command, and none of the cut ones', () => {
		const names = COMMANDS.map(command => command.name)

		expect(names).toContain('create')
		for (const cut of ['promote', 'rollback', 'affected']) expect(names).not.toContain(cut)
	})

	it('prints a command help and exits 0', async () => {
		expect(await runCli(['remove', '--help'])).toBe(0)
		expect(stdout.join('\n')).toContain('--files')
	})

	it('exits 2 for an unknown command, an unknown option and a bad argument count', async () => {
		expect(await runCli(['frobnicate'])).toBe(2)
		expect(await runCli(['build', '--nope'])).toBe(2)
		expect(await runCli(['remove'])).toBe(2)
		expect(await runCli(['graph', 'extra'])).toBe(2)
	})

	it('exits 2 for the cut commands and the removed --pin flag', async () => {
		expect(await runCli(['promote', 'x@abc'])).toBe(2)
		expect(await runCli(['rollback', 'x'])).toBe(2)
		expect(await runCli(['affected'])).toBe(2)
		expect(await runCli(['ci', '--pin'])).toBe(2)
		expect(await runCli(['upgrade', '--pin'])).toBe(2)
	})

	it('exits 2 when files are named without --force', async () => {
		expect(await runCli(['upgrade', 'a.ts'])).toBe(2)
	})

	it('exits 2 for a --rest that is not built or env:<name>', async () => {
		expect(await runCli(['dev', '--rest', 'staging'])).toBe(2)
	})
})

/*
 *   NON-TTY
 ***************************************************************************************************/
describe('runCli without a terminal', () => {
	it('exits 2 for remove --files without --yes, and deletes nothing', async () => {
		expect(await runCli(['remove', 'dashboard', '--files'])).toBe(2)
		expect(existsSync(join(dir, 'apps/dashboard'))).toBe(true)
	})

	it('deletes with --yes', async () => {
		expect(await runCli(['remove', 'dashboard', '--files', '--yes'])).toBe(0)
		expect(existsSync(join(dir, 'apps/dashboard'))).toBe(false)
	})

	it('exits 2 for eject without --yes', async () => {
		expect(await runCli(['eject'])).toBe(2)
	})

	it('exits 2 from create when a value has no default and cannot be asked for', async () => {
		const target = join(dir, 'fresh')

		expect(await runCli(['create', target, '--name', 'beta'])).toBe(2)
		expect(existsSync(target)).toBe(false)
	})
})

/*
 *   --JSON
 ***************************************************************************************************/
describe('runCli --json', () => {
	it('prints one success document with the command fields', async () => {
		expect(await runCli(['graph', '--json'])).toBe(0)

		const result = document()
		expect(result).toMatchObject({ ok: true, command: 'graph', name: 'acme' })
		expect(result.apps).toHaveLength(2)
	})

	it('prints one failure document with the error code and the problems, and exits 1', async () => {
		const manifestPath = join(dir, 'spool.json')
		const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
			apps: Record<string, { port: number }>
		}

		manifest.apps.dashboard!.port = manifest.apps.shell!.port
		writeFileSync(manifestPath, JSON.stringify(manifest))

		expect(await runCli(['doctor', '--json'])).toBe(1)
		expect(document()).toMatchObject({
			ok: false,
			command: 'doctor',
			error: { code: 'CHECK_FAILED' },
			problems: expect.any(Array),
		})
	})

	it('reports a missing workspace as NO_WORKSPACE in the document', async () => {
		const empty = freshDir('spool-cli-empty-')
		process.chdir(empty)

		try {
			expect(await runCli(['build', '--json'])).toBe(1)
			expect(document()).toMatchObject({ ok: false, error: { code: 'NO_WORKSPACE' } })
		} finally {
			process.chdir(dir)
			removeDir(empty)
		}
	})
})
