/*
 *   IMPORTS
 ***************************************************************************************************/
import { requireWorkspace } from '../core/workspace.js'
import { devAll, killRunning, type RestSpec } from '../core/orchestrator.js'
import { emitRemoteTypes } from '../core/types.js'
import { syncRemoteTypings } from '../core/typings.js'
import { CliError } from '../util/errors.js'
import { ENV_NAME, splitList } from '../util/names.js'

/*
 *   DEV
 ***************************************************************************************************/
export interface DevOptions {
	only?: string
	rest?: string
	timeout?: string
	ladle?: boolean
	kill?: boolean
}

/** `built` previews dist folders; `env:<name>` points at a deployed environment. */
export function parseRest(value: string): RestSpec {
	if (value === 'built') return { kind: 'built' }

	const env = value.startsWith('env:') ? value.slice(4) : undefined
	if (env !== undefined && ENV_NAME.test(env)) return { kind: 'env', env }

	throw new CliError(`--rest takes "built" or "env:<name>", not "${value}".`, 'INVALID_VALUE')
}

function parseTimeout(value: string): number {
	const seconds = Number(value)
	if (!Number.isFinite(seconds) || seconds <= 0) {
		throw new CliError(
			`--timeout needs a positive number of seconds, not "${value}".`,
			'INVALID_VALUE',
		)
	}
	return seconds
}

export async function dev(opts: DevOptions): Promise<void> {
	const ws = await requireWorkspace()

	if (opts.kill) {
		await killRunning(ws, 'dev')
		return
	}

	const only = opts.only === undefined ? undefined : splitList(opts.only)
	await emitRemoteTypes(ws.root, ws.manifest, only)
	await syncRemoteTypings(ws)

	await devAll(ws, {
		...(only !== undefined ? { only } : {}),
		...(opts.rest !== undefined ? { rest: parseRest(opts.rest) } : {}),
		...(opts.timeout !== undefined ? { timeoutSeconds: parseTimeout(opts.timeout) } : {}),
		...(opts.ladle !== undefined ? { ladle: opts.ladle } : {}),
	})
}
