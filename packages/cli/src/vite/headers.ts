/*
 *   IMPORTS
 ***************************************************************************************************/
import type { AppConfig, Manifest } from '../core/config.js'
import type { ViteMode } from '../util/bin.js'
import { CliError } from '../util/errors.js'
import { HEADER_NAME_PATTERN, isSafeHeaderValue, remoteEnvVar } from '../util/names.js'

/*
 *   CSP
 ***************************************************************************************************/
/** `self`/`none` become quoted CSP keywords; anything else is a source, written as-is. */
function frameAncestorsValue(tokens: string[] | undefined): string {
	if (!tokens?.length) return "'self'"

	return tokens
		.map(token => (token === 'self' || token === 'none' ? `'${token}'` : token))
		.join(' ')
}

function originOf(url: string): string | undefined {
	try {
		return new URL(url).origin
	} catch {
		return undefined
	}
}

/**
 * Where a host may load code and data from in production: the origins of every remote it
 * consumes (each environment's url, and the one this build resolves through SPOOL_REMOTE_*)
 * and the origins a runtime override may use.
 */
export function strictSources(
	manifest: Manifest,
	app: AppConfig,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const urls = app.remotes.flatMap(name => {
		const remote = manifest.apps[name]

		return [remote?.url, ...Object.values(remote?.urls ?? {}), env[remoteEnvVar(name)]]
	})
	const origins = [
		...urls.map(url => (url ? originOf(url) : undefined)),
		...(manifest.overrides?.origins ?? []),
	]

	return [...new Set(origins.filter((origin): origin is string => origin !== undefined))]
}

export interface PolicyOptions {
	/** Dev servers inject inline scripts, so only preview and build get the strict script and connect sources. */
	mode: ViteMode
	env?: NodeJS.ProcessEnv
	/** Extra `connect-src` origins, such as the Sentry ingest host. */
	connectOrigins?: string[]
}

/**
 * The Content-Security-Policy value for an app. Every app gets `object-src 'none'` and
 * `base-uri 'self'`. `frame-ancestors` is left to the edge when the app lists `edge`, since
 * two CSP headers intersect. `csp: "strict"` adds `script-src` and `connect-src` for builds.
 */
export function contentSecurityPolicy(
	manifest: Manifest,
	app: AppConfig,
	options: PolicyOptions,
): string {
	const directives: string[] = []

	if (app.frameAncestors?.[0] !== 'edge') {
		directives.push(`frame-ancestors ${frameAncestorsValue(app.frameAncestors)}`)
	}
	directives.push("object-src 'none'", "base-uri 'self'")

	if (manifest.csp === 'strict' && options.mode !== 'dev') {
		const sources = ["'self'", ...strictSources(manifest, app, options.env)]
		const connect = [...new Set([...sources, ...(options.connectOrigins ?? [])])]

		directives.push(`script-src ${sources.join(' ')}`, `connect-src ${connect.join(' ')}`)
	}

	return directives.join('; ')
}

/*
 *   HEADERS
 ***************************************************************************************************/
/** A header name or value that would add lines to a headers file or a response. */
function assertSafe(name: string, value: string): void {
	if (HEADER_NAME_PATTERN.test(name) && isSafeHeaderValue(value)) return

	throw new CliError(
		`Refusing header "${name}": its name or value has characters that split headers.`,
		'INVALID_VALUE',
	)
}

/**
 * Where headers are served:
 * - `build`: the `_headers` file a static host reads. CORS and caching for remotes, and the policy.
 * - `preview`: the built app on a local server. The same policy, strict sources included, and
 *   the same caching. CORS stays with the server's own `cors` allowlist, not `*`.
 * - `dev`: everything but what breaks hot reload, which is the strict `script-src` and
 *   `connect-src` (HMR needs inline scripts and a websocket) and the immutable `/assets/*` cache.
 */
export interface HeaderRule {
	/** `/*` for every path, `/prefix/*` for a folder, otherwise an exact path. */
	path: string
	headers: Record<string, string>
}

export interface RuleOptions {
	mode: ViteMode
	env?: NodeJS.ProcessEnv
	/** Extra `connect-src` origins, such as the Sentry ingest host. */
	connectOrigins?: string[]
}

/** The header rules for an app, in the order a `_headers` file lists them. */
export function headerRules(
	manifest: Manifest,
	app: AppConfig,
	options: RuleOptions,
): HeaderRule[] {
	const { mode } = options
	const cors: Record<string, string> =
		app.type === 'remote' && mode === 'build' ? { 'Access-Control-Allow-Origin': '*' } : {}
	const policy = contentSecurityPolicy(manifest, app, {
		mode,
		...(options.env ? { env: options.env } : {}),
		...(options.connectOrigins ? { connectOrigins: options.connectOrigins } : {}),
	})
	const custom = Object.entries(app.headers ?? {})

	for (const [key, value] of custom) assertSafe(key, value)

	return [
		{ path: '/mf-manifest.json', headers: { ...cors, 'Cache-Control': 'no-cache' } },
		{ path: '/remoteEntry.js', headers: { ...cors, 'Cache-Control': 'no-cache' } },
		...(mode === 'dev'
			? []
			: [
					{
						path: '/assets/*',
						headers: {
							...cors,
							'Cache-Control': 'public, max-age=31536000, immutable',
						},
					},
				]),
		{
			path: '/*',
			headers: {
				'X-Content-Type-Options': 'nosniff',
				'Content-Security-Policy': policy,
				...Object.fromEntries(custom),
			},
		},
	]
}

/** The headers a dev or preview server sends for an app, on every response. */
export function serverHeaders(
	manifest: Manifest,
	app: AppConfig,
	mode: Exclude<ViteMode, 'build'> = 'dev',
	connectOrigins: string[] = [],
): Record<string, string> {
	return {
		'X-Content-Type-Options': 'nosniff',
		'Content-Security-Policy': contentSecurityPolicy(manifest, app, {
			mode,
			connectOrigins,
		}),
		...app.headers,
		...manifest.server?.headers,
	}
}

/** The `_headers` file a static host reads: CORS and caching for remotes, and the policy for every page. */
export function headersFile(
	name: string,
	manifest: Manifest,
	app: AppConfig,
	env: NodeJS.ProcessEnv = process.env,
	connectOrigins: string[] = [],
): string {
	const note =
		app.frameAncestors?.[0] === 'edge'
			? '\n# frame-ancestors is set by the edge for this app.'
			: ''
	const blocks = headerRules(manifest, app, { mode: 'build', env, connectOrigins })
		.map(rule => {
			const lines = Object.entries(rule.headers).map(([key, value]) => `  ${key}: ${value}`)

			return [rule.path, ...lines].join('\n')
		})
		.join('\n\n')

	return `# Generated by spool for ${name}. Edit spool.json's headers, frameAncestors and csp, not this file.${note}\n${blocks}\n`
}

/*
 *   SERVING THE RULES
 ***************************************************************************************************/
/** True when a request path falls under a rule the way a `_headers` file reads it. */
export function ruleMatches(rulePath: string, requestPath: string): boolean {
	if (rulePath === '/*') return true
	if (rulePath.endsWith('/*')) return requestPath.startsWith(rulePath.slice(0, -1))

	return requestPath === rulePath
}

type Middleware = (
	request: { url?: string },
	response: { setHeader: (name: string, value: string) => unknown },
	next: () => void,
) => void

/** Sets every matching rule's headers on a response, so dev and preview answer like a static host. */
export function rulesMiddleware(rules: HeaderRule[]): Middleware {
	return (request, response, next) => {
		const path = (request.url ?? '/').split('?')[0] ?? '/'

		for (const rule of rules) {
			if (!ruleMatches(rule.path, path)) continue

			for (const [key, value] of Object.entries(rule.headers)) response.setHeader(key, value)
		}

		next()
	}
}
