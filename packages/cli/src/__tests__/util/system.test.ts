/*
 *   IMPORTS
 ***************************************************************************************************/
import { afterEach, describe, it, expect } from 'vitest'
import {
	commandShell,
	hardenExecutableSearch,
	powershellPath,
	system32Tool,
} from '../../util/system.js'

/*
 *   FIXTURE
 ***************************************************************************************************/
const KEY = 'NoDefaultCurrentDirectoryInExePath'
const original = process.env[KEY]

// This machine may already have the variable set, so every test starts from a known state.
afterEach(() => {
	if (original === undefined) delete process.env[KEY]
	else process.env[KEY] = original
})

/*
 *   SEARCH PATH
 ***************************************************************************************************/
describe('hardenExecutableSearch', () => {
	it('sets NoDefaultCurrentDirectoryInExePath, whatever it was before', () => {
		const env: NodeJS.ProcessEnv = {}

		hardenExecutableSearch(env)
		expect(env[KEY]).toBe('1')

		env[KEY] = '0'
		hardenExecutableSearch(env)
		expect(env[KEY]).toBe('1')
	})

	it('changes the real environment, which child processes inherit', () => {
		delete process.env[KEY]
		hardenExecutableSearch()

		expect(process.env[KEY]).toBe('1')
	})
})

/*
 *   TOOL PATHS
 ***************************************************************************************************/
describe('Windows tool paths', () => {
	const env: NodeJS.ProcessEnv = { SystemRoot: String.raw`D:\Win` }

	it('resolves system tools under System32 by absolute path', () => {
		expect(system32Tool('netstat.exe', env)).toBe(String.raw`D:\Win\System32\netstat.exe`)
		expect(system32Tool('taskkill.exe', env)).toBe(String.raw`D:\Win\System32\taskkill.exe`)
		expect(powershellPath(env)).toBe(
			String.raw`D:\Win\System32\WindowsPowerShell\v1.0\powershell.exe`,
		)
	})

	it('does not trust a relative SystemRoot', () => {
		const fallback = String.raw`C:\Windows\System32\netstat.exe`

		expect(system32Tool('netstat.exe', { SystemRoot: String.raw`.\evil` })).toBe(fallback)
		expect(system32Tool('netstat.exe', {})).toBe(fallback)
	})

	it('uses ComSpec only when it is an absolute cmd.exe', () => {
		const cmd = String.raw`D:\Win\System32\cmd.exe`

		expect(commandShell({ ComSpec: cmd })).toBe(cmd)
		expect(commandShell({ ComSpec: 'cmd.exe', SystemRoot: String.raw`D:\Win` })).toBe(cmd)
		expect(
			commandShell({ ComSpec: String.raw`C:\temp\evil.exe`, SystemRoot: String.raw`D:\Win` }),
		).toBe(cmd)
	})
})
