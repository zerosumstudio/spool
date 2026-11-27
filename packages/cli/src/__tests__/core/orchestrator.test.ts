/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { devAll, previewAll, buildAll, deployAll, killRunning } from '../../core/orchestrator.js'
import { runCaptured, runShell, spawnProcess, killTree, killPid } from '../../util/exec.js'
import { waitForManifest, portOwner } from '../../util/net.js'
import type * as OsModule from 'node:os'
import type * as ProcessModule from '../../util/process.js'
import { availableParallelism } from 'node:os'
import { readPidfile, writePidfile, removePidfile } from '../../core/pidfile.js'
import { CliError } from '../../util/errors.js'
import { inspectProcess } from '../../util/process.js'
import { viteInvocation } from '../../util/bin.js'
import {
	readDeployStore,
	recordDeploy,
	readBuiltSharedEntries,
	sharedConflicts,
} from '../../core/deploys.js'
import { log } from '../../util/logger.js'
import { makeWorkspace, host, remote, freshDir, removeDir } from '../helpers.js'

/*
 *   MOCKS
 ***************************************************************************************************/
vi.mock('../../util/exec.js', () => ({
	run: vi.fn(),
	runCaptured: vi.fn(),
	runShell: vi.fn(),
	spawnProcess: vi.fn(),
	killTree: vi.fn(),
	killTreeSync: vi.fn(),
	killPid: vi.fn(),
}))

vi.mock('node:os', async importOriginal => ({
	...(await importOriginal<typeof OsModule>()),
	availableParallelism: vi.fn(() => 8),
}))

vi.mock('../../util/bin.js', () => ({
	viteInvocation: vi.fn((dir: string, mode: string) => ({
		command: 'node',
		args: [`${dir}/vite.js`, ...(mode === 'dev' ? [] : [mode])],
	})),
	ladleInvocation: vi.fn((dir: string) => ({
		command: 'node',
		args: [`${dir}/ladle.js`, 'serve'],
	})),
}))

vi.mock('../../util/process.js', async importOriginal => ({
	...(await importOriginal<typeof ProcessModule>()),
	inspectProcess: vi.fn(),
}))

vi.mock('../../util/net.js', () => ({
	waitForManifest: vi.fn().mockResolvedValue(undefined),
	portOwner: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../core/pidfile.js', () => ({
	writePidfile: vi.fn(),
	readPidfile: vi.fn().mockReturnValue(undefined),
	removePidfile: vi.fn(),
}))

vi.mock('../../core/deploys.js', () => ({
	readDeployStore: vi.fn().mockReturnValue({}),
	recordDeploy: vi.fn(),
	deployHistory: vi.fn().mockReturnValue([]),
	readBuiltSharedEntries: vi.fn().mockReturnValue([]),
	sharedConflicts: vi.fn().mockReturnValue([]),
}))

type FakeStream = EventEmitter & { destroy: ReturnType<typeof vi.fn> }

interface FakeChild extends EventEmitter {
	pid: number
	stdout: FakeStream
	stderr: FakeStream
	kill: ReturnType<typeof vi.fn>
	spawnargs: string[]
}

const children: FakeChild[] = []

const fakeStream = (): FakeStream => Object.assign(new EventEmitter(), { destroy: vi.fn() })

function fakeChild(): FakeChild {
	const child = new EventEmitter() as FakeChild
	child.pid = 1000 + children.length
	child.stdout = fakeStream()
	child.stderr = fakeStream()
	child.kill = vi.fn()
	child.spawnargs = ['node', `/vite-${child.pid}.js`]
	return child
}

/*
 *   TEST SETUP
 ***************************************************************************************************/
beforeEach(() => {
	children.length = 0
	vi.mocked(spawnProcess).mockImplementation(() => {
		const child = fakeChild()
		children.push(child)
		return child as never
	})
	vi.mocked(killTree).mockResolvedValue(true)
	vi.mocked(killPid).mockReturnValue(true)
	vi.mocked(readDeployStore).mockReturnValue({})
	vi.mocked(recordDeploy).mockImplementation(() => {})
	vi.mocked(readBuiltSharedEntries).mockReturnValue([])
	vi.mocked(sharedConflicts).mockReturnValue([])
	vi.mocked(readPidfile).mockReturnValue(undefined)
	vi.mocked(portOwner).mockReset().mockResolvedValue(undefined)
	vi.mocked(inspectProcess).mockReset().mockReturnValue(undefined)
	// Guard: signal handlers exit directly; keep the test runner alive.
	vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
	vi.spyOn(log, 'step').mockImplementation(() => {})
	vi.spyOn(log, 'success').mockImplementation(() => {})
	vi.spyOn(log, 'warn').mockImplementation(() => {})
	vi.spyOn(log, 'error').mockImplementation(() => {})
	vi.spyOn(log, 'plain').mockImplementation(() => {})
	vi.spyOn(log, 'info').mockImplementation(() => {})
})

/** Feeds the vite startup lines that mark an app as ready. */
function emitReady(child: FakeChild, port: number): void {
	child.stdout.emit('data', Buffer.from('  VITE v8.1.3  ready in 500 ms\n'))
	child.stdout.emit('data', Buffer.from(`  ➤  Local:   http://localhost:${port}/\n`))
}

afterEach(() => {
	process.removeAllListeners('SIGINT')
	process.removeAllListeners('SIGTERM')
	process.removeAllListeners('SIGHUP')
	process.removeAllListeners('SIGBREAK')
	process.removeAllListeners('uncaughtException')
	process.removeAllListeners('unhandledRejection')
	process.removeAllListeners('exit')
	vi.clearAllMocks()
	vi.restoreAllMocks()
})

/*
 *   DEV
 ***************************************************************************************************/
describe('devAll', () => {
	it('warns and returns when there are no apps to run', async () => {
		const ws = makeWorkspace('/ws', {})
		await devAll(ws)
		expect(log.warn).toHaveBeenCalledWith('No apps to run.')
		expect(spawnProcess).not.toHaveBeenCalled()
	})

	it('starts remotes, waits for them, then starts hosts', async () => {
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		void devAll(ws)

		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))
		const cwds = vi
			.mocked(spawnProcess)
			.mock.calls.map(call => (call[2] as { cwd: string }).cwd)
		expect(cwds[0]).toContain('dashboard')
		expect(cwds[1]).toContain('shell')
	})

	it('tears everything down and rejects when a child crashes', async () => {
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		const running = devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))

		children[0]!.emit('exit', 1)

		await expect(running).rejects.toThrow('stopped unexpectedly')
		expect(killTree).toHaveBeenCalled()
		// Pipe handles must be released even if a child outlives its SIGTERM,
		// or the CLI hangs instead of exiting after the crash.
		expect(children[1]!.stdout.destroy).toHaveBeenCalled()
	})

	it('treats a signal-killed child (no exit code) as a failure too', async () => {
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		const running = devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		children[0]!.emit('exit', null)

		await expect(running).rejects.toThrow('killed unexpectedly')
	})

	it('reports one clear message and stops siblings when a binary is missing', async () => {
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		const running = devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))

		const err = Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' })
		children[0]!.emit('error', err)

		await expect(running).rejects.toThrow('Could not run node')
		expect(killTree).toHaveBeenCalled()
	})

	it('starts each app with node and its own vite, never the package manager', async () => {
		const ws = makeWorkspace('/ws', { dashboard: remote() })

		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		const [command, args, opts] = vi.mocked(spawnProcess).mock.calls[0]!
		expect(command).toBe('node')
		expect(args).toEqual([expect.stringMatching(/dashboard.vite\.js$/)])
		expect((opts as { cwd: string }).cwd).toContain('dashboard')
	})

	it('stops the apps already started when a later one has no vite installed', async () => {
		vi.mocked(viteInvocation)
			.mockImplementationOnce((dir: string) => ({
				command: 'node',
				args: [`${dir}/vite.js`],
			}))
			.mockImplementationOnce(() => {
				throw new CliError('Could not find "vite" from /ws/apps/shell.')
			})
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})

		const running = devAll(ws)
		running.catch(() => undefined)
		void emitWhenStarted()

		await expect(running).rejects.toThrow('Could not find "vite"')
		expect(killTree).toHaveBeenCalled()

		async function emitWhenStarted(): Promise<void> {
			await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
			emitReady(children[0]!, 5174)
		}
	})

	it('warns when --only leaves a host without its remotes', async () => {
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		void devAll(ws, { only: ['shell'] })
		await vi.waitFor(() =>
			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('dashboard')),
		)
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not selected'))
	})

	it('warns when a selected remote itself needs an unselected remote', async () => {
		const ws = makeWorkspace('/ws', {
			dashboard: remote({ remotes: ['widget'] }),
			widget: remote({ path: 'apps/widget', port: 5175 }),
		})
		void devAll(ws, { only: ['dashboard'] })
		await vi.waitFor(() =>
			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('widget')),
		)
	})

	it('only runs the apps named in the only filter', async () => {
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		void devAll(ws, { only: ['dashboard'] })
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
	})

	it('fails the build when a singleton shipped as two incompatible copies', async () => {
		const root = freshDir('spool-singleton-')
		vi.mocked(runCaptured).mockResolvedValue({ code: 0, output: '' })

		const write = (path: string, version: string, requiredVersion: string) => {
			mkdirSync(join(root, path, 'dist'), { recursive: true })
			writeFileSync(
				join(root, path, 'dist/mf-manifest.json'),
				JSON.stringify({ shared: [{ name: 'react', version, requiredVersion }] }),
			)
		}
		write('apps/shell', '20.0.0', '^20.0.0')
		write('apps/dashboard', '19.2.8', '^19.2.0')

		const ws = makeWorkspace(root, {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})

		await expect(buildAll(ws)).rejects.toThrow('more than one copy')
		removeDir(root)
	})

	it('rejects an unknown app name in the only filter', async () => {
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		await expect(devAll(ws, { only: ['ghost'] })).rejects.toThrow(
			'Unknown app(s) in --only: ghost',
		)
		expect(spawnProcess).not.toHaveBeenCalled()
	})

	it('prefixes each line of a child process output once servers are ready', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		emitReady(children[0]!, 5174)
		await vi.waitFor(() =>
			expect(log.plain).toHaveBeenCalledWith(expect.stringContaining('dev servers ready')),
		)
		children[0]!.stdout.emit('data', Buffer.from('hello\n'))
		expect(write).toHaveBeenCalledWith(expect.stringContaining('hello'))
	})

	it('carries a split line across chunks even after streaming has started', async () => {
		vi.useFakeTimers()
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		void devAll(ws)

		await vi.advanceTimersByTimeAsync(15_000)
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not reported ready'))

		children[0]!.stdout.emit('data', Buffer.from('half a li'))
		children[0]!.stdout.emit('data', Buffer.from('ne\n'))

		const out = write.mock.calls.map(call => call[0]).join('')
		expect(out).toContain('half a line')
		expect(out).not.toContain('half a li\n')
		vi.useRealTimers()
	})

	it('buffers startup noise and prints one summary when every app is ready', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))

		children[0]!.stdout.emit('data', Buffer.from('Failed to resolve dependency: noise\n'))
		expect(write).not.toHaveBeenCalled()

		emitReady(children[0]!, 5174)
		emitReady(children[1]!, 5173)
		// The trailing banner chunk lands inside the grace window and stays buffered.
		children[1]!.stdout.emit('data', Buffer.from('  ➤  Network: use --host to expose\n'))

		await vi.waitFor(() =>
			expect(log.plain).toHaveBeenCalledWith(expect.stringContaining('dev servers ready')),
		)
		const rows = vi.mocked(log.plain).mock.calls.map(call => call[0])
		const shellRow = rows.find(row => row.includes('shell'))!
		expect(shellRow).toContain('host · react')
		expect(shellRow).toContain('http://localhost:5173/')
		// The host row comes before the remote's, and the shared vite version
		// moves to the footer.
		expect(rows.indexOf(shellRow)).toBeLessThan(
			rows.findIndex(row => row.includes('dashboard')),
		)
		expect(rows.some(row => row.includes('vite 8.1.3'))).toBe(true)
		// The buffered noise never reaches the terminal.
		expect(write).not.toHaveBeenCalled()

		children[0]!.stdout.emit('data', Buffer.from('hmr update\n'))
		expect(write).toHaveBeenCalledWith(expect.stringContaining('hmr update'))
	})

	it('streams the buffered logs when servers never report ready', async () => {
		vi.useFakeTimers()
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		void devAll(ws)

		children[0]!.stdout.emit('data', Buffer.from('still starting\n'))
		expect(write).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(15_000)
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not reported ready'))
		expect(write).toHaveBeenCalledWith(expect.stringContaining('still starting'))
		vi.useRealTimers()
	})

	it('keeps per-row vite versions when apps disagree', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const ws = makeWorkspace('/ws', {
			dashboard: remote(),
			reports: remote({ path: 'apps/reports', port: 5175 }),
		})
		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))

		children[0]!.stdout.emit('data', Buffer.from('  VITE v8.1.3  ready in 500 ms\n'))
		children[0]!.stdout.emit('data', Buffer.from('  ➤  Local:   http://localhost:5174/\n'))
		children[1]!.stdout.emit('data', Buffer.from('  VITE v8.2.0  ready in 400 ms\n'))
		children[1]!.stdout.emit('data', Buffer.from('  ➤  Local:   http://localhost:5175/\n'))

		await vi.waitFor(() =>
			expect(log.plain).toHaveBeenCalledWith(expect.stringContaining('vite 8.1.3')),
		)
		const rows = vi.mocked(log.plain).mock.calls.map(call => call[0])
		expect(rows.some(row => row.includes('vite 8.2.0'))).toBe(true)
	})

	it('anchors the panel with a scroll region on a real terminal, without erasing the screen', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const stdout = process.stdout as unknown as {
			isTTY: boolean
			rows: number
			columns: number
		}
		const original = { isTTY: stdout.isTTY, rows: stdout.rows, columns: stdout.columns }
		Object.assign(stdout, { isTTY: true, rows: 40, columns: 120 })

		try {
			const ws = makeWorkspace('/ws', { dashboard: remote() })
			void devAll(ws)
			await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

			emitReady(children[0]!, 5174)
			// The panel paints at the top and confines scrolling below itself.
			await vi.waitFor(() =>
				expect(write).toHaveBeenCalledWith(expect.stringContaining('\x1b[H')),
			)
			const painted = write.mock.calls.map(call => call[0]).join('')
			expect(painted).toContain('dev servers ready')
			// A full screen clear would drop whatever was on screen before the panel.
			expect(painted).not.toContain('\x1b[2J')
			// The scroll region's bottom edge is the terminal's row count.
			expect(painted).toContain(';40r')

			// A resize repaints without clearing, so streamed history survives.
			write.mockClear()
			stdout.rows = 30
			process.stdout.emit('resize')
			const repaint = write.mock.calls.map(call => call[0]).join('')
			expect(repaint).not.toContain('\x1b[2J')
			expect(repaint).toContain(';30r')

			// Shrinking below the panel releases the region instead of leaving
			// stale bounds behind.
			write.mockClear()
			stdout.rows = 4
			process.stdout.emit('resize')
			expect(write).toHaveBeenCalledWith(expect.stringContaining('\x1b[r'))

			process.emit('SIGINT')
		} finally {
			Object.assign(stdout, original)
		}
	})

	it('dumps the buffered output of an app that crashes during startup', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		const running = devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		children[0]!.stdout.emit('data', Buffer.from('EADDRINUSE port taken\n'))
		children[0]!.emit('exit', 1)

		await expect(running).rejects.toThrow('stopped unexpectedly')
		expect(write).toHaveBeenCalledWith(expect.stringContaining('EADDRINUSE'))
	})

	it('dumps every sibling buffer on a crash, the crashing app last', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		const running = devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))

		children[0]!.stdout.emit('data', Buffer.from('dashboard bound port 5174\n'))
		children[1]!.stdout.emit('data', Buffer.from('shell exploding\n'))
		children[1]!.emit('exit', 1)

		await expect(running).rejects.toThrow('stopped unexpectedly')
		const out = write.mock.calls.map(call => call[0]).join('')
		expect(out).toContain('dashboard bound port 5174')
		expect(out.indexOf('dashboard bound port 5174')).toBeLessThan(
			out.indexOf('shell exploding'),
		)
	})

	it('detects the ready banner even when a chunk splits it mid-line', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		children[0]!.stdout.emit('data', Buffer.from('  VITE v8.1.3  re'))
		children[0]!.stdout.emit(
			'data',
			Buffer.from('ady in 500 ms\n  ➤  Local:   http://localhost:5174/\n'),
		)

		await vi.waitFor(() =>
			expect(log.plain).toHaveBeenCalledWith(expect.stringContaining('dev servers ready')),
		)
	})

	it('caps the startup buffer and notes the truncation when flushing', async () => {
		const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		const running = devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		const chatty = Array.from({ length: 450 }, (_, i) => `line ${i}`).join('\n')
		children[0]!.stdout.emit('data', Buffer.from(`${chatty}\n`))
		children[0]!.emit('exit', 1)

		await expect(running).rejects.toThrow('stopped unexpectedly')
		const out = write.mock.calls.map(call => call[0]).join('')
		expect(out).toContain('truncated')
		expect(out).not.toContain('line 0\n')
		expect(out).toContain('line 449')
	})

	it('warns when a remote does not come up in time', async () => {
		vi.mocked(waitForManifest).mockRejectedValueOnce(new Error('timeout'))
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		void devAll(ws)
		await vi.waitFor(() =>
			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not serving')),
		)
	})

	it('passes a --timeout seconds value through to the manifest wait', async () => {
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		void devAll(ws, { timeoutSeconds: 5 })
		await vi.waitFor(() => expect(waitForManifest).toHaveBeenCalled())
		const opts = vi.mocked(waitForManifest).mock.calls[0]![1] as { timeoutMs?: number }
		expect(opts.timeoutMs).toBe(5_000)
	})

	it('aborts the manifest poll instead of waiting out the timeout when a sibling dies', async () => {
		let capturedSignal: AbortSignal | undefined
		vi.mocked(waitForManifest).mockImplementation((_url, opts) => {
			capturedSignal = (opts as { signal?: AbortSignal }).signal
			return new Promise((_, reject) => {
				capturedSignal?.addEventListener('abort', () => reject(new Error('aborted')))
			})
		})
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})
		const running = devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		children[0]!.emit('exit', 1)

		await expect(running).rejects.toThrow('stopped unexpectedly')
		expect(capturedSignal?.aborted).toBe(true)
	})

	/*
	 *   PIDFILE
	 ***************************************************************************************************/
	it('writes a pidfile as children start and removes it on shutdown', async () => {
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		void devAll(ws)
		await vi.waitFor(() => expect(writePidfile).toHaveBeenCalled())

		const [, mode, tracked] = vi.mocked(writePidfile).mock.calls.at(-1)!
		expect(mode).toBe('dev')
		expect(tracked).toEqual([
			{
				name: 'dashboard',
				port: 5174,
				pid: children[0]!.pid,
				startedAt: expect.any(Number),
				match: children[0]!.spawnargs[1],
			},
		])

		process.emit('SIGINT')
		await vi.waitFor(() => expect(removePidfile).toHaveBeenCalledWith(ws, 'dev'))
	})

	/*
	 *   SIGNALS
	 ***************************************************************************************************/
	it.each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)('stops every child on %s', async signal => {
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		process.emit(signal)
		await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(0))
		expect(killTree).toHaveBeenCalledWith(children[0])
	})

	it('exits non-zero when a kill fails on Ctrl+C', async () => {
		vi.mocked(killTree).mockResolvedValue(false)
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		process.emit('SIGINT')
		await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1))
	})

	it('stops children and exits non-zero on an uncaught exception', async () => {
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

		process.emit('uncaughtException', new Error('boom'))
		await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1))
		expect(killTree).toHaveBeenCalledWith(children[0])
	})

	/*
	 *   REST
	 ***************************************************************************************************/
	describe('--rest built', () => {
		it('previews an excluded remote from its dist instead of warning', async () => {
			const root = freshDir('spool-rest-built-')
			mkdirSync(join(root, 'apps/dashboard/dist'), { recursive: true })
			const ws = makeWorkspace(root, {
				shell: host({ remotes: ['dashboard'] }),
				dashboard: remote(),
			})

			void devAll(ws, { only: ['shell'], rest: { kind: 'built' } })
			await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))

			const calls = vi.mocked(spawnProcess).mock.calls
			const builtCall = calls.find(call =>
				(call[2] as { cwd: string }).cwd.includes('dashboard'),
			)!
			expect(builtCall[0]).toBe('node')
			expect(builtCall[1]).toEqual([expect.stringContaining('dashboard'), 'preview'])
			expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('not selected'))
			removeDir(root)
		})

		it('fails clearly when the excluded remote has no dist yet', async () => {
			const root = freshDir('spool-rest-built-missing-')
			const ws = makeWorkspace(root, {
				shell: host({ remotes: ['dashboard'] }),
				dashboard: remote(),
			})

			await expect(devAll(ws, { only: ['shell'], rest: { kind: 'built' } })).rejects.toThrow(
				'dist folder',
			)
			removeDir(root)
		})
	})

	describe('--rest <env>', () => {
		it('points the selected app at the deployed url via SPOOL_REMOTE_<NAME>', async () => {
			const ws = makeWorkspace('/ws', {
				shell: host({ remotes: ['dashboard'] }),
				dashboard: remote({
					urls: { staging: 'https://staging.example.com/mf-manifest.json' },
				}),
			})

			void devAll(ws, { only: ['shell'], rest: { kind: 'env', env: 'staging' } })
			await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))

			const opts = vi.mocked(spawnProcess).mock.calls[0]![2] as {
				env?: Record<string, string>
			}
			expect(opts.env?.SPOOL_REMOTE_DASHBOARD).toBe(
				'https://staging.example.com/mf-manifest.json',
			)
		})

		it('fails clearly when the env has no url for the excluded remote', async () => {
			const ws = makeWorkspace('/ws', {
				shell: host({ remotes: ['dashboard'] }),
				dashboard: remote(),
			})

			await expect(
				devAll(ws, { only: ['shell'], rest: { kind: 'env', env: 'staging' } }),
			).rejects.toThrow('urls.staging')
		})
	})

	/*
	 *   KILL
	 ***************************************************************************************************/
	describe('killRunning', () => {
		const STARTED = Date.parse('2026-11-27T10:00:00.000Z')
		const tracked = (pid: number, extra: object = {}) => ({
			name: 'dashboard',
			port: 5174,
			pid,
			startedAt: STARTED,
			match: '/ws/node_modules/vite/bin/vite.js',
			...extra,
		})
		const alive = (pid: number, info: { startedAt?: number; commandLine?: string } = {}) =>
			vi.mocked(inspectProcess).mockImplementation(asked =>
				asked === pid
					? {
							startedAt: info.startedAt ?? STARTED + 400,
							commandLine:
								info.commandLine ?? 'node C:\\ws\\node_modules\\vite\\bin\\vite.js',
						}
					: undefined,
			)

		it('kills a pidfile pid whose start time and command line match, and clears the pidfile', async () => {
			vi.mocked(readPidfile).mockReturnValue({
				parentPid: 1,
				startedAt: new Date(STARTED).toISOString(),
				children: [tracked(4242)],
			})
			alive(4242)
			const ws = makeWorkspace('/ws', { dashboard: remote() })

			await killRunning(ws, 'dev')

			expect(killPid).toHaveBeenCalledTimes(1)
			expect(killPid).toHaveBeenCalledWith(4242)
			expect(removePidfile).toHaveBeenCalledWith(ws, 'dev')
		})

		it('leaves a reused pid alone: right command, started long after spool', async () => {
			vi.mocked(readPidfile).mockReturnValue({
				parentPid: 1,
				startedAt: new Date(STARTED).toISOString(),
				children: [tracked(4242)],
			})
			alive(4242, { startedAt: STARTED + 3 * 3_600_000 })
			const ws = makeWorkspace('/ws', { dashboard: remote() })

			await killRunning(ws, 'dev')

			expect(killPid).not.toHaveBeenCalled()
			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('pid was reused'))
		})

		it('leaves a reused pid alone: started on time but running something else', async () => {
			vi.mocked(readPidfile).mockReturnValue({
				parentPid: 1,
				startedAt: new Date(STARTED).toISOString(),
				children: [tracked(4242)],
			})
			alive(4242, { commandLine: 'C:\\Program Files\\Docker\\docker.exe' })
			const ws = makeWorkspace('/ws', { dashboard: remote() })

			await killRunning(ws, 'dev')

			expect(killPid).not.toHaveBeenCalled()
		})

		it('does not kill a pid from a pidfile that recorded no identity', async () => {
			vi.mocked(readPidfile).mockReturnValue({
				parentPid: 1,
				startedAt: new Date(STARTED).toISOString(),
				children: [{ name: 'dashboard', port: 5174, pid: 4242 }],
			})
			alive(4242)
			const ws = makeWorkspace('/ws', { dashboard: remote() })

			await killRunning(ws, 'dev')

			expect(killPid).not.toHaveBeenCalled()
			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('older spool'))
		})

		it('says nothing about a recorded pid that no longer exists', async () => {
			vi.mocked(readPidfile).mockReturnValue({
				parentPid: 1,
				startedAt: new Date(STARTED).toISOString(),
				children: [tracked(4242)],
			})
			vi.mocked(inspectProcess).mockReturnValue(undefined)
			const ws = makeWorkspace('/ws', { dashboard: remote() })

			await killRunning(ws, 'dev')

			expect(killPid).not.toHaveBeenCalled()
			expect(log.warn).not.toHaveBeenCalled()
		})

		it('reports a manifest port held by another process, never kills it, and fails PORT_IN_USE', async () => {
			vi.mocked(portOwner).mockResolvedValueOnce({ pid: 7777, command: 'node other-app' })
			const ws = makeWorkspace('/ws', { dashboard: remote() })

			await expect(killRunning(ws, 'dev')).rejects.toMatchObject({ code: 'PORT_IN_USE' })

			expect(killPid).not.toHaveBeenCalled()
			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('did not start'))
			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('pid 7777'))
		})

		it('still stops its own process when another port has a foreign owner', async () => {
			vi.mocked(readPidfile).mockReturnValue({
				parentPid: 1,
				startedAt: new Date(STARTED).toISOString(),
				children: [tracked(4242)],
			})
			alive(4242)
			vi.mocked(portOwner).mockImplementation(async port =>
				port === 5174 ? { pid: 4242 } : { pid: 7777, command: 'other' },
			)
			const ws = makeWorkspace('/ws', {
				shell: host(),
				dashboard: remote(),
			})

			await expect(killRunning(ws, 'dev')).rejects.toMatchObject({ code: 'PORT_IN_USE' })

			expect(killPid).toHaveBeenCalledWith(4242)
			expect(killPid).not.toHaveBeenCalledWith(7777)
		})

		it('says there is nothing to kill when nothing is running', async () => {
			const ws = makeWorkspace('/ws', { dashboard: remote() })
			await killRunning(ws, 'dev')
			expect(killPid).not.toHaveBeenCalled()
			expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Nothing to kill'))
		})
	})

	/*
	 *   LADLE
	 ***************************************************************************************************/
	/** Writes a packages/ui with a ladle script so the workshop is detected. */
	function withLadle(root: string): void {
		mkdirSync(join(root, 'packages/ui'), { recursive: true })
		writeFileSync(
			join(root, 'packages/ui/package.json'),
			JSON.stringify({ name: 'ui', scripts: { ladle: 'ladle serve' } }),
		)
	}

	const ladleCall = (): unknown[] | undefined =>
		vi
			.mocked(spawnProcess)
			.mock.calls.find(call => call[1].some(arg => arg.endsWith('ladle.js')))

	it('starts the ladle workshop alongside the apps when the addon is set up', async () => {
		const root = freshDir('spool-ladle-')
		withLadle(root)
		const ws = makeWorkspace(root, { dashboard: remote() })

		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))

		const call = ladleCall()
		expect(call).toBeDefined()
		expect(call![1]).toEqual([expect.stringContaining('ladle'), 'serve'])
		expect((call![2] as { cwd: string }).cwd).toContain(join('packages', 'ui'))
		removeDir(root)
	})

	it('shows the ladle workshop in the ready panel on its served url', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const root = freshDir('spool-ladle-panel-')
		withLadle(root)
		const ws = makeWorkspace(root, { dashboard: remote() })

		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))

		emitReady(children[0]!, 5174)
		// Ladle prints no VITE banner, only its own url line.
		children[1]!.stdout.emit(
			'data',
			Buffer.from('🥄 Ladle running at http://localhost:61000/\n'),
		)

		await vi.waitFor(() =>
			expect(log.plain).toHaveBeenCalledWith(expect.stringContaining('dev servers ready')),
		)
		const rows = vi.mocked(log.plain).mock.calls.map(call => call[0])
		const ladleRow = rows.find(row => row.includes('ladle'))!
		expect(ladleRow).toContain('component workshop')
		expect(ladleRow).toContain('http://localhost:61000/')
		removeDir(root)
	})

	it('keeps the app servers running when the ladle workshop exits', async () => {
		const root = freshDir('spool-ladle-crash-')
		withLadle(root)
		const ws = makeWorkspace(root, { dashboard: remote() })

		void devAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))

		// children[1] is the ladle process (spawned right after the sole remote).
		children[1]!.emit('exit', 1)
		await vi.waitFor(() =>
			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('ladle stopped')),
		)
		expect(killTree).not.toHaveBeenCalled()
		removeDir(root)
	})

	it('still runs the workshop under a narrowed --only run', async () => {
		const root = freshDir('spool-ladle-only-')
		withLadle(root)
		const ws = makeWorkspace(root, {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})

		void devAll(ws, { only: ['dashboard'] })
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2))
		expect(ladleCall()).toBeDefined()
		removeDir(root)
	})

	it('leaves the workshop out when --no-ladle is set', async () => {
		const root = freshDir('spool-ladle-off-')
		withLadle(root)
		const ws = makeWorkspace(root, { dashboard: remote() })

		void devAll(ws, { ladle: false })
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
		expect(ladleCall()).toBeUndefined()
		removeDir(root)
	})

	it('does not start the workshop in preview', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const root = freshDir('spool-ladle-preview-')
		withLadle(root)
		mkdirSync(join(root, 'apps/dashboard/dist'), { recursive: true })
		const ws = makeWorkspace(root, { dashboard: remote() })

		void previewAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
		expect(ladleCall()).toBeUndefined()
		removeDir(root)
	})
})

/*
 *   PREVIEW
 ***************************************************************************************************/
describe('previewAll', () => {
	it('refuses to preview before a build', async () => {
		const ws = makeWorkspace('/nope', { dashboard: remote() })
		await expect(previewAll(ws)).rejects.toThrow('spool build')
		expect(spawnProcess).not.toHaveBeenCalled()
	})

	it('serves dists with the preview script and readies on the url alone', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const root = freshDir('spool-preview-')
		mkdirSync(join(root, 'apps/dashboard/dist'), { recursive: true })
		const ws = makeWorkspace(root, { dashboard: remote() })

		void previewAll(ws)
		await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1))
		expect(vi.mocked(spawnProcess).mock.calls[0]![1]).toEqual([expect.any(String), 'preview'])

		// vite preview prints no version banner, only the Local line.
		children[0]!.stdout.emit('data', Buffer.from('  ➤  Local:   http://localhost:5174/\n'))
		await vi.waitFor(() =>
			expect(log.plain).toHaveBeenCalledWith(
				expect.stringContaining('preview servers ready'),
			),
		)
		const rows = vi.mocked(log.plain).mock.calls.map(call => call[0])
		expect(rows.some(row => row.includes('serving production builds'))).toBe(true)
		removeDir(root)
	})

	it('warns that hosts load a deployed remote instead of the local server', async () => {
		vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
		const root = freshDir('spool-preview-url-')
		mkdirSync(join(root, 'apps/shell/dist'), { recursive: true })
		mkdirSync(join(root, 'apps/dashboard/dist'), { recursive: true })
		const ws = makeWorkspace(root, {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote({ url: 'https://cdn.example.com/mf-manifest.json' }),
		})

		void previewAll(ws)
		await vi.waitFor(() =>
			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('SPOOL_REMOTE_')),
		)
		removeDir(root)
	})
})

/*
 *   BUILD
 ***************************************************************************************************/
describe('buildAll', () => {
	it('builds remotes before hosts', async () => {
		vi.mocked(runCaptured).mockResolvedValue({ code: 0, output: '' })
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})

		await buildAll(ws)

		const cwds = vi.mocked(runCaptured).mock.calls.map(call => (call[2] as { cwd: string }).cwd)
		expect(cwds[0]).toContain('dashboard')
		expect(cwds[1]).toContain('shell')
		expect(log.success).toHaveBeenCalledWith('built 2 app(s)')
	})

	it('throws a helpful error naming the app that failed', async () => {
		vi.mocked(runCaptured).mockResolvedValue({ code: 1, output: 'boom' })
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		await expect(buildAll(ws)).rejects.toThrow('Build failed for "dashboard"')
	})

	it('names every app that failed, and prints what each one said', async () => {
		vi.mocked(runCaptured).mockImplementation((_cmd, _args, opts) =>
			Promise.resolve(
				(opts as { cwd: string }).cwd.includes('reports')
					? { code: 0, output: '' }
					: { code: 1, output: 'it broke' },
			),
		)
		const ws = makeWorkspace('/ws', {
			dashboard: remote(),
			profile: remote({ path: 'apps/profile', port: 5175 }),
			reports: remote({ path: 'apps/reports', port: 5176 }),
		})

		await expect(buildAll(ws)).rejects.toThrow('Builds failed for "dashboard", "profile"')
		expect(log.plain).toHaveBeenCalledWith('it broke')
	})

	it('builds a tier concurrently', async () => {
		let running = 0
		let peak = 0
		vi.mocked(runCaptured).mockImplementation(async () => {
			running++
			peak = Math.max(peak, running)
			await new Promise(resolve => setImmediate(resolve))
			running--
			return { code: 0, output: '' }
		})
		const ws = makeWorkspace('/ws', {
			dashboard: remote(),
			profile: remote({ path: 'apps/profile', port: 5175 }),
		})

		await buildAll(ws)

		expect(peak).toBe(2)
	})

	it('honours a concurrency of one', async () => {
		let running = 0
		let peak = 0
		vi.mocked(runCaptured).mockImplementation(async () => {
			running++
			peak = Math.max(peak, running)
			await new Promise(resolve => setImmediate(resolve))
			running--
			return { code: 0, output: '' }
		})
		const ws = makeWorkspace('/ws', {
			dashboard: remote(),
			profile: remote({ path: 'apps/profile', port: 5175 }),
		})

		await buildAll(ws, { concurrency: 1 })

		expect(peak).toBe(1)
	})

	it('runs vite itself for a build, through node and never the package manager', async () => {
		vi.mocked(runCaptured).mockResolvedValue({ code: 0, output: '' })
		const ws = makeWorkspace('/ws', { dashboard: remote() })

		await buildAll(ws)

		const [command, args, opts] = vi.mocked(runCaptured).mock.calls[0]!
		expect(command).toBe('node')
		expect(args).toEqual([expect.stringContaining('vite.js'), 'build'])
		expect((opts as { cwd: string }).cwd).toContain('dashboard')
		expect(viteInvocation).toHaveBeenCalledWith(
			expect.stringContaining('dashboard'),
			'build',
			expect.any(String),
		)
	})

	it('fails a build, with the reason, when the app has no vite installed', async () => {
		vi.mocked(viteInvocation).mockImplementationOnce(() => {
			throw new CliError('Could not find "vite" from /ws/apps/dashboard.')
		})
		const ws = makeWorkspace('/ws', { dashboard: remote() })

		await expect(buildAll(ws)).rejects.toMatchObject({ code: 'BUILD_FAILED' })
		expect(runCaptured).not.toHaveBeenCalled()
	})

	it.each([
		[16, 4],
		[8, 4],
		[6, 3],
		[4, 2],
		[2, 1],
		[1, 1],
	])('builds at most min(4, cores / 2) at once: %i cores run %i', async (cores, expected) => {
		vi.mocked(availableParallelism).mockReturnValue(cores)
		let running = 0
		let peak = 0
		vi.mocked(runCaptured).mockImplementation(async () => {
			running++
			peak = Math.max(peak, running)
			await new Promise(resolve => setImmediate(resolve))
			running--
			return { code: 0, output: '' }
		})
		const apps = Object.fromEntries(
			Array.from({ length: 8 }, (_, index) => [
				`app${index}`,
				remote({ path: `apps/app${index}`, port: 6000 + index }),
			]),
		)

		await buildAll(makeWorkspace('/ws', apps))

		expect(peak).toBe(expected)
	})

	it('finishes every remote before starting a host', async () => {
		const order: string[] = []
		vi.mocked(runCaptured).mockImplementation(async (_cmd, _args, opts) => {
			const { cwd } = opts as { cwd: string }
			order.push(`start:${cwd}`)
			await new Promise(resolve => setImmediate(resolve))
			order.push(`end:${cwd}`)
			return { code: 0, output: '' }
		})
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'] }),
			dashboard: remote(),
		})

		await buildAll(ws)

		const shellStart = order.findIndex(
			entry => entry.startsWith('start:') && entry.includes('shell'),
		)
		const remoteEnd = order.findIndex(
			entry => entry.startsWith('end:') && entry.includes('dashboard'),
		)
		expect(remoteEnd).toBeLessThan(shellStart)
	})

	it('rejects an unknown app name in the only filter', async () => {
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		await expect(buildAll(ws, { only: ['ghost'] })).rejects.toThrow(
			'Unknown app(s) in --only: ghost',
		)
		expect(runCaptured).not.toHaveBeenCalled()
	})

	it('passes --env to app builds through SPOOL_ENV', async () => {
		vi.mocked(runCaptured).mockResolvedValue({ code: 0, output: '' })
		const ws = makeWorkspace('/ws', { dashboard: remote() })

		await buildAll(ws, { env: 'staging' })

		const opts = vi.mocked(runCaptured).mock.calls[0]![2] as { env?: Record<string, string> }
		expect(opts.env?.SPOOL_ENV).toBe('staging')
	})

	it('inherits the plain environment when --env is not given', async () => {
		vi.mocked(runCaptured).mockResolvedValue({ code: 0, output: '' })
		const ws = makeWorkspace('/ws', { dashboard: remote() })

		await buildAll(ws)

		const opts = vi.mocked(runCaptured).mock.calls[0]![2] as { env?: Record<string, string> }
		expect(opts.env).toBeUndefined()
	})

	it('warns when no selected remote has a urls entry for --env', async () => {
		vi.mocked(runCaptured).mockResolvedValue({ code: 0, output: '' })
		const ws = makeWorkspace('/ws', { dashboard: remote() })

		await buildAll(ws, { env: 'staging' })
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('urls.staging'))
	})

	it('reports one result per app via the onResult callback, for --json', async () => {
		vi.mocked(runCaptured).mockImplementation((_cmd, _args, opts) =>
			Promise.resolve(
				(opts as { cwd: string }).cwd.includes('profile')
					? { code: 1, output: 'nope' }
					: { code: 0, output: '' },
			),
		)
		const ws = makeWorkspace('/ws', {
			dashboard: remote(),
			profile: remote({ path: 'apps/profile', port: 5175 }),
		})
		const results: { name: string; ok: boolean }[] = []

		await expect(buildAll(ws, { onResult: r => results.push(r) })).rejects.toThrow()

		expect(results).toContainEqual(expect.objectContaining({ name: 'dashboard', ok: true }))
		expect(results).toContainEqual(expect.objectContaining({ name: 'profile', ok: false }))
	})
})

/*
 *   DEPLOY
 ***************************************************************************************************/
describe('deployAll', () => {
	it('runs each deploy command in its app folder, remotes before hosts', async () => {
		vi.mocked(runShell).mockResolvedValue(undefined)
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'], deploy: 'deploy-shell' }),
			dashboard: remote({
				deploy: 'deploy-dashboard',
				url: 'https://d.example.com/mf-manifest.json',
			}),
		})

		await deployAll(ws)

		const calls = vi.mocked(runShell).mock.calls
		expect(calls[0]![0]).toBe('deploy-dashboard')
		expect((calls[0]![1] as { cwd: string }).cwd).toContain('dashboard')
		expect(calls[1]![0]).toBe('deploy-shell')
		expect(log.success).toHaveBeenCalledWith('deployed 2 app(s)')
	})

	it('skips apps without a deploy command and says so', async () => {
		vi.mocked(runShell).mockResolvedValue(undefined)
		const ws = makeWorkspace('/ws', {
			shell: host({ remotes: ['dashboard'], deploy: 'deploy-shell' }),
			dashboard: remote({ url: 'https://d.example.com/mf-manifest.json' }),
		})

		await deployAll(ws)

		expect(runShell).toHaveBeenCalledTimes(1)
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no "deploy" command'))
	})

	it('rejects when no app has a deploy command', async () => {
		const ws = makeWorkspace('/ws', { dashboard: remote() })
		await expect(deployAll(ws)).rejects.toThrow('Nothing to deploy')
		expect(runShell).not.toHaveBeenCalled()
	})

	it('names the app whose deploy failed', async () => {
		vi.mocked(runShell).mockRejectedValue(new Error('boom'))
		const ws = makeWorkspace('/ws', { dashboard: remote({ deploy: 'bad-command' }) })
		await expect(deployAll(ws)).rejects.toThrow('Deploy failed for "dashboard"')
	})

	it('reminds you to set url after deploying a remote without one', async () => {
		vi.mocked(runShell).mockResolvedValue(undefined)
		const ws = makeWorkspace('/ws', { dashboard: remote({ deploy: 'deploy-dashboard' }) })
		await deployAll(ws)
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('has no "url"'))
	})

	it('warns when the app has no dist folder yet', async () => {
		vi.mocked(runShell).mockResolvedValue(undefined)
		const ws = makeWorkspace('/ws', {
			dashboard: remote({ deploy: 'x', url: 'https://d.example.com/mf-manifest.json' }),
		})
		await deployAll(ws)
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no dist folder'))
	})

	it('hands --env to deploy commands as SPOOL_ENV', async () => {
		vi.mocked(runShell).mockResolvedValue(undefined)
		vi.mocked(runCaptured).mockResolvedValue({ code: 0, output: 'abc1234' })
		const ws = makeWorkspace('/ws', {
			dashboard: remote({ deploy: 'x', url: 'https://d.example.com/mf-manifest.json' }),
		})

		await deployAll(ws, undefined, 'staging')

		const opts = vi.mocked(runShell).mock.calls[0]![1] as { env?: Record<string, string> }
		expect(opts.env?.SPOOL_ENV).toBe('staging')
	})

	it('reports one result per app via the onResult callback, for --json', async () => {
		vi.mocked(runShell).mockResolvedValue(undefined)
		const ws = makeWorkspace('/ws', { dashboard: remote({ deploy: 'x' }) })
		const results: { name: string; ok: boolean }[] = []

		await deployAll(ws, undefined, undefined, r => results.push(r))

		expect(results).toEqual([expect.objectContaining({ name: 'dashboard', ok: true })])
	})

	describe('the shared-version gate (env-scoped)', () => {
		it('blocks a deploy that would ship a version another app cannot accept', async () => {
			vi.mocked(runShell).mockResolvedValue(undefined)
			vi.mocked(sharedConflicts).mockReturnValue([
				{
					dep: 'react',
					otherApp: 'shell',
					otherVersion: '17.0.0',
					requiredVersion: '^18.0.0',
				},
			])
			const ws = makeWorkspace('/ws', { dashboard: remote({ deploy: 'x' }) })

			await expect(deployAll(ws, undefined, 'production')).rejects.toThrow('react')
			expect(runShell).not.toHaveBeenCalled()
		})

		it('records the deploy after a successful run', async () => {
			vi.mocked(runShell).mockResolvedValue(undefined)
			vi.mocked(runCaptured).mockResolvedValue({ code: 0, output: 'deadbeef' })
			vi.mocked(readBuiltSharedEntries).mockReturnValue([
				{ name: 'react', version: '18.2.0' },
			])
			const ws = makeWorkspace('/ws', {
				dashboard: remote({
					deploy: 'x',
					urls: { production: 'https://d.example.com/mf.json' },
				}),
			})

			await deployAll(ws, undefined, 'production')

			expect(recordDeploy).toHaveBeenCalledWith(
				ws,
				'production',
				'dashboard',
				expect.objectContaining({
					sha: 'deadbeef',
					url: 'https://d.example.com/mf.json',
					shared: { react: '18.2.0' },
				}),
			)
		})

		it('does not gate or record when no --env is given', async () => {
			vi.mocked(runShell).mockResolvedValue(undefined)
			const ws = makeWorkspace('/ws', { dashboard: remote({ deploy: 'x' }) })

			await deployAll(ws)

			expect(sharedConflicts).not.toHaveBeenCalled()
			expect(recordDeploy).not.toHaveBeenCalled()
		})
	})
})
