/*
 *   IMPORTS
 ***************************************************************************************************/
import type * as ChildProcessModule from 'node:child_process'
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'

/*
 *   MOCKS
 ***************************************************************************************************/
const calls: string[] = []
let netstat: { status: number | null; stdout: string } = { status: 0, stdout: '' }

vi.mock('node:child_process', async importOriginal => {
	const actual = await importOriginal<typeof ChildProcessModule>()

	return {
		...actual,
		spawnSync: vi.fn((command: string) => {
			calls.push(command)

			return { ...netstat, stderr: '', error: undefined }
		}),
	}
})

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!

beforeEach(() => {
	calls.length = 0
	Object.defineProperty(process, 'platform', { value: 'win32' })
	vi.resetModules()
})

afterEach(() => {
	Object.defineProperty(process, 'platform', platform)
	vi.restoreAllMocks()
})

/*
 *   PORT OWNER
 ***************************************************************************************************/
describe('portOwner on Windows', () => {
	it('runs netstat from System32 by absolute path, never by bare name', async () => {
		netstat = { status: 0, stdout: '  Proto  Local Address\n' }
		const { portOwner } = await import('../../util/net.js')

		await portOwner(5173)

		expect(calls).toHaveLength(1)
		expect(calls[0]).toMatch(/^[A-Za-z]:\\.*System32\\netstat\.exe$/i)
	})

	it('says so when the port table cannot be read, instead of reporting a free port', async () => {
		const { log } = await import('../../util/logger.js')
		const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
		netstat = { status: 1, stdout: '' }
		const { portOwner } = await import('../../util/net.js')

		await expect(portOwner(5173)).resolves.toBeUndefined()
		await portOwner(5174)

		expect(warn).toHaveBeenCalledTimes(1)
		expect(warn.mock.calls[0]![0]).toContain('port table')
	})

	it('treats output with no netstat header as unreadable', async () => {
		const { log } = await import('../../util/logger.js')
		const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined)
		netstat = { status: 0, stdout: 'whoami: unknown option' }
		const { portOwner } = await import('../../util/net.js')

		await portOwner(5173)

		expect(warn).toHaveBeenCalledTimes(1)
	})
})

describe('inspectProcess on Windows', () => {
	it('runs powershell from its System32 folder by absolute path', async () => {
		netstat = { status: 1, stdout: '' }
		const { inspectProcess } = await import('../../util/process.js')

		inspectProcess(1234)

		expect(calls[0]).toMatch(/System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i)
	})
})

describe('killPid on Windows', () => {
	it('runs taskkill from System32 by absolute path', async () => {
		netstat = { status: 0, stdout: '' }
		const { killPid } = await import('../../util/exec.js')

		killPid(4321)

		expect(calls[0]).toMatch(/System32\\taskkill\.exe$/i)
	})
})
