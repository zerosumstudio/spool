/*
 *   IMPORTS
 ***************************************************************************************************/
import { requireWorkspace } from '../core/workspace.js'
import { deployAll, type AppRunResult } from '../core/orchestrator.js'
import { withData, CliError } from '../util/errors.js'
import { ENV_NAME, splitList } from '../util/names.js'

/*
 *   DEPLOY
 ***************************************************************************************************/
export interface DeployOptions {
	only?: string
	env?: string
	json?: boolean
}

export interface DeployResult {
	results: AppRunResult[]
}

export async function deploy(opts: DeployOptions): Promise<DeployResult> {
	const ws = await requireWorkspace()
	const only = opts.only === undefined ? undefined : splitList(opts.only)
	const env = (opts.env ?? process.env.SPOOL_ENV) || undefined

	if (env !== undefined && !ENV_NAME.test(env)) {
		throw new CliError(
			`--env "${env}" is not a valid environment name. Use letters, digits, "-" and "_", starting with a letter or digit.`,
			'INVALID_VALUE',
		)
	}

	const results: AppRunResult[] = []
	try {
		await deployAll(ws, only, env, result => results.push(result))
	} catch (error) {
		throw withData(error, { results })
	}

	return { results }
}
