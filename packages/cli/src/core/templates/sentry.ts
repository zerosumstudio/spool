/*
 *   IMPORTS
 ***************************************************************************************************/
import type { Framework, Manifest } from '../config.js'
import { SENTRY_SDK } from '../versions.js'
import type { FileMap } from '../filemap.js'
import { readStaticFile } from './static-files.js'

export const SENTRY_INIT_FILE = 'src/sentry.ts'
export const SENTRY_SCRUB_FILE = 'src/sentry-scrub.ts'

/*
 *   FILES
 ***************************************************************************************************/
export function sentryFiles(m: Manifest): FileMap {
	const files: FileMap = {}
	for (const [name, app] of Object.entries(m.apps)) {
		files[`${app.path}/${SENTRY_INIT_FILE}`] = sentryInit(name, app.framework)
		files[`${app.path}/${SENTRY_SCRUB_FILE}`] = readStaticFile('sentry', 'scrub.ts')
		// Checked in so a fresh clone knows what to set; the real value goes in
		// .env, which .gitignore keeps out.
		files[`${app.path}/.env.example`] = 'VITE_SENTRY_DSN=\n'
	}

	return files
}

function sentryInit(appName: string, framework: Framework): string {
	const sdk = SENTRY_SDK[framework]
	const isVue = framework === 'vue'
	const signature = isVue ? 'initSentry(app: App)' : 'initSentry()'
	const appImport = isVue ? `import type { App } from 'vue'\n` : ''
	// The Vue SDK sends a component's props with an error unless told not to.
	const appOption = isVue ? '\t\tapp,\n\t\tattachProps: false,\n' : ''

	return `${appImport}import * as Sentry from '${sdk}'
import { scrubBreadcrumb, scrubEvent } from './sentry-scrub'

${originTagger()}
export function ${signature}: void {
	const dsn = import.meta.env.VITE_SENTRY_DSN
	if (!dsn) return

	Sentry.init({
${appOption}		dsn,
		environment: import.meta.env.VITE_SPOOL_ENV ?? import.meta.env.MODE,
		// No user info, cookies, headers or bodies. Query strings are cut by the scrub.
		dataCollection: {
			userInfo: false,
			cookies: false,
			httpHeaders: { request: false, response: false },
			httpBodies: [],
		},
		initialScope: { tags: { mfe: '${appName}' } },
		integrations: defaults => [
			// Console output often carries user data, and nothing else reads it.
			...defaults.filter(integration => integration.name !== 'Console'),
			Sentry.moduleMetadataIntegration(),
		],
		beforeBreadcrumb: scrubBreadcrumb,
		beforeSend: event => scrubEvent(tagOriginMfe(event)),
	})
}
`
}

/** The vite plugin stamps each chunk with its owner, so "mfe" names the app that threw, not the one
 * that called Sentry.init. Compare <Remote>'s "remote" tag: the name a host asked for and failed to load. */
function originTagger(): string {
	return `// Under loaded-first, a shared chunk is attributed to whichever app's copy
// the browser loaded first, not necessarily the app that shipped it.
function readMfe(metadata: unknown): string | undefined {
	if (typeof metadata !== 'object' || metadata === null) return undefined

	const mfe = (metadata as { mfe?: unknown }).mfe

	return typeof mfe === 'string' ? mfe : undefined
}

function tagOriginMfe(event: Sentry.ErrorEvent): Sentry.ErrorEvent {
	let mfe: string | undefined

	for (const value of event.exception?.values ?? []) {
		const frames = value.stacktrace?.frames ?? []
		for (let i = frames.length - 1; i >= 0 && !mfe; i--) {
			mfe = readMfe(frames[i]?.module_metadata)
		}
		for (const frame of frames) delete frame.module_metadata
	}

	if (mfe) event.tags = { ...event.tags, mfe }

	return event
}
`
}

export function sentryEnvFiles(m: Manifest, dsn: string): FileMap {
	const files: FileMap = {}
	for (const app of Object.values(m.apps)) {
		files[`${app.path}/.env`] = `VITE_SENTRY_DSN=${dsn}\n`
	}

	return files
}

/** The pieces `viteConfig` splices into the generated vite.config.ts, written for its layout:
 * plugins sit three tabs in, so `entry` indents its own continuation lines to match. */
export function sentryVitePlugin(appName: string): {
	importLine: string
	helper: string
	entry: string
} {
	return {
		importLine: `import { sentryVitePlugin } from '@sentry/vite-plugin'\nimport { execSync } from 'node:child_process'`,
		helper: `// SENTRY_RELEASE wins in CI, where the checkout may be a shallow clone with
// no usable git history. A dev server has no release to name, so it never runs git.
function gitSha(command: string): string | undefined {
	if (command !== 'build') return undefined

	try {
		return execSync('git rev-parse --short HEAD').toString().trim()
	} catch {
		return undefined
	}
}
`,
		// Always mounted, because the module metadata below is what tells one app’s
		// errors from another’s once federation puts them all on one page. Only the
		// source map upload needs the token.
		entry: `sentryVitePlugin({
				org: process.env.SENTRY_ORG,
				project: process.env.SENTRY_PROJECT,
				authToken: process.env.SENTRY_AUTH_TOKEN,
				moduleMetadata: { mfe: '${appName}' },
				telemetry: false,
				release: { name: process.env.SENTRY_RELEASE ?? gitSha(command) },
				sourcemaps: {
					disable: !process.env.SENTRY_AUTH_TOKEN,
					filesToDeleteAfterUpload: ['./dist/**/*.map'],
				},
			})`,
	}
}

/*
 *   NOTES
 ***************************************************************************************************/
export function sentryNotes(composed: boolean): string[] {
	if (composed) {
		return [
			'sentry: initialized in every app and tagged by name, with urls cut to origin and path and no PII. Set VITE_SENTRY_DSN (a .env was written) and, for readable prod traces, SENTRY_AUTH_TOKEN/ORG/PROJECT in CI.',
		]
	}

	return [
		'sentry: call initSentry() (or initSentry(app) in vue) from each app entry, and set VITE_SENTRY_DSN before it reports.',
	]
}
