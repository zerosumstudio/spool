/*
 *   IMPORTS
 ***************************************************************************************************/
import { win32 } from 'node:path'

/*
 *   WINDOWS SYSTEM TOOLS
 ***************************************************************************************************/
/**
 * Windows looks in the current folder before PATH for a bare program name, so a checkout that
 * ships `netstat.exe` would run it when spool only meant to check a port. Setting this keeps the
 * current folder out of the search for spool and everything it starts.
 */
export function hardenExecutableSearch(env: NodeJS.ProcessEnv = process.env): void {
	env.NoDefaultCurrentDirectoryInExePath = '1'
}

function systemRoot(env: NodeJS.ProcessEnv): string {
	const root = env.SystemRoot ?? env.windir

	return root && win32.isAbsolute(root) ? root : String.raw`C:\Windows`
}

/** A program in `System32`, by absolute path. */
export function system32Tool(name: string, env: NodeJS.ProcessEnv = process.env): string {
	return win32.join(systemRoot(env), 'System32', name)
}

export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
	return win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** `ComSpec` when it names an absolute cmd.exe, otherwise the one in System32. */
export function commandShell(env: NodeJS.ProcessEnv = process.env): string {
	const spec = env.ComSpec

	if (spec && win32.isAbsolute(spec) && win32.basename(spec).toLowerCase() === 'cmd.exe') {
		return spec
	}

	return system32Tool('cmd.exe', env)
}
