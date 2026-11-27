/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as p from '@clack/prompts'
import { printJsonFor } from './json-format.js'
import { ask, canPrompt } from '../util/interactive.js'
import { style } from '../util/style.js'
import { ADDON_NAME_VALUES, type AddonName, type Manifest } from './config.js'
import { NO_EXTRAS, type TemplateExtras } from './templates/index.js'
import { sentryFiles, sentryNotes } from './templates/sentry.js'
import { SENTRY_SDK } from './versions.js'
import { ladleFiles } from './templates/ladle.js'
import { playwrightFiles } from './templates/playwright.js'
import { stateFiles } from './templates/state.js'
import { turboConfig, turboNotes } from './templates/turbo.js'
import { navigationFiles, navigationNotes } from './templates/composition.js'
import {
	ALIAS_FILE,
	eslintConfig,
	lintNotes,
	remoteAliasModule,
	remoteStubs,
	testNotes,
	vitestConfig,
} from './templates/quality.js'
import type { FileMap } from './filemap.js'
import { CliError } from '../util/errors.js'
import { splitList } from '../util/names.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface Addon {
	label: string
	hint: string
	/** Why this addon cannot be added to the workspace, or undefined when it can. */
	unavailable(m: Manifest): string | undefined
	/** Whether the workspace already has this addon. */
	present(root: string, m: Manifest): boolean
	/** Mutates the manifest before anything is written (e.g. adds `shared` entries). */
	apply?(m: Manifest): void
	/** Files to write, relative to the workspace root. Extras only flow at create time. */
	files(m: Manifest, extras?: TemplateExtras): FileMap
	/** Dependencies whose postinstall scripts pnpm must allow. */
	allowBuilds: string[]
	/** Printed after scaffolding. `composed` is true only at create time, where
	 * the addon wires itself into untouched apps. */
	notes(m: Manifest, composed: boolean): string[]
}

function enableAddon(m: Manifest, name: AddonName): void {
	if (!m.addons.includes(name)) m.addons.push(name)
}

export function shareSentrySdks(m: Manifest): void {
	const frameworks = new Set(Object.values(m.apps).map(app => app.framework))
	for (const framework of frameworks) {
		const sdk = SENTRY_SDK[framework]
		if (!m.shared.includes(sdk)) m.shared.push(sdk)
	}
}

function navigationAddonFiles(m: Manifest): FileMap {
	const files: FileMap = {}
	for (const app of Object.values(m.apps)) {
		for (const [rel, content] of Object.entries(navigationFiles(app))) {
			files[`${app.path}/${rel}`] = content
		}
	}

	return files
}

function testFiles(m: Manifest): FileMap {
	const files: FileMap = {}

	for (const app of Object.values(m.apps)) {
		files[`${app.path}/vitest.config.ts`] = vitestConfig(app.framework)
		files[`${app.path}/${ALIAS_FILE}`] = remoteAliasModule(m, app)

		for (const [rel, content] of Object.entries(remoteStubs(m, app))) {
			files[`${app.path}/${rel}`] = content
		}
	}

	return files
}

const DEFINITIONS: Record<AddonName, Addon> = {
	ladle: {
		label: 'Ladle',
		hint: 'design-system package in packages/ui with a component workshop',
		unavailable: m =>
			Object.values(m.apps).some(app => app.framework === 'react')
				? undefined
				: 'Ladle is react-based; it needs at least one react app in the workspace.',
		present: root => existsSync(join(root, 'packages/ui')),
		files: () => ladleFiles(),
		allowBuilds: ['@swc/core', 'msw'],
		notes: m => [
			`ladle: \`spool dev\` starts the component workshop with your apps, or ${formatRunCommand(m, 'ui', 'ladle')} runs it on its own`,
		],
	},
	playwright: {
		label: 'Playwright',
		hint: 'e2e tests in packages/e2e that boot the workspace and check every remote',
		unavailable: m =>
			Object.values(m.apps).some(app => app.type === 'host')
				? undefined
				: 'Playwright e2e tests need a host app to visit.',
		present: root => existsSync(join(root, 'packages/e2e')),
		files: (m, extras) => playwrightFiles(m, extras ?? NO_EXTRAS),
		allowBuilds: [],
		notes: m => [
			`playwright: run \`npx playwright install\` once, then ${formatRunCommand(m, 'e2e', 'test')}`,
		],
	},
	lint: {
		label: 'ESLint',
		hint: 'one flat config at the root, with the plugins your frameworks need',
		unavailable: () => undefined,
		present: (_root, m) => m.addons.includes('lint'),
		apply: m => enableAddon(m, 'lint'),
		files: m => ({ 'eslint.config.js': eslintConfig(m) }),
		allowBuilds: [],
		notes: m => lintNotes(m),
	},
	test: {
		label: 'Vitest',
		hint: 'unit tests per app, with each host’s remotes stubbed out',
		unavailable: () => undefined,
		present: (_root, m) => m.addons.includes('test'),
		apply: m => enableAddon(m, 'test'),
		files: m => testFiles(m),
		allowBuilds: [],
		notes: m => testNotes(m),
	},
	turbo: {
		label: 'Turborepo',
		hint: 'cached, parallel task runs, with spool.json wired into the cache key',
		unavailable: () => undefined,
		present: (_root, m) => m.addons.includes('turbo'),
		apply: m => enableAddon(m, 'turbo'),
		files: m => ({ 'turbo.json': turboConfig(m) }),
		allowBuilds: ['turbo'],
		notes: m => turboNotes(m),
	},
	state: {
		label: 'Shared state',
		hint: 'a store every app shares as a federation singleton (@zerosumstudio/clutch)',
		unavailable: () => undefined,
		present: (_root, m) => m.shared.includes('@zerosumstudio/clutch'),
		apply: m => {
			const entries = ['@zerosumstudio/clutch']
			if (Object.values(m.apps).some(app => app.framework === 'react')) {
				entries.push('@zerosumstudio/clutch/react')
			}
			for (const entry of entries) {
				if (!m.shared.includes(entry)) m.shared.push(entry)
			}
		},
		files: m => stateFiles(m),
		allowBuilds: [],
		notes: m => [
			`state: every app got src/state/counter.ts; all copies resolve to one store per page${
				Object.values(m.apps).some(app => app.framework === 'react')
					? ' (react apps: useStore from "@zerosumstudio/clutch/react")'
					: ''
			}`,
		],
	},
	sentry: {
		label: 'Sentry',
		hint: 'error and performance monitoring wired into every app',
		unavailable: () => undefined,
		present: (_root, m) => m.addons.includes('sentry'),
		apply: m => {
			enableAddon(m, 'sentry')
			shareSentrySdks(m)
		},
		files: m => sentryFiles(m),
		allowBuilds: ['@sentry/cli'],
		notes: (_m, composed) => sentryNotes(composed),
	},
	navigation: {
		label: 'Navigation',
		hint: 'one url every bundle on the page agrees on, in src/navigation',
		unavailable: () => undefined,
		present: (_root, m) => m.addons.includes('navigation'),
		apply: m => enableAddon(m, 'navigation'),
		files: navigationAddonFiles,
		allowBuilds: [],
		notes: () => navigationNotes(),
	},
}

/** The addon, with every JSON file it writes printed the way prettier prints it. */
function withPrintedJson(addon: Addon): Addon {
	return {
		...addon,
		files: (m, extras) => printJsonFiles(addon.files(m, extras)),
	}
}

/**
 * Whatever an addon's templates write, its JSON files come out the way prettier prints them,
 * so a workspace with no prettier installed still starts out formatted. A template whose JSON
 * does not parse is a bug in spool, so it throws.
 */
function printJsonFiles(files: FileMap): FileMap {
	return Object.fromEntries(
		Object.entries(files).map(([rel, content]) => [
			rel,
			rel.endsWith('.json') ? printJsonFor(rel, JSON.parse(content)) : content,
		]),
	)
}

export const ADDONS: Record<AddonName, Addon> = {
	ladle: withPrintedJson(DEFINITIONS.ladle),
	playwright: withPrintedJson(DEFINITIONS.playwright),
	lint: withPrintedJson(DEFINITIONS.lint),
	test: withPrintedJson(DEFINITIONS.test),
	turbo: withPrintedJson(DEFINITIONS.turbo),
	state: withPrintedJson(DEFINITIONS.state),
	sentry: withPrintedJson(DEFINITIONS.sentry),
	navigation: withPrintedJson(DEFINITIONS.navigation),
}

export type { AddonName } from './config.js'

export const ADDON_NAMES: AddonName[] = [...ADDON_NAME_VALUES]

export function templateExtras(addons: AddonName[]): TemplateExtras {
	return {
		stateExample: addons.includes('state'),
		uiButton: addons.includes('state') && addons.includes('ladle'),
		sentry: addons.includes('sentry'),
		composed: addons.includes('navigation'),
	}
}

export function isAddonName(value: string): value is AddonName {
	return (ADDON_NAME_VALUES as readonly string[]).includes(value)
}

export function parseAddonList(value: string, m: Manifest): AddonName[] {
	const names: AddonName[] = []
	for (const entry of splitList(value)) {
		if (entry === 'none') continue
		if (entry === 'shell') {
			throw new CliError('The "shell" addon was renamed to "navigation".', 'INVALID_VALUE')
		}
		if (!isAddonName(entry)) {
			throw new CliError(
				`Unknown addon "${entry}". Use ${ADDON_NAMES.join(' or ')}, or "none".`,
				'INVALID_VALUE',
			)
		}
		const reason = ADDONS[entry].unavailable(m)
		if (reason) throw new CliError(reason, 'INVALID_VALUE')
		names.push(entry)
	}

	return [...new Set(names)]
}

/** Multiselect over `names`. Non-TTY runs get no addons, since a prompt could never resolve. */
export async function promptAddons(message: string, names: AddonName[]): Promise<AddonName[]> {
	if (!names.length || !canPrompt()) return []

	return ask(
		p.multiselect({
			message: `${message} ${style.dim('(space selects, enter confirms)')}`,
			options: names.map(name => ({
				value: name,
				label: ADDONS[name].label,
				hint: ADDONS[name].hint,
			})),
			required: false,
		}),
	)
}

/*
 *   HELPERS
 ***************************************************************************************************/
function formatRunCommand(m: Manifest, pkg: string, script: string): string {
	if (m.packageManager === 'pnpm') return `\`pnpm --filter ${pkg} ${script}\``
	if (m.packageManager === 'yarn') return `\`yarn workspace ${pkg} ${script}\``
	return `\`npm run ${script} --workspace ${pkg}\``
}

/*
 *   LADLE
 ***************************************************************************************************/
