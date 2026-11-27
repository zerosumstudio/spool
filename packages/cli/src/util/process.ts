/*
 *   IMPORTS
 ***************************************************************************************************/
import { spawnSync } from 'node:child_process'
import { powershellPath } from './system.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface ProcessInfo {
	/** Epoch milliseconds the OS says the process started. */
	startedAt: number
	commandLine: string
}

/** What spool recorded when it started a process. */
export interface ExpectedProcess {
	/** Epoch milliseconds spool spawned it. */
	startedAt: number
	/** A path or token the command line must contain. */
	match: string
}

/** The OS rounds start times to the second and spool records its own clock after spawning. */
export const START_TOLERANCE_MS = 10_000

/*
 *   LOOKUP
 ***************************************************************************************************/
const isWindows = process.platform === 'win32'

// Only a number is ever put in the command: pids come from a pidfile that could be edited.
const WINDOWS_QUERY = (pid: number): string =>
	`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') + '|' + $p.CommandLine }`

export function parseWindowsProcess(output: string): ProcessInfo | undefined {
	const text = output.trim()
	const split = text.indexOf('|')
	if (split < 0) return undefined

	const startedAt = Date.parse(text.slice(0, split))
	return Number.isNaN(startedAt) ? undefined : { startedAt, commandLine: text.slice(split + 1) }
}

/** `ps -o lstart=,args=`: a 24 character start time, then the command. */
export function parsePsProcess(output: string): ProcessInfo | undefined {
	const line = output.split(/\r?\n/).find(row => row.trim() !== '')
	if (!line) return undefined

	const trimmed = line.trim()
	const startedAt = Date.parse(`${trimmed.slice(0, 24)} UTC`)
	if (Number.isNaN(startedAt)) return undefined

	return { startedAt, commandLine: trimmed.slice(24).trim() }
}

/** Start time and command line of a running process, or undefined when it is gone or cannot be read. */
export function inspectProcess(pid: number): ProcessInfo | undefined {
	if (!Number.isInteger(pid) || pid <= 0) return undefined

	if (isWindows) {
		const result = spawnSync(
			powershellPath(),
			['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY(pid)],
			{ encoding: 'utf8', windowsHide: true },
		)
		return result.status === 0 ? parseWindowsProcess(result.stdout) : undefined
	}

	const result = spawnSync('ps', ['-o', 'lstart=', '-o', 'args=', '-p', String(pid)], {
		encoding: 'utf8',
		env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
	})
	return result.status === 0 ? parsePsProcess(result.stdout) : undefined
}

/*
 *   IDENTITY
 ***************************************************************************************************/
const normalise = (value: string): string => value.replace(/\\/g, '/').toLowerCase()

/**
 * True only when the process started when spool started it and runs what spool
 * ran. A pid the OS handed to something else later fails both checks.
 */
export function isSameProcess(info: ProcessInfo, expected: ExpectedProcess): boolean {
	// The pidfile is a file in the repo, so a planted one may hold anything. An empty match would be
	// found in every command line.
	if (typeof expected.match !== 'string' || expected.match.trim() === '') return false
	if (!Number.isFinite(expected.startedAt)) return false

	if (Math.abs(info.startedAt - expected.startedAt) > START_TOLERANCE_MS) return false

	return normalise(info.commandLine).includes(normalise(expected.match))
}
