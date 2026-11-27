/*
 *   IMPORTS
 ***************************************************************************************************/
import { CliError, errorCodeOf, type ErrorCode } from './errors.js'

/*
 *   JSON FILES
 ***************************************************************************************************/
export const formatJson = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** A copy of `record` without `key`, keeping the order of the other keys. */
export function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
	return Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))
}

/**
 * Makes `target` hold exactly the keys of `source`. JSON edits mutate the object they are given,
 * so a whole-document rewrite has to happen in place.
 */
export function replaceContents(
	target: Record<string, unknown>,
	source: Record<string, unknown>,
): void {
	for (const key of Object.keys(target)) {
		// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- emptying the document before it is refilled
		delete target[key]
	}

	Object.assign(target, source)
}

/*
 *   --JSON DOCUMENTS
 ***************************************************************************************************/
/**
 * A `--json` run prints exactly one of these to stdout and nothing else.
 * Logs, warnings and progress go to stderr. Commands add their own fields
 * (`results`, `problems`, ...) next to `ok` and `command`.
 */
export type JsonDocument = JsonSuccess | JsonFailure

export type JsonSuccess = { ok: true; command: string } & Record<string, unknown>

export type JsonFailure = {
	ok: false
	command: string
	error: { code: ErrorCode; message: string }
} & Record<string, unknown>

export function successDocument(command: string, fields: object = {}): JsonSuccess {
	return { ...fields, ok: true, command }
}

/** A failure keeps whatever the error carries (a failed build still lists its results). */
export function failureDocument(command: string, error: unknown): JsonFailure {
	const message = error instanceof Error ? error.message : String(error)
	const data = error instanceof CliError ? error.data : undefined

	return { ...data, ok: false, command, error: { code: errorCodeOf(error), message } }
}
