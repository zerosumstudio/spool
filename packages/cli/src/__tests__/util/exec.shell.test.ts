/*
 *   IMPORTS
 ***************************************************************************************************/
import { EventEmitter } from 'node:events'
import type * as ChildProcessModule from 'node:child_process'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

/*
 *   MOCKS
 ***************************************************************************************************/
const spawned: { command: string; args: unknown; options: { stdio?: unknown } }[] = []

vi.mock('node:child_process', async importOriginal => {
	const actual = await importOriginal<typeof ChildProcessModule>()

	return {
		...actual,
		spawnSync: vi.fn(() => ({ status: 0, error: undefined })),
		spawn: vi.fn((command: string, args: unknown, options?: { stdio?: unknown }) => {
			const child = new EventEmitter()

			spawned.push({
				command,
				args,
				options: (Array.isArray(args) ? options : (args as { stdio?: unknown })) ?? {},
			})
			queueMicrotask(() => child.emit('exit', 0))

			return child
		}),
	}
})

import { log } from '../../util/logger.js'
import { runShell } from '../../util/exec.js'

/*
 *   RUN SHELL
 ***************************************************************************************************/
beforeEach(() => {
	spawned.length = 0
})

afterEach(() => log.useStdout())

describe('runShell', () => {
	it('lets the command write to stdout in a normal run', async () => {
		await runShell('echo hi')

		expect(spawned[0]!.options.stdio).toBe('inherit')
	})

	it('sends the command stdout to stderr when logs go to stderr, so --json stays one document', async () => {
		log.useStderr()
		await runShell('echo hi')

		expect(spawned[0]!.options.stdio).toEqual(['inherit', 2, 'inherit'])
	})
})
