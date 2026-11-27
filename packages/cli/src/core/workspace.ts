/*
 *   IMPORTS
 ***************************************************************************************************/
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
	APP_DEFAULTS,
	APP_KEYS,
	MANIFEST_DEFAULTS,
	MANIFEST_FILE,
	MANIFEST_KEYS,
	parseManifest,
	type AppConfig,
	type Manifest,
} from './config.js'
import { formatFile } from './format.js'
import { findWorkspaceRoot, parseJson, requireWorkspaceRoot } from './manifest-file.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface Workspace {
	/** Absolute path to the workspace root (dir containing spool.json). */
	root: string
	manifestPath: string
	manifest: Manifest
	/** spool.json as last read from disk, before schema defaults were applied.
	 * saveManifest diffs against this so an unrelated edit never reorders keys
	 * or writes back defaults the user never asked for. */
	raw: unknown
}

/*
 *   WORKSPACE
 ***************************************************************************************************/
async function readWorkspace(root: string): Promise<Workspace> {
	const manifestPath = join(root, MANIFEST_FILE)
	const raw = parseJson(await readFile(manifestPath, 'utf8'))

	return { root, manifestPath, manifest: parseManifest(raw), raw }
}

export async function loadWorkspace(cwd = process.cwd()): Promise<Workspace | null> {
	const root = findWorkspaceRoot(cwd)

	return root ? readWorkspace(root) : null
}

export async function requireWorkspace(cwd = process.cwd()): Promise<Workspace> {
	return readWorkspace(requireWorkspaceRoot(cwd))
}

export async function saveManifest(ws: Workspace): Promise<void> {
	const payload = manifestForWrite(ws.manifest, ws.raw)
	// Same formatter as the scaffold path, so `spool add` rewrites never
	// churn the manifest's style.
	const content = await formatFile(MANIFEST_FILE, JSON.stringify(payload))
	await writeFile(ws.manifestPath, content, 'utf8')
	ws.raw = payload
}

/*
 *   RAW-PRESERVING SERIALIZATION
 ***************************************************************************************************/
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Raw's own keys first (its original order), then anything new, in `fallback` order. */
function orderedKeys(raw: Record<string, unknown>, fallback: readonly string[]): string[] {
	const known = new Set(Object.keys(raw))
	return [...Object.keys(raw), ...fallback.filter(key => !known.has(key))]
}

function deepEqual(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b)
}

export function manifestForWrite(manifest: Manifest, raw: unknown): unknown {
	const rawObj = isRecord(raw) ? raw : {}
	const out: Record<string, unknown> = {}

	for (const key of orderedKeys(rawObj, MANIFEST_KEYS)) {
		if (key === 'apps') {
			out.apps = appsForWrite(manifest.apps, rawObj.apps)
			continue
		}

		const value = (manifest as unknown as Record<string, unknown>)[key]
		if (value === undefined) continue
		if (
			key in MANIFEST_DEFAULTS &&
			!(key in rawObj) &&
			deepEqual(value, (MANIFEST_DEFAULTS as Record<string, unknown>)[key])
		) {
			continue
		}
		out[key] = value
	}

	return out
}

function appsForWrite(apps: Manifest['apps'], rawApps: unknown): Record<string, unknown> {
	const rawObj = isRecord(rawApps) ? rawApps : {}
	const out: Record<string, unknown> = {}

	for (const name of orderedKeys(rawObj, Object.keys(apps))) {
		const app = apps[name]
		if (!app) continue
		out[name] = appForWrite(app, rawObj[name])
	}

	return out
}

function appForWrite(app: AppConfig, rawApp: unknown): Record<string, unknown> {
	const rawObj = isRecord(rawApp) ? rawApp : {}
	const out: Record<string, unknown> = {}

	for (const key of orderedKeys(rawObj, APP_KEYS)) {
		const value = (app as unknown as Record<string, unknown>)[key]
		if (value === undefined) continue
		if (
			key in APP_DEFAULTS &&
			!(key in rawObj) &&
			deepEqual(value, (APP_DEFAULTS as Record<string, unknown>)[key])
		) {
			continue
		}
		out[key] = value
	}

	return out
}
