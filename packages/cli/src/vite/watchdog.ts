/*
 *   WATCHDOG
 ***************************************************************************************************/
const PARENT_CHECK_INTERVAL_MS = 1_000

let isWatching = false

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/**
 * spool sets SPOOL_PARENT_PID on every vite process it starts. Poll for it rather than
 * rely on the child being told: a killed or crashed spool leaves no other signal.
 */
export function watchParent(
	env: NodeJS.ProcessEnv = process.env,
	exit: (code: number) => void = code => process.exit(code),
	isAlive: (pid: number) => boolean = isProcessAlive,
): void {
	if (isWatching || !env.SPOOL_PARENT_PID) return

	const parentPid = Number(env.SPOOL_PARENT_PID)
	if (!Number.isInteger(parentPid) || parentPid <= 0) return

	isWatching = true
	setInterval(() => {
		if (!isAlive(parentPid)) exit(0)
	}, PARENT_CHECK_INTERVAL_MS).unref()
}
