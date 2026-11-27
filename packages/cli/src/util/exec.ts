/*
 *   IMPORTS
 ***************************************************************************************************/
import {
	spawn,
	spawnSync,
	type ChildProcess,
	type SpawnOptions,
	type StdioOptions,
} from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { log } from './logger.js'
import { system32Tool } from './system.js'

/*
 *   PLATFORM
 ***************************************************************************************************/
const isWindows = process.platform === 'win32'

/** How long a process gets to stop on SIGTERM before it is killed, and to die after SIGKILL. */
const DEFAULT_KILL_GRACE_MS = 2_000
const KILL_CONFIRM_MS = 1_000

/*
 *   PROCESS
 ***************************************************************************************************/
type SimpleStdio = 'inherit' | 'ignore' | 'pipe'

function stdinAndStdout(requested: SpawnOptions['stdio']): [SimpleStdio, SimpleStdio] {
	const pick = (value: unknown): SimpleStdio =>
		value === 'ignore' || value === 'pipe' ? value : 'inherit'

	if (Array.isArray(requested)) return [pick(requested[0]), pick(requested[1])]
	return [pick(requested), pick(requested)]
}

export function run(cmd: string, args: string[], opts: SpawnOptions = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const forward = opts.stdio !== 'ignore'
		const { stdio, ...rest } = opts
		const [stdin, stdout] = stdinAndStdout(stdio)

		const child = spawn(cmd, args, { ...rest, stdio: [stdin, stdout, 'pipe'] })
		let stderr = ''

		child.stderr?.on('data', (chunk: Buffer) => {
			stderr += chunk.toString()
			if (forward) process.stderr.write(chunk)
		})

		child.on('error', reject)
		child.on('exit', code => {
			if (code === 0) {
				resolve()
				return
			}
			const detail = stderr.trim()
			reject(
				new Error(
					`"${cmd}" exited with code ${code ?? 'null'}.${detail ? `\n${detail}` : ''}`,
				),
			)
		})
	})
}

export interface CapturedRun {
	code: number | null
	/** stdout and stderr together, in the order the process wrote them. */
	output: string
}

export function runCaptured(
	cmd: string,
	args: string[],
	opts: SpawnOptions = {},
): Promise<CapturedRun> {
	return new Promise(resolve => {
		const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
		let output = ''

		const collect = (chunk: Buffer): void => {
			output += chunk.toString()
		}
		child.stdout.on('data', collect)
		child.stderr.on('data', collect)

		child.on('error', (cause: Error) => resolve({ code: null, output: output + cause.message }))
		child.on('close', code => resolve({ code, output }))
	})
}

let bashAvailable: boolean | undefined
let warnedAboutShell = false

/** CI runs deploy commands under bash; matching that locally avoids cmd.exe surprises. */
function hasBash(): boolean {
	if (bashAvailable === undefined) {
		const probe = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' })
		bashAvailable = !probe.error && probe.status === 0
	}
	return bashAvailable
}

export function runShell(command: string, opts: SpawnOptions = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const useBash = hasBash()
		if (!useBash && !warnedAboutShell) {
			warnedAboutShell = true
			log.warn(
				'bash was not found, so this command runs under the platform shell. Quoting, `&&` and env-var syntax may not match CI, which always runs under bash.',
			)
		}

		// A --json run owns stdout for its one document, so the command's output goes to stderr.
		const stdio: StdioOptions = log.isStderr() ? ['inherit', 2, 'inherit'] : 'inherit'
		const child = useBash
			? spawn('bash', ['-c', command], { stdio, ...opts })
			: spawn(command, { shell: true, stdio, ...opts })

		child.on('error', reject)
		child.on('exit', code => {
			if (code === 0) resolve()
			else reject(new Error(`Command exited with code ${code ?? 'null'}.`))
		})
	})
}

export function spawnProcess(cmd: string, args: string[], opts: SpawnOptions = {}): ChildProcess {
	return spawn(cmd, args, {
		detached: !isWindows,
		...opts,
		// A generated watchdog in the app's vite config reads this to self-exit
		// if this CLI process disappears without a chance to clean up.
		env: { ...process.env, ...opts.env, SPOOL_PARENT_PID: String(process.pid) },
	})
}

/*
 *   KILL
 ***************************************************************************************************/
export async function killTree(
	child: ChildProcess,
	graceMs = DEFAULT_KILL_GRACE_MS,
): Promise<boolean> {
	if (child.pid === undefined) return true

	if (isWindows) {
		const result = spawnSync(
			system32Tool('taskkill.exe'),
			['/pid', String(child.pid), '/t', '/f'],
			{
				stdio: 'ignore',
			},
		)

		return result.status === 0 || result.status === 128
	}

	return killProcessGroupPosix(child, child.pid, graceMs)
}

async function killProcessGroupPosix(
	child: ChildProcess,
	pid: number,
	graceMs: number,
): Promise<boolean> {
	const exited = new Promise<boolean>(resolve => child.once('exit', () => resolve(true)))

	if (!signalGroupOrChild(pid, child, 'SIGTERM')) return true

	if (await Promise.race([exited, delay(graceMs).then(() => false)])) return true

	if (!signalGroupOrChild(pid, child, 'SIGKILL')) return true

	return Promise.race([exited, delay(KILL_CONFIRM_MS).then(() => false)])
}

function signalGroupOrChild(pid: number, child: ChildProcess, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal)
		return true
	} catch {
		try {
			child.kill(signal)
			return true
		} catch {
			// ESRCH: already exited.
			return false
		}
	}
}

export function killTreeSync(child: ChildProcess): void {
	if (child.pid === undefined) return

	if (isWindows) {
		spawnSync(system32Tool('taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], {
			stdio: 'ignore',
		})
		return
	}

	if (!signalGroupOrChild(child.pid, child, 'SIGKILL')) return
}

// ESRCH means no such process, which is the outcome a kill wanted. taskkill says the same with 128.
const alreadyGone = (error: unknown): boolean =>
	(error as NodeJS.ErrnoException | null)?.code === 'ESRCH'

export function killPid(pid: number): boolean {
	if (isWindows) {
		const result = spawnSync(system32Tool('taskkill.exe'), ['/pid', String(pid), '/t', '/f'], {
			stdio: 'ignore',
		})
		return result.status === 0 || result.status === 128
	}

	try {
		process.kill(-pid, 'SIGKILL')
		return true
	} catch {
		try {
			process.kill(pid, 'SIGKILL')
			return true
		} catch (error) {
			return alreadyGone(error)
		}
	}
}
