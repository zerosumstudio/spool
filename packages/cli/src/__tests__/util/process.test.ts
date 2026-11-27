/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import {
	START_TOLERANCE_MS,
	isSameProcess,
	parsePsProcess,
	parseWindowsProcess,
} from '../../util/process.js'

/*
 *   PARSING
 ***************************************************************************************************/
describe('parseWindowsProcess', () => {
	it('reads the start time and the command line', () => {
		expect(
			parseWindowsProcess(
				'2026-11-27T10:00:03.1234567Z|"C:\\node.exe" C:\\ws\\node_modules\\vite\\bin\\vite.js\r\n',
			),
		).toEqual({
			startedAt: Date.parse('2026-11-27T10:00:03.123Z'),
			commandLine: '"C:\\node.exe" C:\\ws\\node_modules\\vite\\bin\\vite.js',
		})
	})

	it('keeps a pipe that is part of the command line', () => {
		expect(parseWindowsProcess('2026-11-27T10:00:03Z|node -e "a|b"')?.commandLine).toBe(
			'node -e "a|b"',
		)
	})

	it('returns nothing for an empty answer, which means the process is gone', () => {
		expect(parseWindowsProcess('')).toBeUndefined()
		expect(parseWindowsProcess('\r\n')).toBeUndefined()
		expect(parseWindowsProcess('garbage|x')).toBeUndefined()
	})
})

describe('parsePsProcess', () => {
	it('reads lstart and the command', () => {
		expect(
			parsePsProcess('Fri Nov 27 10:00:03 2026 node /ws/node_modules/vite/bin/vite.js\n'),
		).toEqual({
			startedAt: Date.parse('2026-11-27T10:00:03Z'),
			commandLine: 'node /ws/node_modules/vite/bin/vite.js',
		})
	})

	it('copes with a single digit day, which ps pads with a space', () => {
		expect(parsePsProcess('Tue Dec  1 08:05:09 2026 node vite.js\n')?.startedAt).toBe(
			Date.parse('2026-12-01T08:05:09Z'),
		)
	})

	it('returns nothing when ps printed nothing', () => {
		expect(parsePsProcess('')).toBeUndefined()
		expect(parsePsProcess('not a date at all, just words\n')).toBeUndefined()
	})
})

/*
 *   IDENTITY
 ***************************************************************************************************/
describe('isSameProcess', () => {
	const STARTED = Date.parse('2026-11-27T10:00:00Z')
	const expected = { startedAt: STARTED, match: 'C:/ws/node_modules/vite/bin/vite.js' }
	const command = '"C:\\node.exe" C:\\ws\\node_modules\\vite\\bin\\vite.js preview'

	it('accepts the process that started when spool did and runs what spool ran', () => {
		expect(isSameProcess({ startedAt: STARTED + 600, commandLine: command }, expected)).toBe(
			true,
		)
	})

	it('compares paths across slash style and case, as Windows reports them', () => {
		expect(
			isSameProcess(
				{ startedAt: STARTED, commandLine: 'node c:/WS/node_modules/vite/bin/VITE.js' },
				expected,
			),
		).toBe(true)
	})

	it.each(['', '   ', undefined, 42])(
		'rejects a planted pidfile whose match is %j, which would sit in every command line',
		match => {
			expect(
				isSameProcess({ startedAt: STARTED, commandLine: command }, {
					startedAt: STARTED,
					match,
				} as never),
			).toBe(false)
		},
	)

	it('rejects a start time that is not a number', () => {
		expect(
			isSameProcess(
				{ startedAt: STARTED, commandLine: command },
				{ startedAt: Number.NaN, match: expected.match },
			),
		).toBe(false)
	})

	it('rejects a reused pid: the same command, started long after', () => {
		const later = STARTED + START_TOLERANCE_MS + 1

		expect(isSameProcess({ startedAt: later, commandLine: command }, expected)).toBe(false)
		expect(
			isSameProcess({ startedAt: STARTED + 24 * 3_600_000, commandLine: command }, expected),
		).toBe(false)
	})

	it('rejects a reused pid: started on time but running something else', () => {
		expect(
			isSameProcess({ startedAt: STARTED, commandLine: 'C:\\Docker\\docker.exe' }, expected),
		).toBe(false)
	})

	it('rejects a process that started before spool did', () => {
		expect(
			isSameProcess(
				{ startedAt: STARTED - START_TOLERANCE_MS - 1, commandLine: command },
				expected,
			),
		).toBe(false)
	})
})
