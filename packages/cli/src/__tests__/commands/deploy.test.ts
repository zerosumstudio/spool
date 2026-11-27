/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { deploy } from '../../commands/deploy.js'
import { deployAll } from '../../core/orchestrator.js'
import { makeWorkspace, remote } from '../helpers.js'

/*
 *   MOCKS
 ***************************************************************************************************/
vi.mock('../../core/orchestrator.js', () => ({ deployAll: vi.fn() }))
vi.mock('../../core/workspace.js', () => ({
	requireWorkspace: vi.fn(async () => makeWorkspace('/ws', { dashboard: remote() })),
}))

beforeEach(() => {
	vi.mocked(deployAll).mockResolvedValue(undefined)
})

/*
 *   DEPLOY
 ***************************************************************************************************/
describe('deploy', () => {
	it('returns every app result, with durationMs, for the --json document', async () => {
		vi.mocked(deployAll).mockImplementation(async (_ws, _only, _env, onResult) => {
			onResult?.({ name: 'dashboard', ok: true, durationMs: 10 })
		})

		await expect(deploy({ json: true })).resolves.toEqual({
			results: [{ name: 'dashboard', ok: true, durationMs: 10 }],
		})
	})

	it.each(['__proto__', '-x', 'a b', 'prod;rm'])('rejects --env %s', async env => {
		await expect(deploy({ env })).rejects.toMatchObject({ code: 'INVALID_VALUE' })
		expect(deployAll).not.toHaveBeenCalled()
	})

	it('accepts an ordinary environment name', async () => {
		await deploy({ env: 'staging-2' })

		expect(deployAll).toHaveBeenCalledWith(
			expect.anything(),
			undefined,
			'staging-2',
			expect.any(Function),
		)
	})

	it('does not touch stdout itself, with or without --json', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

		await deploy({})
		await deploy({ json: true })

		expect(write).not.toHaveBeenCalled()
	})
})
