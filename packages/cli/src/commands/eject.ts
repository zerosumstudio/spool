/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { requireWorkspace } from '../core/workspace.js'
import { editJsonFile } from '../core/packages.js'
import { MANIFEST_FILE, WORKSPACE_FILE, type Manifest } from '../core/config.js'
import {
	EJECTED_HELPER_FILES,
	VITE_ENTRY,
	ejectedImport,
	readBundledHelper,
} from '../core/ejected-helper.js'
import { PROVENANCE_FILE } from '../core/provenance.js'
import { confirmDestructive } from '../util/interactive.js'
import { assertConfined } from '../util/confine.js'
import { withoutKey } from '../util/json.js'
import { log } from '../util/logger.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface EjectOptions {
	yes?: boolean
}

const SPOOL_DEP = '@zerosumstudio/spool'
/** Scripts spool.json's own scaffold writes; only these get touched. */
const REPLACED_SCRIPTS = ['dev', 'build'] as const
const REMOVED_SCRIPTS = ['preview', 'doctor'] as const

/*
 *   EJECT
 ***************************************************************************************************/
export async function eject(opts: EjectOptions): Promise<void> {
	const ws = await requireWorkspace()

	if (!(await confirm(opts.yes ?? false))) {
		log.step('Cancelled; nothing was changed.')
		return
	}

	// Read first: an unreadable helper must fail before anything is changed.
	const helper = readBundledHelper()
	const native = nativeScripts(ws.manifest.packageManager)
	const changes = await editJsonFile(
		join(ws.root, 'package.json'),
		pkg => {
			const done: string[] = []

			if (pkg.devDependencies && SPOOL_DEP in pkg.devDependencies) {
				pkg.devDependencies = withoutKey(pkg.devDependencies, SPOOL_DEP)
				done.push(`removed devDependencies["${SPOOL_DEP}"]`)
			}

			pkg.scripts ??= {}
			for (const script of REPLACED_SCRIPTS) {
				if (!isSpoolScript(pkg.scripts[script])) continue
				pkg.scripts[script] = native[script]
				done.push(`scripts.${script} -> ${native[script]}`)
			}
			for (const script of REMOVED_SCRIPTS) {
				if (!isSpoolScript(pkg.scripts[script])) continue
				pkg.scripts = withoutKey(pkg.scripts, script)
				done.push(`removed scripts.${script}`)
			}

			return done
		},
		{ root: ws.root },
	)

	for (const [file, content] of Object.entries(helper.files)) {
		assertConfined(ws.root, join(ws.root, file))
		await writeFile(join(ws.root, file), content, 'utf8')
	}
	changes.push(
		`wrote ${EJECTED_HELPER_FILES.join(' and ')}, the vite helper that was ${VITE_ENTRY}`,
	)
	changes.push(...(await pointConfigsAtHelper(ws.root, ws.manifest.apps)))

	assertConfined(ws.root, join(ws.root, '.spool'), { allowFinalLink: true })
	await rm(join(ws.root, '.spool'), { recursive: true, force: true })
	changes.push(`deleted .spool/ (including ${PROVENANCE_FILE})`)

	log.success('spool removed from this workspace')
	for (const change of changes) log.step(change)

	log.step(
		'`spool dev`/`spool build` ran remotes before hosts; the native scripts run every app in whatever order the package manager picks, so wire that ordering yourself (a filtered run per role, or a task runner like turbo/nx) if it matters to your build.',
	)
	log.step(
		`kept, and still yours to use: ${MANIFEST_FILE} (the wiring you are migrating off of), ${EJECTED_HELPER_FILES[0]} (read by every app's vite config, now yours) and ${WORKSPACE_FILE}, and every generated file (vite.config.ts, package.json, ...) — eject only removes spool's own dependency, scripts and bookkeeping.`,
	)
}

/*
 *   HELPERS
 ***************************************************************************************************/
/** Apps import the helper from the workspace root once spool is not installed to provide it. */
async function pointConfigsAtHelper(root: string, apps: Manifest['apps']): Promise<string[]> {
	const changes: string[] = []

	for (const app of Object.values(apps)) {
		const target = join(root, app.path, 'vite.config.ts')
		if (!existsSync(target)) continue

		const source = await readFile(target, 'utf8')
		if (!source.includes(VITE_ENTRY)) continue

		assertConfined(root, target)
		await writeFile(target, source.replaceAll(VITE_ENTRY, ejectedImport(app.path)), 'utf8')
		changes.push(`${app.path}/vite.config.ts now imports ${ejectedImport(app.path)}`)
	}

	return changes
}

function confirm(yes: boolean): Promise<boolean> {
	return confirmDestructive(
		'Remove spool from this workspace? Generated files stay; only its dependency and scripts go.',
		yes,
	)
}

function isSpoolScript(value: string | undefined): boolean {
	return value !== undefined && value.startsWith('spool ')
}

function nativeScripts(pm: Manifest['packageManager']): Record<'dev' | 'build', string> {
	if (pm === 'pnpm') {
		return { dev: 'pnpm -r --parallel --if-present dev', build: 'pnpm -r --if-present build' }
	}
	if (pm === 'yarn') {
		return {
			dev: 'yarn workspaces foreach --all --parallel --interlaced run dev',
			build: 'yarn workspaces foreach --all run build',
		}
	}
	return {
		dev: 'npm run dev --workspaces --if-present',
		build: 'npm run build --workspaces --if-present',
	}
}
