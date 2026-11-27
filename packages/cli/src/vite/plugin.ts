/*
 *   IMPORTS
 ***************************************************************************************************/
import type { AppConfig, Manifest } from '../core/config.js'
import { headerRules, headersFile, rulesMiddleware, serverHeaders } from './headers.js'
import { sentryConnectOrigins } from './sentry-dsn.js'

/*
 *   TYPES
 ***************************************************************************************************/
interface DevServer {
	middlewares: { use: (handler: ReturnType<typeof rulesMiddleware>) => unknown }
}

/** The slice of vite's Plugin spool uses, so this package needs no vite types. */
export interface SpoolPlugin {
	name: 'spool'
	/** Runs first, so its middleware answers before the federation plugin ends a manifest response. */
	enforce: 'pre'
	config: (
		userConfig?: unknown,
		env?: { mode?: string; isPreview?: boolean },
	) => { define: Record<string, string>; preview: { headers: Record<string, string> } }
	configureServer: (server: DevServer) => void
	configurePreviewServer: (server: DevServer) => void
	generateBundle: (this: {
		emitFile: (file: { type: 'asset'; fileName: string; source: string }) => string
	}) => void
}

/** Vite's `command`. Only builds read deployed remote urls and lock the override origins. */
export type SpoolCommand = 'build' | 'serve'

export const OVERRIDE_ORIGINS_DEFINE = '__SPOOL_OVERRIDE_ORIGINS__'

export interface PluginOptions {
	/** The app's folder, where its dotenv files live. */
	root?: string
	env?: NodeJS.ProcessEnv
}

/*
 *   PLUGIN
 ***************************************************************************************************/
/**
 * The origins a runtime override may load from. A build gets only `overrides.origins`, so
 * production stays as locked down as spool.json says. A dev server also gets every app's own
 * localhost origin, so pointing a host at a local remote needs no configuration.
 */
export function overrideOrigins(manifest: Manifest, command: SpoolCommand): string[] {
	const configured = manifest.overrides?.origins ?? []
	if (command === 'build') return configured

	const local = Object.values(manifest.apps).map(entry => `http://localhost:${entry.port}`)

	return [...new Set([...configured, ...local])]
}

/**
 * Preview sets its headers before the build output is known, so a DSN that exists only as a
 * build-time variable cannot reach its `connect-src`. Say so, once, instead of blocking Sentry silently.
 */
function warnIfSentryOriginMissing(
	manifest: Manifest,
	name: string,
	root: string | undefined,
	connectOrigins: string[],
): void {
	if (manifest.csp !== 'strict' || !manifest.addons.includes('sentry')) return
	if (root === undefined || connectOrigins.length) return

	console.warn(
		`[spool] preview found no VITE_SENTRY_DSN in apps/${name}/.env, so connect-src leaves out Sentry. Put the DSN in .env to preview with it.`,
	)
}

/**
 * Defines the origins a runtime override may use, makes the dev and preview servers answer with
 * the same per-path headers a static host would, and writes `_headers` into the build output
 * from spool.json, so the shipped file cannot go stale.
 */
export function spoolPlugin(
	name: string,
	manifest: Manifest,
	app: AppConfig,
	command: SpoolCommand = 'build',
	options: PluginOptions = {},
): SpoolPlugin {
	const origins = overrideOrigins(manifest, command)
	const env = options.env ?? process.env
	let mode = command === 'build' ? 'production' : 'development'

	const connectOrigins = (): string[] =>
		options.root === undefined ? [] : sentryConnectOrigins(manifest, options.root, mode, env)

	return {
		name: 'spool',
		enforce: 'pre',
		config: (_userConfig, viteEnv) => {
			if (viteEnv?.mode) mode = viteEnv.mode
			if (viteEnv?.isPreview)
				warnIfSentryOriginMissing(manifest, name, options.root, connectOrigins())

			return {
				define: { [OVERRIDE_ORIGINS_DEFINE]: JSON.stringify(origins) },
				// vite's static server sets preview.headers after any middleware, so the strict
				// policy has to be in them or it is overwritten by the plain one from server.headers.
				preview: {
					headers: serverHeaders(manifest, app, 'preview', connectOrigins()),
				},
			}
		},
		configureServer: server => {
			server.middlewares.use(
				rulesMiddleware(headerRules(manifest, app, { mode: 'dev', env })),
			)
		},
		configurePreviewServer: server => {
			server.middlewares.use(
				rulesMiddleware(
					headerRules(manifest, app, {
						mode: 'preview',
						env,
						connectOrigins: connectOrigins(),
					}),
				),
			)
		},
		generateBundle() {
			this.emitFile({
				type: 'asset',
				fileName: '_headers',
				source: headersFile(name, manifest, app, env, connectOrigins()),
			})
		},
	}
}
