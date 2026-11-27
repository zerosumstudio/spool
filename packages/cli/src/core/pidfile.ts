/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from './workspace.js'
import type { ServeMode } from './output.js'
import type { ExpectedProcess } from '../util/process.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface TrackedChild extends Partial<ExpectedProcess> {
	name: string
	port: number
	pid: number
}

export interface Pidfile {
	parentPid: number
	/** How to recognise the spool process that wrote this file. */
	parent?: ExpectedProcess
	startedAt: string
	/**
	 * A child without `startedAt` and `match` comes from a spool that did not record
	 * them, so `--kill` cannot tell it from a process that reused its pid.
	 */
	children: TrackedChild[]
}

/*
 *   PATH
 ***************************************************************************************************/
export function pidfilePath(ws: Workspace, mode: ServeMode): string {
	return join(ws.root, '.spool', `${mode}.pid`)
}

/*
 *   READ / WRITE
 ***************************************************************************************************/
/** This process, as `--kill` can later recognise it: when it started and the script it runs. */
export function currentProcess(): ExpectedProcess {
	return {
		startedAt: Date.now() - Math.round(process.uptime() * 1000),
		match: process.argv[1] ?? process.execPath,
	}
}

/** Overwrites the pidfile with the current set of tracked children. */
export function writePidfile(ws: Workspace, mode: ServeMode, children: TrackedChild[]): void {
	const data: Pidfile = {
		parentPid: process.pid,
		parent: currentProcess(),
		startedAt: new Date().toISOString(),
		children,
	}

	mkdirSync(join(ws.root, '.spool'), { recursive: true })
	writeFileSync(pidfilePath(ws, mode), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export function readPidfile(ws: Workspace, mode: ServeMode): Pidfile | undefined {
	const target = pidfilePath(ws, mode)
	if (!existsSync(target)) return undefined

	try {
		return JSON.parse(readFileSync(target, 'utf8')) as Pidfile
	} catch {
		return undefined
	}
}

export function removePidfile(ws: Workspace, mode: ServeMode): void {
	rmSync(pidfilePath(ws, mode), { force: true })
}
