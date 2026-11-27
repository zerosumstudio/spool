/*
 *   EXIT CODES
 ***************************************************************************************************/
export const EXIT = {
	ok: 0,
	failure: 1,
	usage: 2,
	cancelled: 130,
} as const

/*
 *   ERROR CODES
 ***************************************************************************************************/
/** Bad input from the caller: exits 2, so scripts can tell it apart from a real failure. */
export const USAGE_ERROR_CODES = [
	'USAGE',
	'INVALID_NAME',
	'INVALID_PATH',
	'INVALID_VALUE',
	'INPUT_REQUIRED',
	'CONFIRMATION_REQUIRED',
] as const

export const FAILURE_ERROR_CODES = [
	'NO_WORKSPACE',
	'MANIFEST_INVALID',
	'MANIFEST_VERSION',
	'APP_NOT_FOUND',
	'TARGET_EXISTS',
	'TARGET_NOT_EMPTY',
	'UNSAFE_PATH',
	'BUILD_FAILED',
	'DEPLOY_FAILED',
	'PORT_IN_USE',
	'CHECK_FAILED',
	'FAILED',
	'INTERNAL',
] as const

export const ERROR_CODES = [...USAGE_ERROR_CODES, ...FAILURE_ERROR_CODES, 'CANCELLED'] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

const USAGE_CODES: ReadonlySet<ErrorCode> = new Set(USAGE_ERROR_CODES)

/*
 *   ERRORS
 ***************************************************************************************************/
/**
 * An error whose message is shown to the user as-is. The entry point prints it
 * without a stack trace and exits with `exitCodeFor(error)`. `data` is merged
 * into the `--json` document, so a failed build can still report its results.
 */
export class CliError extends Error {
	readonly code: ErrorCode
	readonly data: Readonly<Record<string, unknown>> | undefined

	constructor(message: string, code: ErrorCode = 'FAILED', data?: Record<string, unknown>) {
		super(message)
		this.name = 'CliError'
		this.code = code
		this.data = data
	}
}

/** Anything that is not a CliError is a bug in spool, and reports as INTERNAL. */
export function errorCodeOf(error: unknown): ErrorCode {
	return error instanceof CliError ? error.code : 'INTERNAL'
}

export function exitCodeFor(error: unknown): number {
	const code = errorCodeOf(error)

	if (code === 'CANCELLED') return EXIT.cancelled
	if (USAGE_CODES.has(code)) return EXIT.usage
	return EXIT.failure
}

/** Adds fields to a CliError's `--json` data, so a failed run can still report partial results. */
export function withData(error: unknown, data: Record<string, unknown>): unknown {
	if (!(error instanceof CliError)) return error

	return new CliError(error.message, error.code, { ...error.data, ...data })
}
