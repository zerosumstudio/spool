/*
 *   IMPORTS
 ***************************************************************************************************/
import { requireWorkspace } from '../core/workspace.js'
import { buildAll, type AppRunResult } from '../core/orchestrator.js'
import { emitRemoteTypes } from '../core/types.js'
import { syncRemoteTypings } from '../core/typings.js'
import { withData, CliError } from '../util/errors.js'
import { splitList } from '../util/names.js'

/*
 *   BUILD
 ***************************************************************************************************/
export interface BuildOptions {
	only?: string
	env?: string
	concurrency?: string
	json?: boolean
}

export interface BuildResult {
	results: AppRunResult[]
}

export async function build(opts: BuildOptions): Promise<BuildResult> {
	const ws = await requireWorkspace()
	const only = opts.only === undefined ? undefined : splitList(opts.only)
	// The generated helper reads SPOOL_ENV, so an exported var counts like --env.
	const env = (opts.env ?? process.env.SPOOL_ENV) || undefined
	const concurrency = opts.concurrency === undefined ? undefined : Number(opts.concurrency)

	if (concurrency !== undefined && (!Number.isInteger(concurrency) || concurrency < 1)) {
		throw new CliError(
			`--concurrency needs a whole number of 1 or more, not "${opts.concurrency ?? ''}".`,
			'INVALID_VALUE',
		)
	}

	await emitRemoteTypes(ws.root, ws.manifest, only)
	await syncRemoteTypings(ws)

	const results: AppRunResult[] = []
	try {
		await buildAll(ws, {
			...(only ? { only } : {}),
			...(env ? { env } : {}),
			...(concurrency === undefined ? {} : { concurrency }),
			onResult: result => results.push(result),
		})
	} catch (error) {
		throw withData(error, { results })
	}

	return { results }
}
