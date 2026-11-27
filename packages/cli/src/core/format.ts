/*
 *   IMPORTS
 ***************************************************************************************************/
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FileMap } from './filemap.js'
import { printJsonFor } from './json-format.js'
import { findInstalledManifest } from '../util/bin.js'

/*
 *   HOUSE STYLE
 ***************************************************************************************************/
/**
 * Emitted into every scaffold as `.prettierrc`. Generated files are written already in this
 * style, so spool itself needs no formatter: the lint addon installs prettier for the workspace.
 */
export const PRETTIER_OPTIONS = {
	arrowParens: 'avoid',
	bracketSpacing: true,
	endOfLine: 'auto',
	printWidth: 100,
	semi: false,
	singleQuote: true,
	tabWidth: 4,
	trailingComma: 'all',
	useTabs: true,
} as const

/*
 *   THE WORKSPACE'S PRETTIER
 ***************************************************************************************************/
interface PrettierApi {
	format(source: string, options: Record<string, unknown>): string | Promise<string>
	getFileInfo(
		path: string,
	): { inferredParser: string | null } | Promise<{ inferredParser: string | null }>
	resolveConfig(
		path: string,
	): Record<string, unknown> | null | Promise<Record<string, unknown> | null>
}

interface PackageEntry {
	main?: string
	module?: string
	exports?: string | Record<string, unknown>
}

const installed = new Map<string, PrettierApi | null>()

/** Test hook: forget which workspaces were already looked at. */
export function resetFormatCache(): void {
	installed.clear()
}

function entryOf(manifest: PackageEntry): string | undefined {
	const root = typeof manifest.exports === 'object' ? manifest.exports['.'] : manifest.exports

	if (typeof root === 'string') return root
	if (root && typeof root === 'object') {
		const conditions = root as Record<string, unknown>
		const choice = conditions.import ?? conditions.default ?? conditions.require

		if (typeof choice === 'string') return choice
	}

	return manifest.module ?? manifest.main ?? 'index.js'
}

/**
 * The prettier the workspace installed, found from its own node_modules and never from
 * spool's. Loaded once per workspace, and only when something is actually formatted.
 */
async function workspacePrettier(root: string): Promise<PrettierApi | undefined> {
	const cached = installed.get(root)
	if (cached !== undefined) return cached ?? undefined

	let api: PrettierApi | null = null
	const manifestPath = findInstalledManifest(root, 'prettier', root)

	if (manifestPath) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageEntry
			const entry = join(dirname(manifestPath), entryOf(manifest) ?? 'index.js')
			const loaded = (await import(pathToFileURL(entry).href)) as PrettierApi & {
				default?: PrettierApi
			}

			api = typeof loaded.format === 'function' ? loaded : (loaded.default ?? null)
		} catch {
			api = null
		}
	}

	installed.set(root, api)
	return api ?? undefined
}

async function userOptions(prettier: PrettierApi, root: string): Promise<Record<string, unknown>> {
	try {
		return (await prettier.resolveConfig(join(root, 'package.json'))) ?? {}
	} catch {
		return {}
	}
}

/*
 *   FORMAT
 ***************************************************************************************************/
/**
 * Plain JSON that prettier would print the way spool's printer does. Anything that does not
 * parse is left alone.
 */
function reprintJson(name: string, content: string): string {
	try {
		return printJsonFor(name, JSON.parse(content))
	} catch {
		return content
	}
}

/**
 * Format one file. A workspace that has prettier installed gets its own prettier and its own
 * config, so the file matches the rest of its code. Without one the file is written as
 * generated, apart from JSON, which spool prints itself.
 */
export async function formatFile(
	filepath: string,
	content: string,
	root?: string,
): Promise<string> {
	const files = await formatFiles({ [filepath]: content }, root)

	return files[filepath] ?? content
}

/** Format every file prettier has a parser for; the rest pass through untouched. */
export async function formatFiles(files: FileMap, root?: string): Promise<FileMap> {
	const prettier = root === undefined ? undefined : await workspacePrettier(root)

	if (!prettier || root === undefined) {
		return Object.fromEntries(
			Object.entries(files).map(([rel, content]) => [
				rel,
				rel.endsWith('.json') ? reprintJson(rel, content) : content,
			]),
		)
	}

	const options = { ...PRETTIER_OPTIONS, ...(await userOptions(prettier, root)) }
	const entries = await Promise.all(
		Object.entries(files).map(async ([rel, content]): Promise<[string, string]> => {
			const { inferredParser } = await prettier.getFileInfo(rel)
			if (!inferredParser) return [rel, content]

			return [rel, await prettier.format(content, { ...options, filepath: rel })]
		}),
	)

	return Object.fromEntries(entries)
}
