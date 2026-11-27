/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Manifest } from '../core/config.js'

/*
 *   DSN
 ***************************************************************************************************/
const DSN_VARIABLE = 'VITE_SENTRY_DSN'

/** `KEY=value` lines of a dotenv file, the way vite reads them: quotes stripped, `#` comments skipped. */
function readEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {}

	const values: Record<string, string> = {}

	for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
		const [, key, value] = match ?? []
		if (key === undefined || value === undefined) continue

		values[key] = value.replace(/^(['"])(.*)\1$/, '$2')
	}

	return values
}

/**
 * The `VITE_SENTRY_DSN` a build would bake in: the environment first, then the app's dotenv
 * files in the order vite loads them (a later file wins).
 */
export function resolveDsn(root: string, mode: string, env: NodeJS.ProcessEnv): string | undefined {
	if (env[DSN_VARIABLE]) return env[DSN_VARIABLE]

	let dsn: string | undefined

	for (const file of ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`]) {
		dsn = readEnvFile(join(root, file))[DSN_VARIABLE] ?? dsn
	}

	return dsn || undefined
}

/**
 * The origins Sentry events go to, which a strict `connect-src` has to allow. Nothing when the
 * workspace has no sentry addon or no DSN is set, so a build without one stays as tight as it was.
 */
export function sentryConnectOrigins(
	manifest: Manifest,
	root: string,
	mode: string,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	if (!manifest.addons.includes('sentry')) return []

	const dsn = resolveDsn(root, mode, env)
	if (!dsn) return []

	try {
		const url = new URL(dsn)

		return url.protocol === 'https:' || url.protocol === 'http:' ? [url.origin] : []
	} catch {
		return []
	}
}
