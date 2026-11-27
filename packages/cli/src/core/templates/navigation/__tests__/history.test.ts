// @vitest-environment jsdom
/*
 *   IMPORTS
 ***************************************************************************************************/
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HistoryModule from '../history'

/*
 *   TEST SETUP
 ***************************************************************************************************/
type Navigation = typeof HistoryModule

/** A fresh copy, as another bundle on the same page has, with the page at `path`. */
async function freshHistory(path = '/'): Promise<Navigation> {
	vi.resetModules()
	window.history.replaceState(null, '', path)

	return import('../history')
}

beforeEach(() => {
	delete (window as { __spoolShell?: boolean }).__spoolShell
})

afterEach(() => {
	vi.restoreAllMocks()
})

/*
 *   LOCATION
 ***************************************************************************************************/
describe('getLocation', () => {
	it('reads the pathname, search and hash', async () => {
		const { getLocation } = await freshHistory('/orders?id=7#top')

		expect(getLocation()).toEqual({ pathname: '/orders', search: '?id=7', hash: '#top' })
	})

	it('returns the same object until the url changes, as useSyncExternalStore needs', async () => {
		const { getLocation, navigate } = await freshHistory('/a')
		const first = getLocation()

		expect(getLocation()).toBe(first)

		navigate('/b')
		expect(getLocation()).not.toBe(first)
		expect(getLocation().pathname).toBe('/b')
	})
})

/*
 *   NAVIGATION
 ***************************************************************************************************/
describe('navigate and subscribe', () => {
	it('tells subscribers about a push, a replace and a back button', async () => {
		const { navigate, subscribe } = await freshHistory('/a')
		const listener = vi.fn()
		subscribe(listener)

		// Copies loaded by earlier tests are still patched into this window, so count only that it fired.
		for (const act of [
			() => navigate('/b'),
			() => navigate('/c', { replace: true }),
			() => window.dispatchEvent(new PopStateEvent('popstate')),
		]) {
			listener.mockClear()
			act()
			expect(listener).toHaveBeenCalled()
		}
		expect(window.location.pathname).toBe('/c')
	})

	it('stops telling a subscriber that left', async () => {
		const { navigate, subscribe } = await freshHistory('/a')
		const listener = vi.fn()

		subscribe(listener)()
		navigate('/b')

		expect(listener).not.toHaveBeenCalled()
	})

	it('patches history once however many bundles load it', async () => {
		await freshHistory('/a')
		const patched = window.history.pushState
		vi.resetModules()
		await import('../history')

		expect(window.history.pushState).toBe(patched)
	})
})

/*
 *   ROUTES
 ***************************************************************************************************/
describe('matchRoute', () => {
	const routes = { '/': 'home', '/orders': 'orders', '/orders/new': 'create' }

	it.each([
		['/', 'home'],
		['/orders', 'orders'],
		['/orders/42', 'orders'],
		['/orders/new', 'create'],
		['/orders/new/step-2', 'create'],
	])('matches %s to %s by the longest prefix', async (pathname, expected) => {
		const { matchRoute } = await freshHistory()

		expect(matchRoute(pathname, routes)).toBe(expected)
	})

	it('does not match a path that only shares the start of a prefix', async () => {
		const { matchRoute } = await freshHistory()

		expect(matchRoute('/ordersx', { '/orders': 'orders' })).toBeUndefined()
		expect(matchRoute('/elsewhere', { '/orders': 'orders' })).toBeUndefined()
	})
})
