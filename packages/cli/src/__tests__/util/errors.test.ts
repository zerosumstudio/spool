/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import {
	CliError,
	ERROR_CODES,
	EXIT,
	USAGE_ERROR_CODES,
	errorCodeOf,
	exitCodeFor,
	withData,
} from '../../util/errors.js'
import { failureDocument, successDocument } from '../../util/json.js'

/*
 *   EXIT CODES
 ***************************************************************************************************/
describe('exitCodeFor', () => {
	it('exits 2 for every usage code, 130 for a cancel and 1 for the rest', () => {
		const usage: readonly string[] = USAGE_ERROR_CODES

		for (const code of ERROR_CODES) {
			let expected: number = EXIT.failure
			if (code === 'CANCELLED') expected = EXIT.cancelled
			else if (usage.includes(code)) expected = EXIT.usage

			expect(exitCodeFor(new CliError('x', code))).toBe(expected)
		}
	})

	it('treats anything that is not a CliError as an INTERNAL failure', () => {
		expect(errorCodeOf(new Error('boom'))).toBe('INTERNAL')
		expect(exitCodeFor(new Error('boom'))).toBe(EXIT.failure)
	})

	it('defaults a CliError to FAILED', () => {
		expect(new CliError('x').code).toBe('FAILED')
	})
})

/*
 *   DOCUMENTS
 ***************************************************************************************************/
describe('--json documents', () => {
	it('puts ok and command on a success, after the command fields', () => {
		expect(successDocument('build', { results: [], ok: false })).toEqual({
			results: [],
			ok: true,
			command: 'build',
		})
	})

	it('puts the code and message under error, and keeps the error data', () => {
		const error = withData(new CliError('nope', 'BUILD_FAILED'), { results: [1] })

		expect(failureDocument('build', error)).toEqual({
			results: [1],
			ok: false,
			command: 'build',
			error: { code: 'BUILD_FAILED', message: 'nope' },
		})
	})

	it('reports a plain Error as INTERNAL', () => {
		expect(failureDocument('x', new Error('boom')).error).toEqual({
			code: 'INTERNAL',
			message: 'boom',
		})
	})
})
