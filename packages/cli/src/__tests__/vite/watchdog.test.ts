/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/*
 *   SETUP
 ***************************************************************************************************/
beforeEach(() => {
	vi.useFakeTimers()
	// The watchdog runs once per process, so every test gets a fresh module.
	vi.resetModules()
})

afterEach(() => {
	vi.useRealTimers()
})

async function load() {
	return (await import('../../vite/watchdog.js')).watchParent
}

/*
 *   WATCH PARENT
 ***************************************************************************************************/
describe('watchParent', () => {
	it('exits 0 once the parent process is gone', async () => {
		const watchParent = await load()
		const exit = vi.fn()
		let alive = true

		watchParent({ SPOOL_PARENT_PID: '4321' }, exit, () => alive)
		await vi.advanceTimersByTimeAsync(3000)
		expect(exit).not.toHaveBeenCalled()

		alive = false
		await vi.advanceTimersByTimeAsync(1000)
		expect(exit).toHaveBeenCalledWith(0)
	})

	it('asks about the pid spool recorded, and only that one', async () => {
		const watchParent = await load()
		const isAlive = vi.fn(() => true)

		watchParent({ SPOOL_PARENT_PID: '4321' }, vi.fn(), isAlive)
		await vi.advanceTimersByTimeAsync(1000)

		expect(isAlive).toHaveBeenCalledWith(4321)
	})

	it('does nothing without SPOOL_PARENT_PID, as in a plain vite run', async () => {
		const watchParent = await load()
		const exit = vi.fn()
		const isAlive = vi.fn(() => false)

		watchParent({}, exit, isAlive)
		await vi.advanceTimersByTimeAsync(5000)

		expect(isAlive).not.toHaveBeenCalled()
		expect(exit).not.toHaveBeenCalled()
	})

	it('ignores a pid that is not a positive whole number', async () => {
		const watchParent = await load()
		const exit = vi.fn()

		for (const value of ['abc', '0', '-4', '1.5']) {
			watchParent({ SPOOL_PARENT_PID: value }, exit, () => false)
		}
		await vi.advanceTimersByTimeAsync(5000)

		expect(exit).not.toHaveBeenCalled()
	})

	it('starts one timer however often a config is loaded', async () => {
		const watchParent = await load()
		const isAlive = vi.fn(() => true)

		watchParent({ SPOOL_PARENT_PID: '9' }, vi.fn(), isAlive)
		watchParent({ SPOOL_PARENT_PID: '9' }, vi.fn(), isAlive)
		await vi.advanceTimersByTimeAsync(1000)

		expect(isAlive).toHaveBeenCalledTimes(1)
	})
})
