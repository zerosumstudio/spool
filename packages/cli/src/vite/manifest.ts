/*
 *   IMPORTS
 ***************************************************************************************************/
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MANIFEST_FILE, parseManifest, type Manifest } from '../core/config.js'
import { parseJson, requireWorkspaceRoot } from '../core/manifest-file.js'

/*
 *   MANIFEST
 ***************************************************************************************************/
export interface LoadedManifest {
	manifest: Manifest
	/** Folder holding spool.json. */
	root: string
}

/** Reads and validates spool.json with the same parser as the CLI, so a bad file fails at config load. */
export function loadManifest(from: string): LoadedManifest {
	const root = requireWorkspaceRoot(from)
	const raw = parseJson(readFileSync(join(root, MANIFEST_FILE), 'utf8'))

	return { manifest: parseManifest(raw), root }
}
