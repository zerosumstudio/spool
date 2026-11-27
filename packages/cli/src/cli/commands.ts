/*
 *   IMPORTS
 ***************************************************************************************************/
import { add } from '../commands/add.js'
import { addon } from '../commands/addon.js'
import { build } from '../commands/build.js'
import { ci } from '../commands/ci.js'
import { create } from '../commands/create.js'
import { deploy } from '../commands/deploy.js'
import { dev } from '../commands/dev.js'
import { doctor } from '../commands/doctor.js'
import { eject } from '../commands/eject.js'
import { graph } from '../commands/graph.js'
import { preview } from '../commands/preview.js'
import { remove } from '../commands/remove.js'
import { types } from '../commands/types.js'
import { upgradeWithArgs } from '../commands/upgrade.js'
import { ADDON_NAME_VALUES } from '../core/config.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface OptionSpec {
	type: 'boolean' | 'string'
	/** One letter, used as `-x`. */
	short?: string
	/** The value's placeholder in help, like `<list>`. */
	value?: string
	/** Help text only: `--no-<name>` parses for every boolean option. */
	negatable?: boolean
	description: string
}

/** Options as parsed: camelCase keys, only the ones the user passed. */
export type OptionValues = Record<string, string | boolean | undefined>

export interface CommandSpec {
	name: string
	/** Positional arguments as shown in usage, like `<name>` or `[dir]`. */
	args: string
	summary: string
	minArgs: number
	maxArgs: number
	options: Record<string, OptionSpec>
	/** Takes `--json`: the run prints one document and never prompts. */
	json: boolean
	/** Whatever it returns is merged into the `--json` document. */
	run: (args: string[], values: OptionValues) => Promise<object | void>
}

const ADDON_LIST = ADDON_NAME_VALUES.join(' | ')

const only: OptionSpec = {
	type: 'string',
	value: '<list>',
	description: 'comma-separated subset of apps',
}
const install: OptionSpec = {
	type: 'boolean',
	negatable: true,
	description: 'skip dependency install with --no-install',
}
const jsonFlag: OptionSpec = {
	type: 'boolean',
	description: 'print one JSON document to stdout; logs go to stderr',
}
const yes: OptionSpec = { type: 'boolean', description: 'confirm without asking' }

/*
 *   COMMANDS
 ***************************************************************************************************/
export const COMMANDS: CommandSpec[] = [
	{
		name: 'create',
		args: '[dir]',
		summary: 'Scaffold a new micro-frontend workspace',
		minArgs: 0,
		maxArgs: 1,
		json: false,
		options: {
			name: { type: 'string', short: 'n', value: '<name>', description: 'workspace name' },
			host: {
				type: 'string',
				value: '<name>',
				description: 'host (shell) app name, optionally name:framework',
			},
			remotes: {
				type: 'string',
				value: '<list>',
				description: 'comma-separated remote app names, each optionally name:framework',
			},
			pm: {
				type: 'string',
				value: '<manager>',
				description: 'package manager: pnpm | npm | yarn',
			},
			framework: {
				type: 'string',
				value: '<framework>',
				description: 'default framework: react | svelte | vue',
			},
			addons: {
				type: 'string',
				value: '<list>',
				description: `comma-separated extras: ${ADDON_LIST}, or "none"`,
			},
			here: { type: 'boolean', description: 'scaffold into the current directory' },
			install,
		},
		run: (args, values) => create(args[0], values),
	},
	{
		name: 'add',
		args: '<name>',
		summary: 'Add a host or remote app to the workspace',
		minArgs: 1,
		maxArgs: 1,
		json: false,
		options: {
			type: {
				type: 'string',
				short: 't',
				value: '<type>',
				description: 'host | remote (default remote)',
			},
			port: { type: 'string', short: 'p', value: '<port>', description: 'dev server port' },
			host: {
				type: 'string',
				value: '<name>',
				description: 'host app to wire this remote into',
			},
			framework: {
				type: 'string',
				value: '<framework>',
				description: 'react | svelte | vue (default react)',
			},
			install,
		},
		run: (args, values) => add(args[0] ?? '', values),
	},
	{
		name: 'addon',
		args: '[addons...]',
		summary: `Add extras to an existing workspace: ${ADDON_LIST}`,
		minArgs: 0,
		maxArgs: Infinity,
		json: false,
		options: {
			only: { ...only, description: 'comma-separated apps to write per-app files into' },
			install,
		},
		run: (args, values) => addon(args, values),
	},
	{
		name: 'remove',
		args: '<name>',
		summary: 'Remove an app from the workspace and unwire it from every consumer',
		minArgs: 1,
		maxArgs: 1,
		json: false,
		options: {
			files: { type: 'boolean', description: 'also delete the app folder' },
			yes: {
				...yes,
				description: 'with --files, delete without asking (required without a terminal)',
			},
		},
		run: (args, values) => remove(args[0] ?? '', values),
	},
	{
		name: 'dev',
		args: '',
		summary: 'Run host + remotes together (remotes first)',
		minArgs: 0,
		maxArgs: 0,
		json: false,
		options: {
			only,
			rest: {
				type: 'string',
				value: 'built|env:<name>',
				description:
					'for remotes the selection needs but excludes: "built" previews their dist, "env:<name>" uses their deployed url',
			},
			timeout: {
				type: 'string',
				value: '<seconds>',
				description: 'seconds to wait for each remote before giving up (default 20)',
			},
			ladle: {
				type: 'boolean',
				negatable: true,
				description: 'skip the component workshop with --no-ladle',
			},
			kill: {
				type: 'boolean',
				description: 'stop a previous dev run and free the manifest ports, then exit',
			},
		},
		run: (_args, values) => dev(values),
	},
	{
		name: 'build',
		args: '',
		summary: 'Build every app for production (remotes before hosts)',
		minArgs: 0,
		maxArgs: 0,
		json: true,
		options: {
			only,
			env: {
				type: 'string',
				value: '<name>',
				description: "select each remote's urls.<name> for this build",
			},
			concurrency: {
				type: 'string',
				value: '<n>',
				description: 'apps to build at once (default: half the cores, at most 4)',
			},
			json: jsonFlag,
		},
		run: (_args, values) => build(values),
	},
	{
		name: 'preview',
		args: '',
		summary: 'Serve the built apps locally (remotes before hosts)',
		minArgs: 0,
		maxArgs: 0,
		json: false,
		options: {
			only,
			kill: {
				type: 'boolean',
				description: 'stop a previous preview run and free the manifest ports, then exit',
			},
		},
		run: (_args, values) => preview(values),
	},
	{
		name: 'types',
		args: '',
		summary: "Type each remote's exposes from its real source, for <Remote> and remotes.d.ts",
		minArgs: 0,
		maxArgs: 0,
		json: false,
		options: { only },
		run: (_args, values) => types(values),
	},
	{
		name: 'deploy',
		args: '',
		summary: "Run each app's deploy command (remotes before hosts)",
		minArgs: 0,
		maxArgs: 0,
		json: true,
		options: {
			only,
			env: {
				type: 'string',
				value: '<name>',
				description:
					'exposed as SPOOL_ENV; records the deploy and checks shared deps against it',
			},
			json: jsonFlag,
		},
		run: (_args, values) => deploy(values),
	},
	{
		name: 'ci',
		args: '',
		summary: 'Generate GitHub workflows: one checking the workspace, one per deployable app',
		minArgs: 0,
		maxArgs: 0,
		json: false,
		options: { force: { type: 'boolean', description: 'overwrite existing workflow files' } },
		run: (_args, values) => ci(values),
	},
	{
		name: 'upgrade',
		args: '[files...]',
		summary: 'Migrate spool.json, regenerate spool-owned files and sync the toolchain',
		minArgs: 0,
		maxArgs: Infinity,
		json: false,
		options: {
			'dry-run': { type: 'boolean', description: 'report what would change without writing' },
			downgrade: {
				type: 'boolean',
				description: "write this CLI's dependency ranges even when the workspace is ahead",
			},
			force: {
				type: 'boolean',
				description:
					'overwrite generated files that have local changes; name paths after it to limit it',
			},
		},
		run: (args, values) => upgradeWithArgs(args, values),
	},
	{
		name: 'doctor',
		args: '',
		summary: 'Check ports, wiring, generated files, shared deps and environment',
		minArgs: 0,
		maxArgs: 0,
		json: true,
		options: {
			remote: { type: 'boolean', description: 'also fetch each deployed remote url' },
			env: {
				type: 'string',
				value: '<name>',
				description: "check each remote's urls.<name> instead of url",
			},
			fix: { type: 'boolean', description: 'apply the fixes doctor can make safely' },
			'dry-run': {
				type: 'boolean',
				description: 'with --fix, report what would change without writing',
			},
			json: jsonFlag,
		},
		run: (_args, values) => doctor(values),
	},
	{
		name: 'graph',
		args: '',
		summary: 'Print hosts, remotes, what each consumes and exposes, and the shared list',
		minArgs: 0,
		maxArgs: 0,
		json: true,
		options: {
			json: jsonFlag,
			dot: { type: 'boolean', description: 'print Graphviz dot' },
		},
		run: (_args, values) => graph(values),
	},
	{
		name: 'eject',
		args: '',
		summary: 'Remove the spool dependency and keep spool.json and every generated file',
		minArgs: 0,
		maxArgs: 0,
		json: false,
		options: {
			yes: { ...yes, description: 'skip the confirmation (required without a terminal)' },
		},
		run: (_args, values) => eject(values),
	},
]
