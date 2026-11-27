/*
 *   IMPORTS
 ***************************************************************************************************/
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Workspace } from './workspace.js'
import type { AppConfig } from './config.js'
import { checkBuiltSingletons, describeShipped } from './federation.js'
import { existsSync, readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import {
	runCaptured,
	runShell,
	spawnProcess,
	killTree,
	killTreeSync,
	killPid,
} from '../util/exec.js'
import { waitForManifest, portOwner } from '../util/net.js'
import { ladleInvocation, viteInvocation, type Invocation } from '../util/bin.js'
import { inspectProcess, isSameProcess, type ExpectedProcess } from '../util/process.js'
import { remoteEnvVar } from '../util/names.js'
import { CliError } from '../util/errors.js'
import { log } from '../util/logger.js'
import { style } from '../util/style.js'
import { DevOutput, pickColor, type ServeMode, type TrackMeta } from './output.js'
import {
	writePidfile,
	readPidfile,
	removePidfile,
	type Pidfile,
	type TrackedChild,
} from './pidfile.js'
import {
	readDeployStore,
	recordDeploy,
	readBuiltSharedEntries,
	sharedConflicts,
	type DeployRecord,
} from './deploys.js'

/*
 *   TYPES
 ***************************************************************************************************/

interface NamedApp {
	name: string
	app: AppConfig
}

export interface AppRunResult {
	name: string
	ok: boolean
	durationMs: number
	error?: string
}

/** "built" previews an unselected remote's dist; an env name points hosts at its deployed url. */
export type RestSpec = { kind: 'built' } | { kind: 'env'; env: string }

export interface ServeOptions {
	only?: string[]
	rest?: RestSpec
	/** Seconds to wait for each remote's manifest before starting hosts anyway. */
	timeoutSeconds?: number
	/** Ladle runs by default, including under --only; --no-ladle sets this false. */
	ladle?: boolean
}

/*
 *   SELECTION
 ***************************************************************************************************/
function selectApps(ws: Workspace, only?: string[]): NamedApp[] {
	const all = Object.entries(ws.manifest.apps).map(([name, app]) => ({ name, app }))
	if (!only?.length) return all

	const known = new Set(all.map(a => a.name))
	const unknown = only.filter(name => !known.has(name))
	if (unknown.length) {
		throw new CliError(
			`Unknown app(s) in --only: ${unknown.join(', ')}. Check the names in spool.json.`,
			'APP_NOT_FOUND',
		)
	}
	return all.filter(a => only.includes(a.name))
}

function missingRemotes(app: AppConfig, selectedNames: Set<string>): string[] {
	return app.remotes.filter(r => !selectedNames.has(r))
}

/**
 * A host (or a remote consuming another remote) started without its remotes
 * fails at runtime when it imports them. Warn up front instead of leaving it
 * to the browser console.
 */
function warnExcludedRemotes(selected: NamedApp[]): void {
	const names = new Set(selected.map(a => a.name))
	for (const { name, app } of selected) {
		const missing = missingRemotes(app, names)
		if (missing.length) {
			log.warn(
				`${name} expects remote(s) ${missing.join(', ')} that are not selected. Start them separately, or use \`spool dev --rest\`.`,
			)
		}
	}
}

/** The remotes a selection needs but did not include; candidates for --rest. */
function excludedRemotes(ws: Workspace, selected: NamedApp[]): NamedApp[] {
	const names = new Set(selected.map(a => a.name))
	const needed = new Set<string>()

	for (const { app } of selected) {
		for (const name of missingRemotes(app, names)) needed.add(name)
	}

	return [...needed]
		.map(name => ({ name, app: ws.manifest.apps[name] }))
		.filter((a): a is NamedApp => a.app !== undefined)
}

const remotesOf = (apps: NamedApp[]): NamedApp[] => apps.filter(a => a.app.type === 'remote')
const hostsOf = (apps: NamedApp[]): NamedApp[] => apps.filter(a => a.app.type === 'host')

/*
 *   DEV / PREVIEW
 ***************************************************************************************************/
export function devAll(ws: Workspace, opts: ServeOptions = {}): Promise<void> {
	return serveAll(ws, 'dev', opts)
}

export function previewAll(ws: Workspace, opts: ServeOptions = {}): Promise<void> {
	return serveAll(ws, 'preview', opts)
}

interface RestResolution {
	builtRemotes: NamedApp[]
	envVars: NodeJS.ProcessEnv
}

/** Resolves --rest for the remotes a selection needs but excluded. */
function resolveRest(
	ws: Workspace,
	excluded: NamedApp[],
	rest: RestSpec | undefined,
): RestResolution {
	if (!rest || !excluded.length) return { builtRemotes: [], envVars: {} }

	if (rest.kind === 'built') {
		const missingDist = excluded.filter(
			({ app }) => !existsSync(join(ws.root, app.path, 'dist')),
		)
		if (missingDist.length) {
			const names = missingDist.map(a => a.name).join(',')
			throw new CliError(
				`--rest built needs a dist folder for ${missingDist.map(a => a.name).join(', ')}. Run \`spool build --only ${names}\` first.`,
			)
		}
		return { builtRemotes: excluded, envVars: {} }
	}

	const envVars: NodeJS.ProcessEnv = {}
	const unresolved: string[] = []

	for (const { name, app } of excluded) {
		const url = app.urls?.[rest.env] ?? app.url
		if (!url) {
			unresolved.push(name)
			continue
		}
		envVars[remoteEnvVar(name)] = url
	}

	if (unresolved.length) {
		throw new CliError(
			`--rest ${rest.env} needs a "urls.${rest.env}" or "url" for ${unresolved.join(', ')} in spool.json.`,
			'INVALID_VALUE',
		)
	}

	return { builtRemotes: [], envVars }
}

async function serveAll(ws: Workspace, mode: ServeMode, opts: ServeOptions = {}): Promise<void> {
	const apps = selectApps(ws, opts.only)

	if (!apps.length) {
		log.warn('No apps to run.')
		return
	}

	if (mode === 'preview') {
		requireDists(ws, apps)
		warnDeployedUrls(apps)
	}

	const excluded = excludedRemotes(ws, apps)
	const rest = resolveRest(ws, excluded, opts.rest)
	if (!opts.rest) warnExcludedRemotes(apps)

	const remotes = remotesOf(apps)
	const hosts = hostsOf(apps)
	const ladle = mode === 'dev' && opts.ladle !== false ? detectLadle(ws) : undefined
	const runningCount = apps.length + rest.builtRemotes.length
	const total = runningCount + (ladle ? 1 : 0)
	const session = new ServeSession(ws, mode, new DevOutput(total, mode))

	session.trapSignals()
	log.step(`starting ${runningCount} app(s), remotes first`)

	let index = 0
	for (const remote of remotes) session.start(remote, index++, rest.envVars)
	for (const built of rest.builtRemotes) session.startBuilt(built, index++)
	if (ladle) session.startLadle(ladle, index++)

	const timeoutMs = opts.timeoutSeconds === undefined ? undefined : opts.timeoutSeconds * 1000
	const controller = new AbortController()
	session.crashed.catch(() => controller.abort())

	await Promise.race([
		Promise.all(remotes.map(remote => waitForRemote(remote, timeoutMs, controller.signal))),
		session.crashed,
	])

	for (const host of hosts) session.start(host, index++, rest.envVars)

	await session.crashed
}

/*
 *   KILL
 ***************************************************************************************************/
interface KillTarget {
	pid: number
	name: string
}

/**
 * Splits a pidfile's processes into those that are still the ones spool started
 * and those that are not. A pid is only killed when the OS reports the start time
 * and command line spool recorded for it: anything else is a reused pid or a
 * process an older spool never described, and is left alone.
 */
function verifyTracked(
	pidfile: Pidfile,
	mode: ServeMode,
): { stop: KillTarget[]; skipped: string[] } {
	const stop: KillTarget[] = []
	const skipped: string[] = []

	const candidates: { pid: number; name: string; expected: ExpectedProcess | undefined }[] = []

	if (pidfile.parentPid !== process.pid) {
		candidates.push({
			pid: pidfile.parentPid,
			name: `${mode} session`,
			expected: pidfile.parent,
		})
	}
	for (const child of pidfile.children) {
		const { startedAt, match } = child

		candidates.push({
			pid: child.pid,
			name: child.name,
			expected:
				startedAt !== undefined && match !== undefined ? { startedAt, match } : undefined,
		})
	}

	for (const { pid, name, expected } of candidates) {
		const info = inspectProcess(pid)
		if (!info) continue

		if (!expected) {
			skipped.push(
				`${name} (pid ${pid}) was recorded by an older spool, so it cannot be told from another process`,
			)
		} else if (!isSameProcess(info, expected)) {
			skipped.push(
				`pid ${pid} is no longer ${name}: the pid was reused by ${info.commandLine || 'another process'}`,
			)
		} else {
			stop.push({ pid, name })
		}
	}

	return { stop, skipped }
}

/**
 * Stops what the last `dev` or `preview` started and nothing else. A manifest port
 * held by any other process is reported and left running, then fails with PORT_IN_USE.
 */
export async function killRunning(ws: Workspace, mode: ServeMode): Promise<void> {
	const pidfile = readPidfile(ws, mode)
	const { stop, skipped } = pidfile ? verifyTracked(pidfile, mode) : { stop: [], skipped: [] }
	const ours = new Set(stop.map(target => target.pid))
	const foreign: string[] = []

	for (const [name, app] of Object.entries(ws.manifest.apps)) {
		const owner = await portOwner(app.port)
		if (!owner || ours.has(owner.pid)) continue

		foreign.push(
			`port ${app.port} (${name}) is used by ${owner.command ?? 'another process'} (pid ${owner.pid}), which spool did not start`,
		)
	}

	removePidfile(ws, mode)

	for (const note of skipped) log.warn(`not stopping ${note}.`)
	for (const { pid, name } of stop) {
		if (killPid(pid)) log.step(`stopped ${name} (pid ${pid})`)
		else log.warn(`could not stop ${name} (pid ${pid}); it may need killing by hand.`)
	}

	if (foreign.length) {
		for (const note of foreign) log.warn(`${note}. Not stopping it.`)

		throw new CliError(
			`${foreign.length} manifest port(s) are held by processes spool did not start, so they were left running. Stop them yourself, or change the port in spool.json.`,
			'PORT_IN_USE',
		)
	}

	if (!stop.length && !skipped.length) {
		log.info(
			`Nothing to kill: no ${mode} processes of spool's are running and the manifest ports are free.`,
		)
		return
	}

	log.success(`stopped ${stop.length} process(es)`)
}

/** What `--kill` needs to recognise a child later: when it started and the script it runs. */
function recordedProcess(child: ChildProcess): Partial<ExpectedProcess> {
	const script = child.spawnargs.at(1)

	return script === undefined ? {} : { startedAt: Date.now(), match: script }
}

class ServeSession {
	private readonly children: ChildProcess[] = []
	private readonly tracked: TrackedChild[] = []
	private shuttingDown = false
	private reportCrash!: (error: Error) => void

	readonly crashed: Promise<never>

	constructor(
		private readonly ws: Workspace,
		private readonly mode: ServeMode,
		private readonly output: DevOutput,
	) {
		this.crashed = new Promise<never>((_, reject) => {
			this.reportCrash = reject
		})
	}

	private readonly onGracefulSignal = (): void => {
		void this.exitAfterStop(0)
	}

	private readonly onFatal = (error: unknown): void => {
		log.error(error instanceof Error ? error.message : String(error))
		void this.exitAfterStop(1)
	}

	private readonly onProcessExit = (): void => {
		if (this.shuttingDown) return

		this.output.dispose()
		for (const child of this.children) killTreeSync(child)

		removePidfile(this.ws, this.mode)
	}

	trapSignals(): void {
		process.on('SIGINT', this.onGracefulSignal)
		process.on('SIGTERM', this.onGracefulSignal)
		process.on('SIGHUP', this.onGracefulSignal)
		if (process.platform === 'win32') process.on('SIGBREAK', this.onGracefulSignal)
		process.on('uncaughtException', this.onFatal)
		process.on('unhandledRejection', this.onFatal)
		process.on('exit', this.onProcessExit)
	}

	private async exitAfterStop(code: number): Promise<void> {
		const ok = await this.stopAll()
		process.exit(ok ? code : 1)
	}

	/** Kills every tracked child and confirms it. Resolves false if any kill failed. */
	async stopAll(): Promise<boolean> {
		if (this.shuttingDown) return true

		this.shuttingDown = true
		this.output.dispose()
		removePidfile(this.ws, this.mode)

		const results = await Promise.all(
			this.children.map(async child => {
				const ok = await killTree(child)
				child.stdout?.destroy()
				child.stderr?.destroy()

				return ok
			}),
		)

		return results.every(Boolean)
	}

	private trackChild(name: string, port: number, child: ChildProcess): void {
		this.children.push(child)
		if (child.pid !== undefined) {
			this.tracked.push({
				name,
				port,
				pid: child.pid,
				...recordedProcess(child),
			})
		}

		writePidfile(this.ws, this.mode, this.tracked)
	}

	private failToStart(name: string, error: unknown): void {
		void this.stopAll()
		this.reportCrash(
			error instanceof CliError
				? error
				: new CliError(`${name} failed to start: ${String(error)}`),
		)
	}

	private handleSpawnFailure(name: string, error: NodeJS.ErrnoException): void {
		if (this.shuttingDown) return

		this.output.flushAll(name)
		void this.stopAll()

		const hint =
			error.code === 'ENOENT'
				? 'Could not run node. This should never happen; reinstall node.'
				: error.message
		this.reportCrash(new CliError(`${name} failed to start: ${hint}`))
	}

	private handleAppExit(name: string, code: number | null): void {
		if (this.shuttingDown || code === 0) return

		setImmediate(() => {
			if (this.shuttingDown) return
			// The buffered startup output is the only clue to why it died.
			this.output.flushAll(name)
			void this.stopAll()
			this.reportCrash(
				new CliError(
					code === null
						? `${name} was killed unexpectedly. Shutting down the others.`
						: `${name} stopped unexpectedly (exit ${code}). Shutting down the others.`,
				),
			)
		})
	}

	start(named: NamedApp, colorIndex: number, extraEnv?: NodeJS.ProcessEnv): void {
		let child: ChildProcess
		try {
			child = spawnApp(
				this.ws,
				named,
				pickColor(colorIndex),
				this.output,
				this.mode,
				extraEnv,
			)
		} catch (error) {
			this.failToStart(named.name, error)
			return
		}

		child.on('error', error =>
			this.handleSpawnFailure(named.name, error as NodeJS.ErrnoException),
		)
		child.on('exit', code => this.handleAppExit(named.name, code))

		this.trackChild(named.name, named.app.port, child)
	}

	/** Ladle is auxiliary: a workshop that cannot start is a warning, never a crash. */
	private resolveLadle(dir: string): Invocation | undefined {
		try {
			return ladleInvocation(dir, this.ws.root)
		} catch (error) {
			log.warn(
				`ladle failed to start (${error instanceof Error ? error.message : String(error)}). The app servers are still running.`,
			)
			return undefined
		}
	}

	/** Previews an unselected remote's dist for `--rest built`, regardless of the session's own mode. */
	startBuilt(named: NamedApp, colorIndex: number): void {
		const dir = join(this.ws.root, named.app.path)
		let child: ChildProcess
		try {
			const { command, args } = viteInvocation(dir, 'preview', this.ws.root)
			child = spawnProcess(command, args, { cwd: dir })
		} catch (error) {
			this.failToStart(named.name, error)
			return
		}

		child.on('error', error =>
			this.handleSpawnFailure(named.name, error as NodeJS.ErrnoException),
		)
		child.on('exit', code => this.handleAppExit(named.name, code))

		const meta: TrackMeta = {
			role: `${named.app.type} · preview (--rest built)`,
			port: named.app.port,
			order: 1,
		}
		const status = this.output.track(named.name, meta, pickColor(colorIndex))
		child.stdout?.on('data', (d: Buffer) => this.output.chunk(status, d, false))
		child.stderr?.on('data', (d: Buffer) => this.output.chunk(status, d, true))

		this.trackChild(named.name, named.app.port, child)
	}

	startLadle(info: LadleProcess, colorIndex: number): void {
		const dir = join(this.ws.root, info.dir)
		const invocation = this.resolveLadle(dir)
		if (!invocation) return

		const child = spawnProcess(invocation.command, invocation.args, { cwd: dir })
		const status = this.output.track(
			info.name,
			{ role: 'component workshop', port: info.port, order: 2, readyOnUrl: true },
			pickColor(colorIndex),
		)

		child.stdout?.on('data', (d: Buffer) => this.output.chunk(status, d, false))
		child.stderr?.on('data', (d: Buffer) => this.output.chunk(status, d, true))

		child.on('error', (error: NodeJS.ErrnoException) => {
			if (this.shuttingDown) return

			this.output.drop(info.name)
			log.warn(
				`ladle failed to start (${error.code ?? error.message}). The app servers are still running.`,
			)
		})

		child.on('exit', code => {
			if (this.shuttingDown || code === 0 || code === null) return

			// Ladle is auxiliary -- a failed workshop must not take the app servers down.
			setImmediate(() => {
				if (this.shuttingDown) return

				this.output.drop(info.name)
				log.warn(`ladle stopped (exit ${code}). The app servers are still running.`)
			})
		})

		this.trackChild(info.name, info.port, child)
	}
}

/*
 *   LADLE
 ***************************************************************************************************/
const LADLE_PORT = 61000

interface LadleProcess {
	name: string
	dir: string
	script: string
	port: number
}

function detectLadle(ws: Workspace): LadleProcess | undefined {
	const dir = 'packages/ui'
	const pkgPath = join(ws.root, dir, 'package.json')
	if (!existsSync(pkgPath)) return undefined
	try {
		const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
			scripts?: Record<string, string>
		}
		if (!pkg.scripts?.ladle) return undefined
	} catch {
		return undefined
	}
	return { name: 'ladle', dir, script: 'ladle', port: LADLE_PORT }
}

/** Preview serves dist folders; failing up front beats vite's per-app error. */
function requireDists(ws: Workspace, apps: NamedApp[]): void {
	const missing = apps.filter(({ app }) => !existsSync(join(ws.root, app.path, 'dist')))
	if (missing.length) {
		throw new CliError(
			`No dist folder for ${missing.map(a => a.name).join(', ')}. Run \`spool build\` first.`,
		)
	}
}

/** Host dists bake remote urls at build time; preview cannot rewire them. */
function warnDeployedUrls(apps: NamedApp[]): void {
	if (!hostsOf(apps).length) return
	const deployed = remotesOf(apps).filter(
		({ app }) => app.url !== undefined || app.urls !== undefined,
	)
	if (!deployed.length) return
	log.warn(
		`${deployed.map(a => a.name).join(', ')} carry a deployed url in spool.json, so hosts built with \`spool build\` load the deployed manifests instead of these local servers. Rebuild with SPOOL_REMOTE_<NAME>=http://localhost:<port>/mf-manifest.json to preview the local artifacts.`,
	)
}

async function waitForRemote(
	{ name, app }: NamedApp,
	timeoutMs: number | undefined,
	signal: AbortSignal,
): Promise<void> {
	const url = `http://localhost:${app.port}/mf-manifest.json`
	try {
		await waitForManifest(url, { ...(timeoutMs === undefined ? {} : { timeoutMs }), signal })
	} catch {
		// A sibling crash aborted the poll; that failure is reported elsewhere.
		if (signal.aborted) return
		log.warn(
			`${name} is not serving its federation manifest on port ${app.port} yet. Hosts may need one reload.`,
		)
	}
}

function spawnApp(
	ws: Workspace,
	{ name, app }: NamedApp,
	color: (s: string) => string,
	output: DevOutput,
	mode: ServeMode,
	extraEnv?: NodeJS.ProcessEnv,
): ChildProcess {
	const dir = join(ws.root, app.path)
	const { command, args } = viteInvocation(dir, mode, ws.root)
	const child = spawnProcess(command, args, {
		cwd: dir,
		...(extraEnv ? { env: { ...process.env, ...extraEnv } } : {}),
	})

	const meta: TrackMeta = {
		role: `${app.type} · ${app.framework}`,
		port: app.port,
		order: app.type === 'host' ? 0 : 1,
	}
	const status = output.track(name, meta, color)
	child.stdout?.on('data', (d: Buffer) => output.chunk(status, d, false))
	child.stderr?.on('data', (d: Buffer) => output.chunk(status, d, true))
	return child
}

/*
 *   BUILD
 ***************************************************************************************************/
function defaultConcurrency(): number {
	return Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)))
}

export interface BuildOptions {
	only?: string[]
	env?: string
	/** Apps built at once within a tier. */
	concurrency?: number
	onResult?: (result: AppRunResult) => void
}

export async function buildAll(ws: Workspace, options: BuildOptions = {}): Promise<void> {
	const { env } = options
	const apps = selectApps(ws, options.only)
	if (env !== undefined) warnUnusedEnv(apps, env)

	const tiers = [remotesOf(apps), hostsOf(apps)].filter(tier => tier.length)

	for (const tier of tiers) await buildTier(ws, tier, options)

	log.success(`built ${apps.length} app(s)`)
	verifySingletons(ws, apps)
}

function verifySingletons(ws: Workspace, apps: NamedApp[]): void {
	const conflicts = checkBuiltSingletons(
		ws,
		apps.map(({ name }) => name),
	)

	if (!conflicts.length) return

	for (const conflict of conflicts) {
		const blocked = conflict.unsatisfied
			.map(entry => `${entry.app} needs ${entry.requiredVersion}`)
			.join(', ')

		log.error(
			`"${conflict.dep}" shipped as ${describeShipped(conflict)}. Federation loads ${conflict.chosen}, which ${blocked}.`,
		)
	}

	throw new CliError(
		`${conflicts.length} shared dep(s) resolved to versions the apps cannot agree on, so they would load more than one copy at runtime. Run \`spool doctor --fix\` to align them, reinstall, and build again.`,
	)
}

interface BuildFailure {
	name: string
	output: string
}

interface BuildFailure {
	name: string
	output: string
}

/** Builds one app. A build that cannot even start is a failure like any other. */
async function buildOne(
	ws: Workspace,
	{ name, app }: NamedApp,
	env: string | undefined,
): Promise<{ result: AppRunResult; output: string; failed: boolean }> {
	log.step(`building ${style.bold(name)} (${app.type})${env ? style.dim(` for ${env}`) : ''}`)

	const started = Date.now()
	const dir = join(ws.root, app.path)
	// SPOOL_ENV picks each remote's `urls` entry inside the ./vite helper.
	const spawnEnv = env === undefined ? {} : { env: { ...process.env, SPOOL_ENV: env } }

	let invocation: Invocation

	try {
		invocation = viteInvocation(dir, 'build', ws.root)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		return {
			result: { name, ok: false, durationMs: Date.now() - started, error: message },
			output: message,
			failed: true,
		}
	}

	const { code, output } = await runCaptured(invocation.command, invocation.args, {
		cwd: dir,
		...spawnEnv,
	})
	const durationMs = Date.now() - started

	if (code === 0) return { result: { name, ok: true, durationMs }, output, failed: false }

	return {
		result: { name, ok: false, durationMs, error: output.trim() || `exit code ${code}` },
		output,
		failed: true,
	}
}

async function buildTier(ws: Workspace, tier: NamedApp[], options: BuildOptions): Promise<void> {
	const { env, onResult } = options
	const queue = [...tier]
	const failures: BuildFailure[] = []

	const worker = async (): Promise<void> => {
		for (let next = queue.shift(); next; next = queue.shift()) {
			const { result, output, failed } = await buildOne(ws, next, env)

			onResult?.(result)

			if (failed) failures.push({ name: result.name, output })
			else if (output.trim()) log.plain(output.trimEnd())
		}
	}

	const workers = Math.max(1, Math.min(options.concurrency ?? defaultConcurrency(), tier.length))
	await Promise.all(Array.from({ length: workers }, worker))

	if (failures.length) throwBuildFailures(ws, failures)
}

function throwBuildFailures(ws: Workspace, failures: BuildFailure[]): never {
	for (const failure of failures) {
		log.error(`${failure.name} failed to build:`)
		if (failure.output.trim()) log.plain(failure.output.trimEnd())
	}

	const names = failures.map(failure => `"${failure.name}"`).join(', ')
	const [firstFailure] = failures
	const reproduce = filterBuildCommand(ws.manifest.packageManager, firstFailure?.name ?? '')

	throw new CliError(
		failures.length === 1
			? `Build failed for ${names}. Run \`${reproduce}\` to reproduce it.`
			: `Builds failed for ${names}. Run \`${reproduce}\` to reproduce the first, and the same with each other name.`,
		'BUILD_FAILED',
	)
}

function warnUnusedEnv(apps: NamedApp[], env: string): void {
	if (!remotesOf(apps).some(({ app }) => app.urls?.[env])) {
		log.warn(
			`No selected remote has a "urls.${env}" entry in spool.json, so every remote falls back to its "url" or localhost.`,
		)
	}
}

/*
 *   DEPLOY
 ***************************************************************************************************/
async function gitHeadSha(cwd: string): Promise<string> {
	const { code, output } = await runCaptured('git', ['rev-parse', 'HEAD'], { cwd })
	if (code !== 0) {
		throw new CliError(
			'Could not read the current git commit (`git rev-parse HEAD` failed). Deploy records need a git repository.',
		)
	}
	return output.trim()
}

async function runAppDeploy(
	ws: Workspace,
	{ name, app, command }: DeployEntry,
	env: string,
	spawnEnv: { env?: NodeJS.ProcessEnv },
): Promise<DeployRecord> {
	const entries = readBuiltSharedEntries(ws.root, app.path)
	const store = readDeployStore(ws)
	const conflicts = sharedConflicts(store, env, name, entries)

	if (conflicts.length) {
		const details = conflicts
			.map(
				c =>
					`"${c.dep}" needs ${c.requiredVersion}, but "${c.otherApp}" last shipped ${c.otherVersion} to "${env}"`,
			)
			.join('; ')
		throw new CliError(
			`${name} would ship a shared dep another app cannot load: ${details}. Align the versions and rebuild before deploying.`,
		)
	}

	await runShell(command, { cwd: join(ws.root, app.path), ...spawnEnv })

	const sha = await gitHeadSha(ws.root)
	return {
		sha,
		url: app.urls?.[env] ?? app.url ?? '',
		at: new Date().toISOString(),
		shared: Object.fromEntries(entries.map(entry => [entry.name, entry.version])),
	}
}

export async function deployAll(
	ws: Workspace,
	only?: string[],
	env?: string,
	onResult?: (result: AppRunResult) => void,
): Promise<void> {
	const apps = selectApps(ws, only)
	const ordered = [...remotesOf(apps), ...hostsOf(apps)]
	const deployable = ordered.flatMap(({ name, app }) =>
		app.deploy ? [{ name, app, command: app.deploy }] : [],
	)

	for (const { name } of ordered.filter(a => !a.app.deploy)) {
		log.warn(`${name} has no "deploy" command in spool.json; skipping it.`)
	}
	if (!deployable.length) {
		throw new CliError(
			'Nothing to deploy. Give each app a "deploy" command in spool.json, e.g. "wrangler pages deploy dist".',
		)
	}

	for (const entry of deployable) await deployOne(ws, entry, env, onResult)

	log.success(`deployed ${deployable.length} app(s)`)
}

interface DeployEntry {
	name: string
	app: AppConfig
	command: string
}

async function deployOne(
	ws: Workspace,
	entry: DeployEntry,
	env: string | undefined,
	onResult: ((result: AppRunResult) => void) | undefined,
): Promise<void> {
	const { name, app, command } = entry
	const dir = join(ws.root, app.path)
	// Deploy commands are the user's own; SPOOL_ENV lets them branch per env.
	const spawnEnv = env === undefined ? {} : { env: { ...process.env, SPOOL_ENV: env } }

	if (!existsSync(join(dir, 'dist'))) {
		log.warn(`${name} has no dist folder. Run \`spool build\` first if its deploy expects one.`)
	}
	log.step(`deploying ${style.bold(name)} (${app.type})${env ? style.dim(` for ${env}`) : ''}`)

	const started = Date.now()

	try {
		if (env === undefined) {
			await runShell(command, { cwd: dir, ...spawnEnv })
		} else {
			recordDeploy(ws, env, name, await runAppDeploy(ws, entry, env, spawnEnv))
		}

		onResult?.({ name, ok: true, durationMs: Date.now() - started })
	} catch (error) {
		onResult?.({
			name,
			ok: false,
			durationMs: Date.now() - started,
			error: error instanceof Error ? error.message : String(error),
		})

		throw error instanceof CliError
			? error
			: new CliError(`Deploy failed for "${name}". Its command: ${command}`, 'DEPLOY_FAILED')
	}

	if (app.type === 'remote' && !app.url) {
		log.warn(
			`${name} has no "url" in spool.json, so host production builds still point at localhost. Set it to the deployed mf-manifest.json.`,
		)
	}
}

function filterBuildCommand(pm: Workspace['manifest']['packageManager'], name: string): string {
	switch (pm) {
		case 'npm':
			return `npm run build -w ${name}`
		case 'yarn':
			return `yarn workspace ${name} build`
		default:
			return `pnpm --filter ${name} build`
	}
}
