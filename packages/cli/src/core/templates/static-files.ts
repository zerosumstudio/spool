/*
 *   IMPORTS
 ***************************************************************************************************/
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/*
 *   STATIC FILES
 ***************************************************************************************************/
/**
 * Template files that do not depend on the workspace. They are real, type-checked source in a
 * folder beside this module, and are written into an app unchanged. tsdown copies each folder to
 * `dist/` (see tsdown.config.ts), so the folders sit beside this module in the source tree and
 * beside the bundle once it is built.
 */
export const STATIC_FILES = {
	federation: ['core.ts', 'overrides.ts', 'remote.tsx', 'Remote.vue', 'Remote.svelte'],
	navigation: ['history.ts', 'binding.react.ts', 'binding.vue.ts', 'binding.svelte.ts'],
	sentry: ['scrub.ts'],
} as const

export type StaticFolder = keyof typeof STATIC_FILES

export type StaticFile<Folder extends StaticFolder> = (typeof STATIC_FILES)[Folder][number]

const HERE = dirname(fileURLToPath(import.meta.url))

const cache = new Map<string, string>()

/** The contents of a static file, with LF line endings whatever the checkout used. */
export function readStaticFile<Folder extends StaticFolder>(
	folder: Folder,
	name: StaticFile<Folder>,
): string {
	const key = `${folder}/${name}`
	const cached = cache.get(key)

	if (cached !== undefined) return cached

	const source = readFileSync(join(HERE, folder, name), 'utf8').replace(/\r\n/g, '\n')
	cache.set(key, source)

	return source
}
