/*
 *   IMPORTS
 ***************************************************************************************************/
import { resolve, basename, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import * as p from '@clack/prompts'
import {
	DEFAULT_FRAMEWORK,
	FRAMEWORKS,
	MANIFEST_FILE,
	PACKAGE_MANAGERS,
	emptyManifest,
	getApp,
	parseFramework,
	validateFramework,
	type AppConfig,
	type Framework as FrameworkType,
	type Manifest,
} from '../core/config.js'
import { workspaceFiles, appFiles, defaultExposes } from '../core/generators.js'
import {
	ADDONS,
	ADDON_NAMES,
	parseAddonList,
	promptAddons,
	templateExtras,
	type AddonName,
} from '../core/addons.js'
import { sharedRuntime } from '../core/versions.js'
import { sentryEnvFiles } from '../core/templates/sentry.js'
import { formatFiles } from '../core/format.js'
import { writeFiles } from '../core/fswrite.js'
import { Provenance } from '../core/provenance.js'
import { installOrHint } from '../core/install.js'
import { CliError, type ErrorCode } from '../util/errors.js'
import { ask, canPrompt, inputRequired } from '../util/interactive.js'
import { federationNotes } from '../core/templates/composition.js'
import { splitList, validateDirArgument, validateName } from '../util/names.js'
import { style } from '../util/style.js'
import { log } from '../util/logger.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface CreateOptions {
	name?: string
	host?: string
	remotes?: string
	pm?: string
	framework?: string
	addons?: string
	install?: boolean
	here?: boolean
}

/** An app to scaffold: its name plus the framework it uses. */
interface AppSpec {
	name: string
	framework: FrameworkType
}

interface CreateInputs {
	name: string
	host: AppSpec
	remotes: AppSpec[]
	packageManager: Manifest['packageManager']
	interactive: boolean
}

/*
 *   CREATE
 ***************************************************************************************************/
export async function create(dir: string | undefined, opts: CreateOptions): Promise<void> {
	checkDirArgument(dir, opts)

	p.intro(style.cyan(style.bold('spool create')))

	const inputs = await resolveInputs(dir, opts)
	const targetDir = opts.here ? process.cwd() : resolve(process.cwd(), dir ?? inputs.name)

	checkTarget(targetDir, opts.here ?? false)

	const manifest = buildManifest(inputs)
	const addons = await resolveAddons(opts, manifest)

	for (const addon of addons) ADDONS[addon].apply?.(manifest)

	const dsn = await resolveSentryDsn(addons, opts)
	const batches = await planScaffold(targetDir, manifest, addons, dsn)

	if (opts.here) ensureNoClashes(targetDir, batches)

	await writeScaffold(targetDir, batches)

	printSummary(inputs, manifest, addons, targetDir)
	await installOrHint(manifest.packageManager, targetDir, opts.install ?? true)

	const cd = opts.here ? '' : `  cd ${dir ?? inputs.name}\n`
	p.outro(`${style.green('Done.')} Next:\n${cd}  spool dev`)
}

function checkDirArgument(dir: string | undefined, opts: CreateOptions): void {
	if (dir === undefined) return

	const dirError = validateDirArgument(dir)
	if (dirError) throw new CliError(dirError, 'INVALID_PATH')

	if (opts.here) {
		throw new CliError(
			'--here scaffolds into the current folder, so it takes no [dir]. Drop one of them.',
			'USAGE',
		)
	}
}

function checkTarget(targetDir: string, here: boolean): void {
	if (existsSync(join(targetDir, MANIFEST_FILE))) {
		throw new CliError(
			`There is already a spool workspace in ${targetDir}. Pick another folder or remove it first.`,
			'TARGET_EXISTS',
		)
	}

	if (!here) ensureEmptyTarget(targetDir)
}

function printSummary(
	inputs: CreateInputs,
	manifest: Manifest,
	addons: AddonName[],
	targetDir: string,
): void {
	log.success(`scaffolded ${style.bold(inputs.name)} in ${style.dim(targetDir)}`)
	log.step(
		`host: ${inputs.host.name} (${inputs.host.framework}) on port ${getApp(manifest, inputs.host.name).port}`,
	)

	for (const remote of inputs.remotes) {
		log.step(
			`remote: ${remote.name} (${remote.framework}) on port ${getApp(manifest, remote.name).port}`,
		)
	}

	for (const addon of addons) {
		for (const note of ADDONS[addon].notes(manifest, true)) log.step(note)
	}

	for (const note of federationNotes(addons.includes('navigation'))) log.step(note)
}

/*
 *   STEPS
 ***************************************************************************************************/
async function askText(options: Parameters<typeof p.text>[0]): Promise<string> {
	return blankToEmpty(await ask(p.text(options)))
}

/** The workspace name: --name, the folder's name, or a prompt. */
async function resolveName(
	dir: string | undefined,
	opts: CreateOptions,
): Promise<{ name: string; prompted: boolean }> {
	if (opts.name !== undefined) return { name: opts.name, prompted: false }

	if (dir) {
		const name = basename(resolve(process.cwd(), dir))
		const error = validateName(name, 'workspace name')

		if (error) {
			throw new CliError(
				`${error} (Derived from the folder name; pass --name to override.)`,
				'INVALID_NAME',
			)
		}

		return { name, prompted: false }
	}

	if (!canPrompt()) inputRequired('workspace name', '--name <name>')

	const name = await askText({
		message: 'Workspace name?',
		placeholder: 'acme-frontend',
		validate: v => validateName(v ?? '', 'workspace name'),
	})

	return { name, prompted: true }
}

async function resolvePackageManager(pm: string | undefined): Promise<Manifest['packageManager']> {
	if (pm !== undefined) return parsePackageManager(pm)

	return ask(
		p.select<Manifest['packageManager']>({
			message: 'Package manager?',
			initialValue: 'pnpm',
			options: PACKAGE_MANAGERS.map(value => ({ value, label: value })),
		}),
	)
}

async function resolveInputs(dir: string | undefined, opts: CreateOptions): Promise<CreateInputs> {
	const { name, prompted } = await resolveName(dir, opts)

	ensureValid(name, 'workspace name')

	const interactive = prompted || opts.host === undefined || opts.remotes === undefined

	if (!canPrompt()) {
		if (opts.host === undefined) inputRequired('host app name', '--host <name>')
		if (opts.remotes === undefined) inputRequired('remote app names', '--remotes <list>')
		if (opts.pm === undefined) inputRequired('package manager', '--pm pnpm|npm|yarn')
	}

	const defaultFramework =
		opts.framework === undefined ? undefined : parseFramework(opts.framework)
	const host = await resolveHost(opts, defaultFramework, interactive)
	const remotes = await resolveRemotes(opts, defaultFramework, interactive, host)
	const names = [host.name, ...remotes.map(r => r.name)]

	if (new Set(names).size !== names.length) {
		throw new CliError(
			'App names must be unique. A remote cannot share the host name.',
			'INVALID_NAME',
		)
	}

	const packageManager = await resolvePackageManager(opts.pm)

	return { name, host, remotes, packageManager, interactive }
}

async function resolveAddons(opts: CreateOptions, manifest: Manifest): Promise<AddonName[]> {
	if (opts.addons !== undefined) return parseAddonList(opts.addons, manifest)

	return promptAddons(
		'Extras to include?',
		ADDON_NAMES.filter(name => !ADDONS[name].unavailable(manifest)),
	)
}

/** Host name and framework, from --host ("name" or "name:framework") or prompts. */
async function resolveHost(
	opts: CreateOptions,
	defaultFramework: FrameworkType | undefined,
	interactive: boolean,
): Promise<AppSpec> {
	const spec = parseSpec(
		opts.host ??
			(await askText({
				message: 'Host (shell) app name?',
				initialValue: 'shell',
				validate: v => validateSpec(v ?? '', 'host name'),
			})),
		'host name',
	)
	const framework = await resolveFramework(spec, defaultFramework, interactive, DEFAULT_FRAMEWORK)

	return { name: spec.name, framework }
}

async function resolveRemotes(
	opts: CreateOptions,
	defaultFramework: FrameworkType | undefined,
	interactive: boolean,
	host: AppSpec,
): Promise<AppSpec[]> {
	const raw =
		opts.remotes ??
		(await askText({
			message: 'Remote app names? (comma separated, add :framework to mix)',
			placeholder: 'dashboard, profile:vue',
			initialValue: 'dashboard',
			validate: v => validateRemoteList(v ?? ''),
		}))

	const remotes: AppSpec[] = []

	for (const entry of splitList(raw)) {
		const spec = parseSpec(entry, 'remote name')
		const framework = await resolveFramework(
			spec,
			defaultFramework,
			interactive,
			host.framework,
		)

		remotes.push({ name: spec.name, framework })
	}

	return remotes
}

async function resolveFramework(
	spec: ParsedSpec,
	defaultFramework: FrameworkType | undefined,
	interactive: boolean,
	fallback: FrameworkType,
): Promise<FrameworkType> {
	if (spec.framework !== undefined) return spec.framework
	if (defaultFramework !== undefined) return defaultFramework
	if (!interactive) return fallback

	return ask(
		p.select({
			message: `Framework for ${spec.name}?`,
			initialValue: fallback,
			options: FRAMEWORKS.map(value => ({ value, label: value })),
		}),
	)
}

interface Batch {
	/** Folder the files are written into. */
	dir: string
	files: Record<string, string>
}

async function planScaffold(
	targetDir: string,
	manifest: Manifest,
	addons: AddonName[],
	sentryDsn: string,
): Promise<Batch[]> {
	const extras = templateExtras(addons)
	const allowBuilds = addons.flatMap(addon => ADDONS[addon].allowBuilds)

	const batches: Batch[] = [
		{ dir: targetDir, files: await formatFiles(workspaceFiles(manifest, allowBuilds)) },
	]

	for (const [name, app] of Object.entries(manifest.apps)) {
		batches.push({
			dir: join(targetDir, app.path),
			files: await formatFiles(appFiles(manifest, name, app, extras, targetDir)),
		})
	}

	for (const addon of addons) {
		batches.push({
			dir: targetDir,
			files: await formatFiles(ADDONS[addon].files(manifest, extras)),
		})
	}

	if (sentryDsn) batches.push({ dir: targetDir, files: sentryEnvFiles(manifest, sentryDsn) })

	return batches
}

async function writeScaffold(targetDir: string, batches: Batch[]): Promise<void> {
	const provenance = Provenance.load(targetDir)

	for (const batch of batches) await writeFiles(batch.dir, batch.files, { provenance })

	await provenance.save()
}

/** A new folder has to be empty or missing, so a scaffold never mixes into someone's files. */
function ensureEmptyTarget(targetDir: string): void {
	if (!existsSync(targetDir)) return

	const entries = readdirSync(targetDir)
	if (!entries.length) return

	throw new CliError(
		`${targetDir} is not empty (${listSome(entries)}). Pick an empty or new folder, or use --here to add to this one.`,
		'TARGET_NOT_EMPTY',
	)
}

/** `--here` may share a folder, but never overwrites: stop and name every file in the way. */
function ensureNoClashes(targetDir: string, batches: Batch[]): void {
	const clashes = batches.flatMap(batch =>
		Object.keys(batch.files)
			.map(rel => join(batch.dir, rel))
			.filter(path => existsSync(path)),
	)
	if (!clashes.length) return

	const names = [...new Set(clashes.map(path => path.slice(targetDir.length + 1)))]

	throw new CliError(
		`--here would overwrite existing files in ${targetDir}: ${listSome(names)}. Move them or pick another folder.`,
		'TARGET_NOT_EMPTY',
	)
}

function listSome(names: string[]): string {
	const shown = names.slice(0, 5).join(', ')

	return names.length > 5 ? `${shown} and ${names.length - 5} more` : shown
}

// One DSN for the whole workspace
async function resolveSentryDsn(addons: AddonName[], opts: CreateOptions): Promise<string> {
	if (!addons.includes('sentry') || opts.addons !== undefined || !canPrompt()) return ''

	return askText({
		message: 'Sentry DSN? (blank to set VITE_SENTRY_DSN later)',
		placeholder: 'https://<key>@<org>.ingest.sentry.io/<project>',
		validate: validateDsn,
	})
}

export function validateDsn(value: string | undefined): string | undefined {
	const trimmed = (value ?? '').trim()
	if (!trimmed) return undefined

	if (!/^https?:\/\/[^@\s]+@[^/\s]+\/.+/.test(trimmed)) {
		return 'That does not look like a Sentry DSN (https://<key>@<host>/<project>). Leave blank to skip.'
	}

	return undefined
}

/*
 *   HELPERS
 ***************************************************************************************************/
function buildManifest({ name, host, remotes, packageManager }: CreateInputs): Manifest {
	const manifest = emptyManifest(name)
	manifest.packageManager = packageManager

	const frameworks = [...new Set([host.framework, ...remotes.map(r => r.framework)])]
	manifest.shared = [...new Set(frameworks.flatMap(framework => sharedRuntime(framework)))]
	let port = 5173

	manifest.apps[host.name] = {
		type: 'host',
		framework: host.framework,
		path: `apps/${host.name}`,
		port: port++,
		remotes: remotes.map(r => r.name),
		exposes: {},
	} satisfies AppConfig

	for (const remote of remotes) {
		manifest.apps[remote.name] = {
			type: 'remote',
			framework: remote.framework,
			path: `apps/${remote.name}`,
			port: port++,
			remotes: [],
			exposes: defaultExposes(remote.framework),
		} satisfies AppConfig
	}

	return manifest
}

function ensureValid(value: string, label: string): void {
	const error = validateName(value, label)
	if (error) throw new CliError(error, 'INVALID_NAME')
}

function parsePackageManager(value: string): Manifest['packageManager'] {
	const match = PACKAGE_MANAGERS.find(manager => manager === value)
	if (match) return match

	throw new CliError(
		`Unknown package manager "${value}". Use pnpm, npm or yarn.`,
		'INVALID_VALUE',
	)
}

interface ParsedSpec {
	name: string
	framework?: FrameworkType
}

function readSpec(
	value: string,
	label: string,
): { spec: ParsedSpec } | { error: string; code: ErrorCode } {
	const parts = value.split(':').map(part => part.trim())
	if (parts.length > 2) {
		return {
			error: `Invalid ${label} "${value}". Use "name" or "name:framework".`,
			code: 'INVALID_NAME',
		}
	}

	const [specName = '', specFramework] = parts
	const nameError = validateName(specName, label)

	if (nameError) return { error: nameError, code: 'INVALID_NAME' }

	if (specFramework === undefined) return { spec: { name: specName } }

	const frameworkError = validateFramework(specFramework)
	if (frameworkError) return { error: frameworkError, code: 'INVALID_VALUE' }

	return { spec: { name: specName, framework: parseFramework(specFramework) } }
}

function parseSpec(raw: string, label: string): ParsedSpec {
	const result = readSpec(raw, label)

	if ('error' in result) throw new CliError(result.error, result.code)
	return result.spec
}

function validateSpec(value: string, label: string): string | undefined {
	const result = readSpec(value, label)
	return 'error' in result ? result.error : undefined
}

function validateRemoteList(value: string): string | undefined {
	for (const remote of splitList(value)) {
		const error = validateSpec(remote, 'remote name')
		if (error) return error
	}

	return undefined
}

/** clack answers a blank text prompt with `undefined`, whatever its types say. */
function blankToEmpty(answer: string): string {
	return ((answer as string | undefined) ?? '').trim()
}
