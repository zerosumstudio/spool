/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { requireWorkspace, saveManifest, type Workspace } from '../core/workspace.js'
import { MANIFEST_FILE } from '../core/config.js'
import {
	diagnose,
	diagnosePorts,
	diagnoseRemotes,
	type DepWrite,
	type Diagnostic,
} from '../core/doctor.js'
import { dependencyHome, editJsonFile } from '../core/packages.js'
import { ROOT_LABEL } from '../core/ranges.js'
import { CliError } from '../util/errors.js'
import { log } from '../util/logger.js'
import { style } from '../util/style.js'

/*
 *   DOCTOR
 ***************************************************************************************************/
export interface DoctorOptions {
	remote?: boolean
	env?: string
	fix?: boolean
	dryRun?: boolean
	json?: boolean
}

export interface DoctorResult {
	problems: Diagnostic[]
}

export async function doctor(opts: DoctorOptions = {}): Promise<DoctorResult> {
	const ws = await requireWorkspace()
	const issues = await collectIssues(ws, opts)
	const errors = issues.filter(i => i.level === 'error').length

	if (!opts.json) report(ws, issues, errors, opts.fix ?? false)

	if (errors) {
		throw new CliError(
			`${errors} error(s) found. Fix the errors above, or run \`spool doctor --fix\`.`,
			'CHECK_FAILED',
			{ problems: issues },
		)
	}

	return { problems: issues }
}

/** Every problem: static checks (after any fixes), ports, and the deployed remotes when asked. */
async function collectIssues(ws: Workspace, opts: DoctorOptions): Promise<Diagnostic[]> {
	let issues = diagnose(ws)

	if (opts.fix && issues.some(issue => issue.fix)) {
		const applied = await applyFixes(ws, issues, {
			dryRun: opts.dryRun ?? false,
			quiet: opts.json ?? false,
		})

		if (applied && !opts.dryRun) issues = diagnose(ws)
	}

	issues.push(...(await diagnosePorts(ws)))

	if (opts.remote) {
		// Builds read SPOOL_ENV when --env is absent, so doctor probes the same urls.
		const env = (opts.env ?? process.env.SPOOL_ENV) || undefined

		issues.push(...(await diagnoseRemotes(ws, env)))
	}

	return issues
}

function report(ws: Workspace, issues: Diagnostic[], errors: number, fixed: boolean): void {
	if (!issues.length) {
		log.success(`${style.bold(ws.manifest.name)}: no problems found`)
		return
	}

	for (const d of issues) {
		const where = d.app ? style.dim(`(${d.app}) `) : ''

		if (d.level === 'error') log.error(`${where}${d.message}`)
		else log.warn(`${where}${d.message}`)
	}

	log.plain('')
	log.info(`${errors} error(s), ${issues.length - errors} warning(s)`)

	const fixable = issues.filter(i => i.fix).length
	if (fixable && !fixed) {
		log.step(`${fixable} of these can be fixed automatically: rerun with --fix.`)
	}
}

/*
 *   FIXES
 ***************************************************************************************************/
interface FixOptions {
	dryRun: boolean
	quiet: boolean
}

/** What the fixable issues ask for: shared entries to add, and dependency writes per app. */
function groupFixes(issues: Diagnostic[]): { shares: Set<string>; byApp: Map<string, DepWrite[]> } {
	const shares = new Set<string>()
	const byApp = new Map<string, DepWrite[]>()

	for (const { fix } of issues) {
		if (!fix) continue

		if (fix.kind === 'share') {
			shares.add(fix.dep)
			continue
		}

		for (const write of fix.writes) {
			byApp.set(write.app, [...(byApp.get(write.app) ?? []), write])
		}
	}

	return { shares, byApp }
}

async function applyShareFixes(
	ws: Workspace,
	shares: Set<string>,
	{ dryRun, quiet }: FixOptions,
): Promise<number> {
	const added = [...shares].filter(dep => !ws.manifest.shared.includes(dep))
	if (!added.length) return 0

	ws.manifest.shared = [...ws.manifest.shared, ...added]
	if (!quiet) {
		log.step(
			`${dryRun ? 'would update' : 'updated'} ${MANIFEST_FILE} (shared += ${added.join(', ')})`,
		)
	}

	if (!dryRun) await saveManifest(ws)

	return added.length
}

async function applyRangeFixes(
	ws: Workspace,
	byApp: Map<string, DepWrite[]>,
	{ dryRun, quiet }: FixOptions,
): Promise<number> {
	let applied = 0

	for (const [name, writes] of byApp) {
		const dir = packageDir(ws, name)
		if (dir === undefined) continue

		const changes = await editJsonFile(
			join(dir, 'package.json'),
			pkg => {
				const done: string[] = []

				for (const { dep, range } of writes) {
					const home = dependencyHome(pkg, dep, 'dependencies')
					if (home[dep] === range) continue

					done.push(`${dep} ${home[dep] ?? 'added'} -> ${range}`)
					home[dep] = range
				}

				return done
			},
			{ write: !dryRun, root: ws.root },
		)

		if (!changes.length) continue

		if (!quiet) {
			log.step(
				`${name}: ${dryRun ? 'would update' : 'updated'} package.json (${changes.join(', ')})`,
			)
		}
		applied += changes.length
	}

	return applied
}

async function applyFixes(
	ws: Workspace,
	issues: Diagnostic[],
	options: FixOptions,
): Promise<number> {
	const { shares, byApp } = groupFixes(issues)
	const applied =
		(await applyShareFixes(ws, shares, options)) + (await applyRangeFixes(ws, byApp, options))

	if (!applied || options.quiet) return applied

	log.step(
		options.dryRun
			? `${applied} change(s) pending. Rerun without --dry-run to apply.`
			: `Review the changes with git, then run \`${ws.manifest.packageManager} install\`.`,
	)

	return applied
}

function packageDir(ws: Workspace, name: string): string | undefined {
	if (name === ROOT_LABEL) return ws.root

	const app = ws.manifest.apps[name]
	if (app) return join(ws.root, app.path)

	const candidate = join(ws.root, name)
	return existsSync(candidate) ? candidate : undefined
}
