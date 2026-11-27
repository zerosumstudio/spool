/*
 *   IMPORTS
 ***************************************************************************************************/
import { posix, win32 } from 'node:path'
import type { Invocation } from './bin.js'
import { commandShell } from './system.js'

/*
 *   TYPES
 ***************************************************************************************************/
export type InstallManager = 'pnpm' | 'npm' | 'yarn'

export interface InstallInvocation extends Invocation {
	/** The one string passed to `cmd.exe` as-is, so Node does not re-quote it. */
	windowsVerbatimArguments?: true
}

export interface InstallEnvironment {
	platform: NodeJS.Platform
	/** `process.env.npm_execpath`: the package manager that started this process, if any. */
	execPath: string | undefined
	/** `process.execPath`. */
	nodePath: string
}

/*
 *   INSTALL COMMAND
 ***************************************************************************************************/
const MANAGERS: readonly InstallManager[] = ['pnpm', 'npm', 'yarn']

/** `pnpm.cjs`, `npm-cli.js`, `yarn.js`: the manager an `npm_execpath` belongs to. */
function managerOf(execPath: string, platform: NodeJS.Platform): InstallManager | undefined {
	const paths = platform === 'win32' ? win32 : posix
	const file = paths.basename(execPath).toLowerCase()

	return MANAGERS.find(
		manager =>
			file === manager || file.startsWith(`${manager}.`) || file.startsWith(`${manager}-`),
	)
}

/**
 * How to run `<pm> install`. The package managers are `.cmd` shims on Windows,
 * which Node will not spawn without a shell. When spool was started by the same
 * manager, `npm_execpath` is its script and runs under node directly. Otherwise
 * Windows goes through `cmd.exe` with a fixed string: the manager comes from a
 * three-value enum, so no user input reaches the shell.
 */
export function installInvocation(
	pm: InstallManager,
	env: InstallEnvironment = {
		platform: process.platform,
		execPath: process.env.npm_execpath,
		nodePath: process.execPath,
	},
): InstallInvocation {
	if (!MANAGERS.includes(pm)) throw new Error(`Unknown package manager ${JSON.stringify(pm)}.`)

	if (env.execPath && managerOf(env.execPath, env.platform) === pm) {
		return { command: env.nodePath, args: [env.execPath, 'install'] }
	}

	if (env.platform === 'win32') {
		return {
			command: commandShell(),
			args: ['/d', '/s', '/c', `"${pm} install"`],
			windowsVerbatimArguments: true,
		}
	}

	return { command: pm, args: ['install'] }
}
