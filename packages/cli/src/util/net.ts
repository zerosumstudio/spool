/*
 *   IMPORTS
 ***************************************************************************************************/
import { spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { log } from './logger.js'
import { system32Tool } from './system.js'

/*
 *   PLATFORM
 ***************************************************************************************************/
const isWindows = process.platform === 'win32'

/** How long one manifest probe may take, and how long a remote gets to serve its first one. */
const DEFAULT_PROBE_TIMEOUT_MS = 2_000
export const DEFAULT_REMOTE_TIMEOUT_MS = 20_000
const DEFAULT_POLL_INTERVAL_MS = 200

/*
 *   MANIFEST READINESS
 ***************************************************************************************************/
async function canFetch(url: string): Promise<boolean> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS) })
		// Drain the body so the socket is released promptly.
		await response.body?.cancel()
		return response.ok
	} catch {
		return false
	}
}

export interface WaitForManifestOptions {
	timeoutMs?: number
	intervalMs?: number
	/** Aborts the poll early, e.g. once a sibling process has already died. */
	signal?: AbortSignal
}

/**
 * Resolves once the URL responds with a 2xx, or rejects if it never does within
 * the timeout. A listening port is not enough: a dev server can accept
 * connections before it can actually serve the federation manifest, so hosts
 * have to wait for the manifest itself, not just the socket.
 */
export async function waitForManifest(
	url: string,
	{
		timeoutMs = DEFAULT_REMOTE_TIMEOUT_MS,
		intervalMs = DEFAULT_POLL_INTERVAL_MS,
		signal,
	}: WaitForManifestOptions = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error('Aborted: a sibling process stopped first.')
		if (await canFetch(url)) return
		await delay(intervalMs)
	}
	throw new Error(`Timed out waiting for ${url} after ${timeoutMs / 1000}s.`)
}

/*
 *   PORT OWNERSHIP
 ***************************************************************************************************/
export interface PortOwner {
	pid: number
	command?: string
}

export function parseNetstatOwner(output: string, port: number): PortOwner | undefined {
	const needle = `:${port}`

	for (const line of output.split('\n')) {
		const parts = line.trim().split(/\s+/)
		if (parts.length < 4 || parts[0] !== 'TCP' || parts[3] !== 'LISTENING') continue

		const local = parts[1]

		if (local === undefined || !local.endsWith(needle)) continue

		const pid = Number(parts[parts.length - 1])
		if (Number.isInteger(pid)) return { pid }
	}

	return undefined
}

/** Parses `lsof -iTCP:<port> -sTCP:LISTEN` output; exported so tests can feed it fixture text directly. */
export function parseLsofOwner(output: string): PortOwner | undefined {
	const line = output
		.split('\n')
		.slice(1)
		.find(entry => entry.trim())

	if (!line) return undefined

	const parts = line.trim().split(/\s+/)
	const pid = Number(parts[1])
	if (!Number.isInteger(pid)) return undefined

	const command = parts[0]
	return command === undefined ? { pid } : { pid, command }
}

const NETSTAT_HEADER = /\bProto\b/
let warnedAboutPortTable = false

/** A port check that cannot read the table must not look like a port that is free. */
function warnPortTable(status: number | null): void {
	if (warnedAboutPortTable) return

	warnedAboutPortTable = true
	log.warn(
		`could not read the port table (netstat exited ${status ?? 'without a status'}), so port checks are skipped.`,
	)
}

export function portOwner(port: number): Promise<PortOwner | undefined> {
	if (isWindows) {
		const result = spawnSync(system32Tool('netstat.exe'), ['-ano'], { encoding: 'utf8' })

		if (result.status !== 0 || !NETSTAT_HEADER.test(result.stdout)) {
			warnPortTable(result.status)
			return Promise.resolve(undefined)
		}

		return Promise.resolve(parseNetstatOwner(result.stdout, port))
	}

	const result = spawnSync('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-P', '-n'], {
		encoding: 'utf8',
	})
	return Promise.resolve(result.status === 0 ? parseLsofOwner(result.stdout) : undefined)
}
