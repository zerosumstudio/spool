/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { CliError } from './errors.js'

/*
 *   TYPES
 ***************************************************************************************************/
export type ViteMode = 'dev' | 'preview' | 'build'

export interface Invocation {
	command: string
	args: string[]
}

interface PackageBin {
	bin?: string | Record<string, string>
}

/*
 *   RESOLVE
 ***************************************************************************************************/
/**
 * The package.json of `packageName` as installed for `fromDir`: its own node_modules, then each parent's
 * up to and including `stopAt`, the workspace root, where every package manager hoists. Going
 * further would run whatever a folder above the workspace happens to hold, and on Windows any
 * user can create one in a drive root.
 */
export function findInstalledManifest(
	fromDir: string,
	packageName: string,
	stopAt: string,
): string | undefined {
	const stop = resolve(stopAt)
	const outside =
		relative(stop, resolve(fromDir)).startsWith('..') ||
		isAbsolute(relative(stop, resolve(fromDir)))
	let dir = resolve(fromDir)

	for (;;) {
		const candidate = join(dir, 'node_modules', packageName, 'package.json')
		if (existsSync(candidate)) return candidate

		const parent = dirname(dir)
		if (outside || dir === stop || parent === dir) return undefined
		dir = parent
	}
}

/**
 * The script a package's `bin` entry points at, as installed for `fromDir`. The lookup is
 * anchored to that folder: `require.resolve` would also search NODE_PATH and the global
 * folders, and run a copy the workspace never installed. `<packageName>/bin/<file>` is not an
 * exported subpath of most packages, so this reads the `bin` field instead.
 */
export function resolvePackageBin(
	fromDir: string,
	packageName: string,
	bin: string,
	stopAt: string,
): string {
	const manifestPath = findInstalledManifest(fromDir, packageName, stopAt)
	if (!manifestPath) {
		throw new CliError(
			`Could not find "${packageName}" from ${fromDir}. Install the workspace's dependencies first.`,
			'FAILED',
		)
	}

	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageBin
	const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin]
	if (!entry) throw new CliError(`"${packageName}" has no "${bin}" command.`, 'FAILED')

	return join(dirname(manifestPath), entry)
}

const VITE_ARGS: Record<ViteMode, string[]> = {
	dev: [],
	preview: ['preview'],
	build: ['build'],
}

/** Runs the app's own vite under the node that runs spool: no package manager, no shell. */
export function viteInvocation(appDir: string, mode: ViteMode, workspaceRoot: string): Invocation {
	return {
		command: process.execPath,
		args: [resolvePackageBin(appDir, 'vite', 'vite', workspaceRoot), ...VITE_ARGS[mode]],
	}
}

export function ladleInvocation(dir: string, workspaceRoot: string): Invocation {
	return {
		command: process.execPath,
		args: [resolvePackageBin(dir, '@ladle/react', 'ladle', workspaceRoot), 'serve'],
	}
}
