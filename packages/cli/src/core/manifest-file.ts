/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CliError } from '../util/errors.js'
import { MANIFEST_FILE } from './config.js'

/*
 *   MANIFEST FILE
 ***************************************************************************************************/
/** The folder holding spool.json, looking up from `cwd`, or null when there is none. */
export function findWorkspaceRoot(cwd = process.cwd()): string | null {
	let dir = resolve(cwd)

	for (;;) {
		if (existsSync(join(dir, MANIFEST_FILE))) return dir

		const parent = dirname(dir)
		if (parent === dir) return null

		dir = parent
	}
}

export function requireWorkspaceRoot(cwd = process.cwd()): string {
	const root = findWorkspaceRoot(cwd)
	if (root) return root

	throw new CliError(
		`No ${MANIFEST_FILE} found. Run \`spool create\` first, or cd into a spool workspace.`,
		'NO_WORKSPACE',
	)
}

/** Parses `spool.json` text, turning a syntax error into a message instead of a stack trace. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)

		throw new CliError(`${MANIFEST_FILE} is not valid JSON: ${reason}`, 'MANIFEST_INVALID')
	}
}
