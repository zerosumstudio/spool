/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { findWorkspaceRoot, requireWorkspaceRoot } from '../core/manifest-file.js'
import type { Workspace } from '../core/workspace.js'
import {
	HELPER_FILE,
	MANIFEST_FILE,
	WORKSPACE_FILE,
	dropSharedSvelte,
	type AppConfig,
	type Manifest,
	getApp,
	migrateManifest,
	parseManifest,
} from '../core/config.js'
import { appDependencies, NODE_RANGE, PNPM_VERSION, rootDevDependencies } from '../core/versions.js'
import {
	prettierrc,
	viteConfig,
	hostWiringFiles,
	workspaceScripts,
	workspaceFiles,
} from '../core/generators.js'
import { dependencyHome, editJsonFile, type PackageJsonShape } from '../core/packages.js'
import { Provenance } from '../core/provenance.js'
import { resolveRanges, type RangeInfo } from '../core/ranges.js'
import { helperFiles } from '../core/templates/helpers.js'
import { sentryFiles } from '../core/templates/sentry.js'
import { navigationFiles } from '../core/templates/composition.js'
import { OwnedWriter } from '../core/fswrite.js'
import { replaceContents } from '../util/json.js'
import { formatFile, formatFiles } from '../core/format.js'
import { CliError } from '../util/errors.js'
import { assertConfined } from '../util/confine.js'
import { log } from '../util/logger.js'
import { isLocalOverride, isUpgrade } from '../util/semver.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface UpgradeOptions {
	dryRun?: boolean
	/** Write this CLI's dependency ranges even when the workspace is ahead of them. */
	downgrade?: boolean
	/** true forces every file; a list of paths forces only those. */
	force?: boolean | string[]
}

interface UpgradeContext {
	ws: Workspace
	writer: ChangeWriter
	/** Use spool's own ranges verbatim instead of what the workspace asks for. */
	downgrade: boolean
	ranges: Map<string, RangeInfo>
}

const shouldSet = (from: string | undefined, to: string, downgrade: boolean): boolean =>
	isLocalOverride(from) ? false : downgrade ? from !== to : isUpgrade(from, to)

const PLAIN_PNPM = /^pnpm@(\d+\.\d+\.\d+)$/

const targetRange = (context: UpgradeContext, dep: string, ours: string): string =>
	context.downgrade ? ours : (context.ranges.get(dep)?.target ?? ours)

/*
 *   GITIGNORE
 ***************************************************************************************************/
const IGNORED_BY_SPOOL = ['.spool/types/', '.spool/*.pid']

async function ensureGitignore(root: string, dryRun: boolean): Promise<boolean> {
	const target = join(root, '.gitignore')
	if (!existsSync(target)) return false

	const current = await readFile(target, 'utf8')
	const present = new Set(current.split(/\r?\n/).map(line => line.trim()))
	const missing = IGNORED_BY_SPOOL.filter(line => !present.has(line))
	if (!missing.length) return false

	log.step(`workspace: ${dryRun ? 'would add' : 'added'} ${missing.join(', ')} to .gitignore`)
	if (!dryRun) {
		assertConfined(root, target)
		const separator = current === '' || current.endsWith('\n') ? '' : '\n'
		await writeFile(target, `${current}${separator}${missing.join('\n')}\n`, 'utf8')
	}
	return true
}

/*
 *   UPGRADE
 ***************************************************************************************************/
/** `spool upgrade --force <files...>`: paths only make sense with --force, and limit it. */
export async function upgradeWithArgs(
	args: string[],
	{ force, ...rest }: Omit<UpgradeOptions, 'force'> & { force?: boolean | string },
): Promise<void> {
	if (args.length && !force) {
		throw new CliError('Files only go with --force: spool upgrade --force <files...>', 'USAGE')
	}

	await upgrade({ ...rest, ...(force ? { force: args.length ? args : true } : {}) })
}

export async function upgrade(opts: UpgradeOptions): Promise<void> {
	const dryRun = opts.dryRun ?? false
	const { context, provenance } = await openUpgrade(opts)
	const { ws, writer } = context

	await upgradeRoot(context)
	if (await ensureGitignore(ws.root, dryRun)) writer.changed++

	for (const [name, app] of Object.entries(ws.manifest.apps)) await upgradeApp(context, name, app)

	if (!dryRun) {
		provenance?.pruneMissing(ws.root)
		await provenance?.save()
	}
	noteNewCapabilities(writer)
	writer.summarize(ws)
}

/** Loads and migrates the manifest, and sets up the writer every step shares. */
async function openUpgrade(
	opts: UpgradeOptions,
): Promise<{ context: UpgradeContext; provenance: Provenance | null }> {
	const root = findWorkspaceRoot()
	const provenance = root === null ? null : Provenance.load(root)
	const writer = new ChangeWriter(
		root ?? process.cwd(),
		opts.dryRun ?? false,
		provenance,
		opts.force ?? false,
	)
	const ws = await loadForUpgrade(writer, provenance)

	return {
		context: { ws, writer, downgrade: opts.downgrade ?? false, ranges: resolveRanges(ws) },
		provenance,
	}
}

async function upgradeApp(context: UpgradeContext, name: string, app: AppConfig): Promise<void> {
	const { ws, writer } = context
	const dir = join(ws.root, app.path)

	if (!existsSync(dir)) {
		log.warn(`${name}: folder "${app.path}" is missing, skipping. Run \`spool doctor\`.`)
		return
	}

	const sentry = ws.manifest.addons.includes('sentry')
	const source = await formatFile('vite.config.ts', viteConfig(name, app, sentry), ws.root)

	await writer.replaceGenerated(dir, 'vite.config.ts', source, name)
	await writer.remove(dir, 'public/_headers', name)

	const envExample = (sentry ? sentryFiles(ws.manifest) : {})[`${app.path}/.env.example`]
	if (envExample !== undefined) await writer.add(dir, '.env.example', envExample, name)

	const typings = await formatFiles(hostWiringFiles(ws.manifest, app, ws.root), ws.root)

	for (const [rel, content] of Object.entries(typings)) {
		await writer.replaceGenerated(dir, rel, content, name)
	}

	if (ws.manifest.addons.includes('navigation')) {
		const files = await formatFiles(navigationFiles(app), ws.root)

		for (const [rel, content] of Object.entries(files)) {
			await writer.replaceGenerated(dir, rel, content, name)
		}
	}

	await upgradeAppPackage(context, name, dir)
}

/** Where the pre-1.0 shell files moved to, so their provenance follows them. */
const SHELL_RENAMES: [from: string, to: string][] = [
	['src/shell/remote.tsx', 'src/federation/remote.tsx'],
	['src/shell/Remote.svelte', 'src/federation/Remote.svelte'],
	['src/shell/Remote.vue', 'src/federation/Remote.vue'],
	['src/shell/remotes.ts', 'src/federation/remotes.ts'],
	['src/shell/index.ts', 'src/federation/index.ts'],
	['src/shell/history.ts', 'src/navigation/history.ts'],
]

function renameShellFiles(
	root: string,
	manifest: Record<string, unknown>,
	provenance: Provenance | null,
): void {
	for (const app of Object.values(manifest.apps as Record<string, { path?: unknown }>)) {
		if (typeof app.path !== 'string') continue

		const dir = join(root, app.path)

		for (const [from, to] of SHELL_RENAMES) provenance?.rename(dir, from, to)
	}
}

async function loadForUpgrade(
	writer: ChangeWriter,
	provenance: Provenance | null,
): Promise<Workspace> {
	const root = requireWorkspaceRoot()

	let raw: unknown
	await writer.editJson(root, MANIFEST_FILE, 'workspace', manifest => {
		const hadShell = Array.isArray(manifest.addons) && manifest.addons.includes('shell')
		const { manifest: migrated, changes } = migrateManifest(manifest)
		const droppedSvelte = dropSharedSvelte(migrated)

		if (droppedSvelte && !changes.includes(droppedSvelte)) changes.push(droppedSvelte)

		if (changes.length) replaceContents(manifest, migrated)
		raw = manifest

		if (hadShell) renameShellFiles(root, manifest, provenance)

		return changes
	})

	return { root, manifestPath: join(root, MANIFEST_FILE), manifest: parseManifest(raw), raw }
}

async function upgradeRoot(context: UpgradeContext): Promise<void> {
	const { ws, writer, downgrade } = context
	const helper = await formatFiles(helperFiles(), ws.root)

	for (const [rel, content] of Object.entries(helper)) {
		await writer.replaceGenerated(ws.root, rel, content, 'workspace')
	}
	await writer.remove(ws.root, HELPER_FILE, 'workspace')
	await writer.replaceGenerated(ws.root, '.prettierrc', prettierrc(ws.manifest), 'workspace')

	const rootFiles = workspaceFiles(ws.manifest)
	const rootConfigs = await formatFiles(
		Object.fromEntries(
			['tsconfig.json', '.prettierignore', '.gitattributes'].flatMap(rel => {
				const content = rootFiles[rel]

				return content === undefined ? [] : [[rel, content]]
			}),
		),
		ws.root,
	)

	for (const [rel, content] of Object.entries(rootConfigs)) {
		await writer.add(ws.root, rel, content, 'workspace')
	}

	await writer.editJson(ws.root, 'package.json', 'workspace', pkg => {
		const changes: string[] = []
		syncEngines(pkg, downgrade, changes)

		addMissingScripts(pkg, ws.manifest, changes)
		syncPackageManager(pkg, ws.manifest, downgrade, changes)

		pkg.devDependencies ??= {}
		const expected = rootDevDependencies(ws.manifest)
		for (const [dep, ours] of Object.entries(expected)) {
			syncRange(context, pkg.devDependencies, [dep, targetRange(context, dep, ours)], changes)
		}

		return changes
	})
}

function addMissingScripts(pkg: PackageJsonShape, manifest: Manifest, changes: string[]): void {
	pkg.scripts ??= {}

	for (const [script, command] of Object.entries(workspaceScripts(manifest))) {
		if (pkg.scripts[script] !== undefined) continue

		pkg.scripts[script] = command
		changes.push(`scripts.${script} added`)
	}
}

/** Moves a plain pnpm pin forward; a pin with a hash or a custom manager is the user's. */
function syncPackageManager(
	pkg: PackageJsonShape,
	manifest: Manifest,
	downgrade: boolean,
	changes: string[],
): void {
	const pinned = pkg.packageManager
	const movable = pinned === undefined || PLAIN_PNPM.test(pinned)

	if (manifest.packageManager !== 'pnpm' || !movable) return
	if (!shouldSet(PLAIN_PNPM.exec(pinned ?? '')?.[1], PNPM_VERSION, downgrade)) return

	pkg.packageManager = `pnpm@${PNPM_VERSION}`
	changes.push(`packageManager -> pnpm@${PNPM_VERSION}`)
}

/** Moves one dependency to the range spool wants, or notes that it was left alone. */
function syncRange(
	context: UpgradeContext,
	home: Record<string, string>,
	[dep, range]: [string, string],
	changes: string[],
): void {
	const current = home[dep]

	if (shouldSet(current, range, context.downgrade)) {
		changes.push(`${dep} ${current ?? 'added'} -> ${range}`)
		home[dep] = range
	} else if (current !== range && !isLocalOverride(current)) {
		context.writer.noteKept()
	}
}

function syncEngines(pkg: PackageJsonShape, downgrade: boolean, changes: string[]): void {
	if (!shouldSet(pkg.engines?.node, NODE_RANGE, downgrade)) return

	pkg.engines = { ...pkg.engines, node: NODE_RANGE }
	changes.push(`engines.node -> ${NODE_RANGE}`)
}

async function upgradeAppPackage(
	context: UpgradeContext,
	name: string,
	dir: string,
): Promise<void> {
	const { ws, writer, downgrade } = context
	const app = getApp(ws.manifest, name)
	const expected = appDependencies(ws.manifest, app)

	await writer.editJson(dir, 'package.json', name, pkg => {
		const changes: string[] = []
		pkg.dependencies ??= {}
		pkg.devDependencies ??= {}

		for (const [section, expectedDeps] of [
			['dependencies', expected.dependencies],
			['devDependencies', expected.devDependencies],
		] as const) {
			for (const [dep, ours] of Object.entries(expectedDeps)) {
				const home = dependencyHome(pkg, dep, section)

				syncRange(context, home, [dep, targetRange(context, dep, ours)], changes)
			}
		}

		syncEngines(pkg, downgrade, changes)

		return changes
	})
}

function noteNewCapabilities(writer: ChangeWriter): void {
	if (!writer.added.has(WORKSPACE_FILE)) return

	log.step(
		`${WORKSPACE_FILE} is new: import { apps, hosts, remotes, srcDirs } from it for anything that has to cover every app.`,
	)
}

/*
 *   CHANGE WRITER
 ***************************************************************************************************/
class ChangeWriter extends OwnedWriter {
	private kept = 0

	async editJson(
		dir: string,
		rel: string,
		label: string,
		edit: (pkg: PackageJsonShape) => string[],
	): Promise<void> {
		const changes = await editJsonFile(join(dir, rel), edit, {
			write: !this.dryRun,
			root: this.root,
		})
		if (!changes.length) return

		this.changed++
		log.step(`${label}: ${this.verb} ${rel} (${changes.join(', ')})`)
	}

	noteKept(): void {
		this.kept++
	}

	summarize(ws: Workspace): void {
		if (this.skippedCount) {
			log.step(
				`left ${this.skippedCount} file(s) alone. Rerun with --force to overwrite them.`,
			)
		}

		if (this.kept) {
			log.step(
				`left ${this.kept} dependency range(s) alone; spool cannot compare them to what it would write. Rerun with --downgrade to overwrite them.`,
			)
		}

		if (!this.changed) {
			log.success('already up to date')
			return
		}

		if (this.dryRun) {
			log.success(`${this.changed} change(s) pending. Rerun without --dry-run to apply.`)
			return
		}

		log.success(`upgraded ${this.changed} file(s)`)
		log.step(
			`Review the changes with git, run \`${ws.manifest.packageManager} install\`, then \`spool doctor\`.`,
		)
	}
}
