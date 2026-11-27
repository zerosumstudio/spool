/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import { commandShell } from '../../util/system.js'
import { installInvocation, type InstallEnvironment } from '../../util/install-command.js'

/*
 *   HELPERS
 ***************************************************************************************************/
const NODE = '/usr/bin/node'

const env = (overrides: Partial<InstallEnvironment> = {}): InstallEnvironment => ({
	platform: 'linux',
	execPath: undefined,
	nodePath: NODE,
	...overrides,
})

/*
 *   INSTALL COMMAND
 ***************************************************************************************************/
describe('installInvocation', () => {
	it('runs the manager by name on posix', () => {
		expect(installInvocation('pnpm', env())).toEqual({ command: 'pnpm', args: ['install'] })
		expect(installInvocation('yarn', env({ platform: 'darwin' }))).toEqual({
			command: 'yarn',
			args: ['install'],
		})
	})

	it('goes through one fixed cmd.exe string on Windows, passed verbatim', () => {
		for (const pm of ['pnpm', 'npm', 'yarn'] as const) {
			expect(installInvocation(pm, env({ platform: 'win32' }))).toEqual({
				command: commandShell(),
				args: ['/d', '/s', '/c', `"${pm} install"`],
				windowsVerbatimArguments: true,
			})
		}
	})

	it('runs the manager that started spool through node, without any shell', () => {
		const pnpm = 'C:\\Users\\dev\\AppData\\pnpm\\pnpm.cjs'

		expect(installInvocation('pnpm', env({ platform: 'win32', execPath: pnpm }))).toEqual({
			command: NODE,
			args: [pnpm, 'install'],
		})
		expect(
			installInvocation('npm', env({ execPath: '/usr/lib/node_modules/npm/bin/npm-cli.js' })),
		).toEqual({ command: NODE, args: ['/usr/lib/node_modules/npm/bin/npm-cli.js', 'install'] })
		expect(
			installInvocation('yarn', env({ execPath: '/home/dev/.yarn/releases/yarn.js' })),
		).toEqual({ command: NODE, args: ['/home/dev/.yarn/releases/yarn.js', 'install'] })
	})

	it("ignores an npm_execpath that belongs to a different manager than the workspace's", () => {
		const npx = '/usr/lib/node_modules/npm/bin/npx-cli.js'

		expect(installInvocation('pnpm', env({ execPath: npx, platform: 'win32' }))).toEqual({
			command: commandShell(),
			args: ['/d', '/s', '/c', '"pnpm install"'],
			windowsVerbatimArguments: true,
		})
	})

	it('never puts a manager that is not pnpm, npm or yarn into the shell string', () => {
		expect(() => installInvocation('pnpm & calc' as never, env({ platform: 'win32' }))).toThrow(
			'Unknown package manager',
		)
	})
})
