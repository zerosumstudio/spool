/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { requireWorkspace, type Workspace } from '../core/workspace.js'
import { ciWorkflows } from '../core/templates/workflows.js'
import { NODE_VERSION } from '../core/versions.js'
import { readPackageJson } from '../core/packages.js'
import { workspaceMembers } from '../core/packages-glob.js'
import { formatFiles } from '../core/format.js'
import { writeFiles } from '../core/fswrite.js'
import { rangeFloor } from '../util/semver.js'
import { log } from '../util/logger.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface CiOptions {
	force?: boolean
}

/*
 *   NODE VERSION
 ***************************************************************************************************/
function resolveNodeVersion(ws: Workspace, engineRange: string | undefined): string {
	if (engineRange) {
		const floor = rangeFloor(engineRange)
		if (floor) return String(floor[0])
	}

	const nvmrc = join(ws.root, '.nvmrc')
	if (existsSync(nvmrc)) {
		const version = readFileSync(nvmrc, 'utf8').trim().replace(/^v/, '')
		if (version) return version
	}

	return NODE_VERSION
}

/*
 *   CI
 ***************************************************************************************************/
export async function ci(opts: CiOptions): Promise<void> {
	const ws = await requireWorkspace()
	const apps = Object.entries(ws.manifest.apps)

	const root = readPackageJson(join(ws.root, 'package.json'))
	const scripts = typeof root === 'string' ? {} : (root.scripts ?? {})
	const engineRange = typeof root === 'string' ? undefined : root.engines?.node

	for (const [name] of apps.filter(([, app]) => !app.deploy)) {
		log.warn(`${name} has no "deploy" command in spool.json; no deploy workflow for it.`)
	}

	if (!apps.some(([, app]) => app.deploy)) {
		log.step('Add a "deploy" command to an app in spool.json to get a deploy workflow for it.')
	}

	const nodeVersion = resolveNodeVersion(ws, engineRange)
	const packageGlobs = workspaceMembers(ws)

	const files = await formatFiles(
		ciWorkflows(ws.manifest, scripts, { nodeVersion, packageGlobs }),
		ws.root,
	)
	const result = await writeFiles(ws.root, files, { force: opts.force ?? false })

	for (const rel of result.written) log.step(`wrote ${rel}`)
	for (const rel of result.skipped) {
		log.warn(`${rel} already exists; rerun with --force to regenerate it.`)
	}

	log.success(`generated ${result.written.length} workflow(s)`)
	if (result.written.length) {
		log.step('Commit them, and add the secrets your deploy commands need to the repository.')
	}
}
