/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { installDependencies } from '../../core/install.js'
import { run } from '../../util/exec.js'
import { commandShell } from '../../util/system.js'
import { installInvocation } from '../../util/install-command.js'
import { log } from '../../util/logger.js'

/*
 *   MOCKS
 ***************************************************************************************************/
vi.mock('../../util/exec.js', () => ({ run: vi.fn() }))

beforeEach(() => {
	vi.spyOn(log, 'error').mockImplementation(() => {})
	vi.spyOn(log, 'plain').mockImplementation(() => {})
})

/*
 *   INSTALL
 ***************************************************************************************************/
describe('installDependencies', () => {
	it('runs the install invocation for the manager in the folder, quietly', async () => {
		vi.mocked(run).mockResolvedValue(undefined)
		const { command, args, ...options } = installInvocation('npm')

		await expect(installDependencies('npm', '/ws')).resolves.toBe(true)

		expect(run).toHaveBeenCalledWith(command, args, { cwd: '/ws', stdio: 'ignore', ...options })
	})

	it('never hands the manager name to a shell as an argument', async () => {
		vi.mocked(run).mockResolvedValue(undefined)

		await installDependencies('pnpm', '/ws')

		const [command, args] = vi.mocked(run).mock.calls[0]!
		expect(['pnpm', commandShell(), process.execPath]).toContain(command)
		expect(args.join(' ')).toMatch(/install/)
	})

	it('resolves false, and says where, when the install fails', async () => {
		vi.mocked(run).mockRejectedValue(new Error('exited with code 1.'))

		await expect(installDependencies('yarn', '/ws')).resolves.toBe(false)

		expect(log.error).toHaveBeenCalledWith(expect.stringContaining('/ws'))
	})
})
