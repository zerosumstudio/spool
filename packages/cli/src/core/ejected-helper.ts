/*
 *   IMPORTS
 ***************************************************************************************************/
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CliError } from '../util/errors.js'

/*
 *   TYPES
 ***************************************************************************************************/
/** Where `eject` puts the helper, at the workspace root. */
export const EJECTED_HELPER = 'spool.vite'
export const EJECTED_HELPER_FILES = [`${EJECTED_HELPER}.js`, `${EJECTED_HELPER}.d.ts`] as const

/** The import every generated vite config uses until the workspace is ejected. */
export const VITE_ENTRY = '@zerosumstudio/spool/vite'

export interface EjectedHelper {
	/** File name to contents, for the workspace root. */
	files: Record<(typeof EJECTED_HELPER_FILES)[number], string>
}

/*
 *   BUNDLE
 ***************************************************************************************************/
/**
 * The built `./vite` entry, which has no dependencies beyond node, so it runs from the
 * workspace without spool installed. It sits beside the CLI's own bundle in `dist`.
 */
export function readBundledHelper(
	dir: string = fileURLToPath(new URL('.', import.meta.url)),
): EjectedHelper {
	try {
		return {
			files: {
				'spool.vite.js': readFileSync(`${dir}/vite.js`, 'utf8'),
				'spool.vite.d.ts': readFileSync(`${dir}/vite.d.ts`, 'utf8'),
			},
		}
	} catch {
		throw new CliError(
			`Could not read the built ${VITE_ENTRY} from ${dir}. Run eject from an installed spool, not a source checkout without a build.`,
		)
	}
}

/** The import a vite config uses once the helper sits at the workspace root, `depth` folders up. */
export function ejectedImport(appPath: string): string {
	const depth = appPath.split('/').filter(Boolean).length

	return `${'../'.repeat(depth)}${EJECTED_HELPER}.js`
}
