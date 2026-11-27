/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { build } from '../../commands/build.js'
import { buildAll } from '../../core/orchestrator.js'
import { CliError } from '../../util/errors.js'
import { makeWorkspace, remote } from '../helpers.js'

/*
 *   MOCKS
 ***************************************************************************************************/
vi.mock('../../core/orchestrator.js', () => ({ buildAll: vi.fn() }))
vi.mock('../../core/workspace.js', () => ({
	requireWorkspace: vi.fn(async () => makeWorkspace('/ws', { dashboard: remote() })),
}))

beforeEach(() => {
	vi.mocked(buildAll).mockResolvedValue(undefined)
})

/*
 *   BUILD
 ***************************************************************************************************/
describe('build', () => {
	it('rejects a non-numeric concurrency as bad input', async () => {
		await expect(build({ concurrency: 'lots' })).rejects.toMatchObject({
			message: expect.stringContaining('--concurrency needs'),
			code: 'INVALID_VALUE',
		})
		expect(buildAll).not.toHaveBeenCalled()
	})

	it('returns every app result, with durationMs, for the --json document', async () => {
		vi.mocked(buildAll).mockImplementation(async (_ws, options) => {
			options?.onResult?.({ name: 'dashboard', ok: true, durationMs: 42 })
		})

		await expect(build({ json: true })).resolves.toEqual({
			results: [{ name: 'dashboard', ok: true, durationMs: 42 }],
		})
	})

	it('keeps the results collected before a failure on the thrown error', async () => {
		vi.mocked(buildAll).mockImplementation(async (_ws, options) => {
			options?.onResult?.({ name: 'dashboard', ok: false, durationMs: 1, error: 'boom' })
			throw new CliError('Build failed', 'BUILD_FAILED')
		})

		const error = await build({ json: true }).catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(CliError)
		expect((error as CliError).code).toBe('BUILD_FAILED')
		expect((error as CliError).data).toEqual({
			results: [{ name: 'dashboard', ok: false, durationMs: 1, error: 'boom' }],
		})
	})

	it('does not touch stdout itself, with or without --json', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

		await build({})
		await build({ json: true })

		expect(write).not.toHaveBeenCalled()
	})
})
