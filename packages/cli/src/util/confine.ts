/*
 *   IMPORTS
 ***************************************************************************************************/
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { CliError } from './errors.js'

/*
 *   CONFINEMENT
 ***************************************************************************************************/
export interface ConfineOptions {
	/**
	 * The last segment may itself be a link. Deleting it unlinks the link and never follows it,
	 * so a folder delete allows this; a write does not.
	 */
	allowFinalLink?: boolean
}

function refuse(target: string, reason: string): never {
	throw new CliError(`Refusing to touch "${target}": ${reason}.`, 'UNSAFE_PATH')
}

function isMissing(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | null)?.code

	return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The real, canonical form of a path that exists. */
function toRealPath(path: string): string {
	return realpathSync.native(path)
}

/**
 * The first segment between the root and the target that is a symlink or junction, or undefined
 * when none is, or when the path runs out of existing folders first.
 */
function findLinkSegment(
	rootPath: string,
	segments: string[],
	options: ConfineOptions,
): { segment: string } | 'missing' | undefined {
	let current = rootPath

	for (const [index, segment] of segments.entries()) {
		current = join(current, segment)

		try {
			const isFinal = index === segments.length - 1

			if (lstatSync(current).isSymbolicLink() && !(isFinal && options.allowFinalLink)) {
				return { segment }
			}
		} catch (error) {
			if (!isMissing(error)) throw error

			return 'missing'
		}
	}

	return undefined
}

/** Whether an existing target still resolves under the root once every link is followed. */
function isResolvedInside(targetPath: string, rootPath: string, options: ConfineOptions): boolean {
	try {
		const finalLink = options.allowFinalLink && lstatSync(targetPath).isSymbolicLink()
		const resolved = toRealPath(finalLink ? resolve(targetPath, '..') : targetPath)
		const rootResolved = toRealPath(rootPath)

		return resolved === rootResolved || resolved.startsWith(rootResolved + sep)
	} catch (error) {
		if (isMissing(error)) return true

		throw error
	}
}

/**
 * Throws unless `target` sits inside `root` for real: no segment between them is a symlink or
 * junction, and the resolved location is still under the root's resolved location. A string
 * comparison on the unresolved path misses a committed `apps -> ~` link, which would send a
 * delete or a write somewhere else entirely.
 */
export function assertConfined(root: string, target: string, options: ConfineOptions = {}): void {
	const rootPath = resolve(root)
	const targetPath = resolve(target)
	const path = relative(rootPath, targetPath)

	if (path === '') return
	if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) {
		refuse(target, 'it resolves outside the workspace')
	}

	const link = findLinkSegment(rootPath, path.split(sep), options)

	if (link === 'missing') return
	if (link) refuse(target, `"${link.segment}" is a symlink or junction`)

	if (!isResolvedInside(targetPath, rootPath, options)) {
		refuse(target, 'it resolves outside the workspace')
	}
}
