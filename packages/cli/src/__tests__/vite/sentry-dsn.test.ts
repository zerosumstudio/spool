/*
 *   IMPORTS
 ***************************************************************************************************/
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { parseManifest } from '../../core/config.js'
import { resolveDsn, sentryConnectOrigins } from '../../vite/sentry-dsn.js'
import { freshDir, host, removeDir } from '../helpers.js'

/*
 *   FIXTURE
 ***************************************************************************************************/
const DSN = 'https://pubkey@o1.ingest.sentry.io/1'
const withSentry = parseManifest({
	name: 'acme',
	version: 2,
	addons: ['sentry'],
	apps: { shell: host() },
})
const without = parseManifest({ name: 'acme', version: 2, apps: { shell: host() } })

let dir: string

beforeEach(() => {
	dir = freshDir()
})

afterEach(() => removeDir(dir))

/*
 *   DSN
 ***************************************************************************************************/
describe('sentryConnectOrigins', () => {
	it('is the ingest origin of the DSN in the environment', () => {
		expect(
			sentryConnectOrigins(withSentry, dir, 'production', { VITE_SENTRY_DSN: DSN }),
		).toEqual(['https://o1.ingest.sentry.io'])
	})

	it('reads the DSN from the app dotenv files the way vite loads them', () => {
		writeFileSync(join(dir, '.env'), 'VITE_SENTRY_DSN=https://a@one.example/1\n')
		writeFileSync(join(dir, '.env.production'), `VITE_SENTRY_DSN="${DSN}"\n`)

		expect(resolveDsn(dir, 'production', {})).toBe(DSN)
		expect(resolveDsn(dir, 'development', {})).toBe('https://a@one.example/1')
	})

	it('adds nothing without the sentry addon, without a DSN, or for a bad one', () => {
		expect(sentryConnectOrigins(without, dir, 'production', { VITE_SENTRY_DSN: DSN })).toEqual(
			[],
		)
		expect(sentryConnectOrigins(withSentry, dir, 'production', {})).toEqual([])
		expect(
			sentryConnectOrigins(withSentry, dir, 'production', { VITE_SENTRY_DSN: 'not a url' }),
		).toEqual([])
		expect(
			sentryConnectOrigins(withSentry, dir, 'production', {
				VITE_SENTRY_DSN: 'javascript:1',
			}),
		).toEqual([])
	})
})
