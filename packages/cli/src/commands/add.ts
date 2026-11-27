/*
 *   IMPORTS
 ***************************************************************************************************/
import { join } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { requireWorkspace, saveManifest, type Workspace } from '../core/workspace.js'
import {
	DEFAULT_FRAMEWORK,
	WORKSPACE_FILE,
	parseFramework,
	type AppConfig,
	type Framework,
	type Manifest,
} from '../core/config.js'
import { appFiles, defaultExposes, hostWiringFiles } from '../core/generators.js'
import { helperFiles } from '../core/templates/helpers.js'
import { TEMPLATES, remoteRefs } from '../core/templates/index.js'
import { sentryFiles } from '../core/templates/sentry.js'
import { shareSentrySdks, templateExtras } from '../core/addons.js'
import { appDependencies, sharedRuntime } from '../core/versions.js'
import { formatFile, formatFiles } from '../core/format.js'
import { writeFiles, OwnedWriter } from '../core/fswrite.js'
import { Provenance } from '../core/provenance.js'
import { installOrHint } from '../core/install.js'
import type { PackageJsonShape } from '../core/packages.js'
import { validateName } from '../util/names.js'
import { CliError } from '../util/errors.js'
import { log } from '../util/logger.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface AddOptions {
	type?: string
	port?: string
	host?: string
	framework?: string
	install?: boolean
}

/*
 *   ADD
 ***************************************************************************************************/
export async function add(name: string, opts: AddOptions): Promise<void> {
	const ws = await requireWorkspace()
	const { manifest } = ws
	const { framework, type } = validateAddInput(manifest, name, opts)

	const app: AppConfig = {
		type,
		framework,
		path: `apps/${name}`,
		port: resolvePort(manifest, opts.port),
		remotes: [],
		exposes: type === 'remote' ? defaultExposes(framework) : {},
	}
	manifest.apps[name] = app
	shareFrameworkRuntime(manifest, framework)
	if (manifest.addons.includes('sentry')) shareSentrySdks(manifest)

	const host = type === 'remote' ? wireIntoHost(manifest, name, opts.host) : undefined

	// Restore the workspace helper if it's missing.
	const provenance = Provenance.load(ws.root)
	const restored = await writeFiles(ws.root, await formatFiles(helperFiles(), ws.root), {
		provenance,
	})
	if (restored.written.length) {
		log.warn(`${WORKSPACE_FILE} was missing and has been restored.`)
	}

	const extras = templateExtras(manifest.addons)
	await writeFiles(
		join(ws.root, app.path),
		await formatFiles(appFiles(manifest, name, app, extras, ws.root), ws.root),
		{ provenance },
	)
	if (extras.sentry) await wireSentry(ws.root, manifest, name, app, provenance)

	if (host) await writeHostWiring(ws, host, provenance)

	await provenance.save()
	await saveManifest(ws)
	log.success(`added ${type} ${name} on port ${app.port}`)

	// The host's own components are never touched, so print how to mount the
	// new remote instead.
	if (host) printMountHint(name, host)

	await installOrHint(manifest.packageManager, ws.root, opts.install !== false)
}

/** Checks the name, type and framework before anything is written. */
function validateAddInput(
	manifest: Manifest,
	name: string,
	opts: AddOptions,
): { framework: Framework; type: AppConfig['type'] } {
	const nameError = validateName(name, 'app name', { shared: manifest.shared })
	if (nameError) throw new CliError(nameError, 'INVALID_NAME')

	if (name in manifest.apps) {
		throw new CliError(
			`"${name}" already exists in this workspace. Pick a different name.`,
			'INVALID_NAME',
		)
	}

	if (opts.type && opts.type !== 'host' && opts.type !== 'remote') {
		throw new CliError(
			`Unknown app type "${opts.type}". Use "host" or "remote".`,
			'INVALID_VALUE',
		)
	}

	const type = opts.type === 'host' ? 'host' : 'remote'

	if (type === 'host' && opts.host) {
		log.warn(`--host only applies when adding a remote; ignoring --host ${opts.host}.`)
	}

	return { framework: parseFramework(opts.framework ?? DEFAULT_FRAMEWORK), type }
}

/** The host's typings, any bridge it now needs, and the runtime deps that bridge brings. */
async function writeHostWiring(
	ws: Workspace,
	host: HostRef,
	provenance: Provenance,
): Promise<void> {
	const { manifest } = ws
	const dir = join(ws.root, host.app.path)
	const writer = new OwnedWriter(ws.root, false, provenance, false)
	const typings = await formatFiles(hostWiringFiles(manifest, host.app, ws.root), ws.root)

	for (const [rel, content] of Object.entries(typings)) {
		await writer.replaceGenerated(dir, rel, content, host.name)
	}

	// A bridge the host now needs is created, but never overwritten in
	// case the user has edited it.
	const bridge = TEMPLATES[host.app.framework].bridgeFiles(remoteRefs(manifest, host.app))
	await writeFiles(dir, await formatFiles(bridge, ws.root), { provenance })

	// A foreign-framework remote makes the host depend on that framework's
	// bridge runtime; add the missing deps without touching existing ones.
	await syncHostDeps(ws.root, manifest, host.app)
}

/*
 *   HELPERS
 ***************************************************************************************************/
interface HostRef {
	name: string
	app: AppConfig
}

function wireIntoHost(manifest: Manifest, remote: string, requested?: string): HostRef | undefined {
	const hostName = requested ?? defaultHost(manifest)
	if (!hostName) return undefined

	const app = manifest.apps[hostName]
	if (!app || app.type !== 'host') {
		throw new CliError(
			`There is no host named "${hostName}" in this workspace.`,
			'APP_NOT_FOUND',
		)
	}
	if (!app.remotes.includes(remote)) app.remotes.push(remote)
	log.step(`wired ${remote} into host ${hostName}`)
	return { name: hostName, app }
}

async function wireSentry(
	root: string,
	manifest: Manifest,
	name: string,
	app: AppConfig,
	provenance: Provenance,
): Promise<void> {
	const prefix = `${app.path}/`
	const files = Object.fromEntries(
		Object.entries(sentryFiles(manifest)).filter(([rel]) => rel.startsWith(prefix)),
	)
	if (!Object.keys(files).length) return

	await writeFiles(root, await formatFiles(files, root), { provenance })
	log.step(`${name}: wired sentry; set VITE_SENTRY_DSN before it reports`)
}

async function syncHostDeps(root: string, manifest: Manifest, host: AppConfig): Promise<void> {
	const expected = appDependencies(manifest, host)
	const target = join(root, host.path, 'package.json')
	let pkg: PackageJsonShape
	try {
		pkg = JSON.parse(await readFile(target, 'utf8')) as PackageJsonShape
	} catch {
		return
	}
	pkg.dependencies ??= {}
	pkg.devDependencies ??= {}
	let changed = false
	for (const [section, deps] of [
		['dependencies', expected.dependencies],
		['devDependencies', expected.devDependencies],
	] as const) {
		const home = (pkg[section] ??= {})

		for (const [dep, range] of Object.entries(deps)) {
			if (home[dep] === undefined) {
				home[dep] = range
				changed = true
			}
		}
	}
	if (!changed) return
	await writeFile(
		target,
		await formatFile('package.json', `${JSON.stringify(pkg)}\n`, root),
		'utf8',
	)
}

function resolvePort(manifest: Manifest, requested?: string): number {
	if (requested === undefined) return nextFreePort(manifest)

	const port = Number(requested)
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new CliError(
			`Invalid port "${requested}". Use an integer between 1 and 65535.`,
			'INVALID_VALUE',
		)
	}
	const owner = Object.entries(manifest.apps).find(([, app]) => app.port === port)?.[0]
	if (owner)
		throw new CliError(
			`Port ${port} is already used by "${owner}". Pick another with --port.`,
			'INVALID_VALUE',
		)
	return port
}

function nextFreePort(manifest: Manifest): number {
	const used = new Set(Object.values(manifest.apps).map(app => app.port))
	let port = 5173
	while (used.has(port)) port++
	return port
}

/** Federation shares a framework runtime only when it is in `shared`. */
function shareFrameworkRuntime(manifest: Manifest, framework: Framework): void {
	const missing = sharedRuntime(framework).filter(dep => !manifest.shared.includes(dep))
	if (!missing.length) return
	manifest.shared.push(...missing)
	log.step(`shared ${missing.join(', ')} so every ${framework} app gets one copy`)
}

function printMountHint(name: string, host: HostRef): void {
	log.step(`To show it, render <Remote name="${name}" /> from "@/federation" in ${host.name}.`)
}

function defaultHost(manifest: Manifest): string | undefined {
	return Object.entries(manifest.apps).find(([, app]) => app.type === 'host')?.[0]
}
