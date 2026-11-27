/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, afterEach } from 'vitest'
import { log } from '../../util/logger.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
afterEach(() => {
	vi.restoreAllMocks()
})

/*
 *   LOG
 ***************************************************************************************************/
describe('log', () => {
	it('writes info, step, success and warn through console.log', () => {
		const out = vi.spyOn(console, 'log').mockImplementation(() => {})
		log.info('hi')
		log.step('walk')
		log.success('done')
		log.warn('careful')
		log.plain('raw')
		expect(out).toHaveBeenCalledTimes(5)
	})

	it('writes errors through console.error', () => {
		const err = vi.spyOn(console, 'error').mockImplementation(() => {})
		log.error('boom')
		expect(err).toHaveBeenCalledOnce()
	})
})
