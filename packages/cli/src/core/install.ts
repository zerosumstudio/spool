/*
 *   IMPORTS
 ***************************************************************************************************/
import { run } from '../util/exec.js'
import { installInvocation, type InstallManager } from '../util/install-command.js'
import { log } from '../util/logger.js'

/*
 *   INSTALL
 ***************************************************************************************************/
/**
 * Installs when asked to, and says what to run next either way. A failed install is a warning,
 * since the files are already written.
 */
export async function installOrHint(
	pm: InstallManager,
	cwd: string,
	install: boolean,
): Promise<void> {
	if (!install) {
		log.step(`Skipped install. Run \`${pm} install\`, then \`spool dev\`.`)
		return
	}

	log.step(`Installing dependencies with ${pm}`)

	if (await installDependencies(pm, cwd)) log.step('Run `spool dev` to start it.')
	else log.warn(`Install failed. Run \`${pm} install\` before \`spool dev\`.`)
}

/** Runs `<pm> install` in `cwd`; resolves false instead of throwing on failure. */
export async function installDependencies(pm: InstallManager, cwd: string): Promise<boolean> {
	const { command, args, ...options } = installInvocation(pm)

	try {
		await run(command, args, { cwd, stdio: 'ignore', ...options })
		return true
	} catch (err) {
		log.error(`"${pm} install" failed in ${cwd}.`)
		if (err instanceof Error && err.message) log.plain(err.message)
		return false
	}
}
