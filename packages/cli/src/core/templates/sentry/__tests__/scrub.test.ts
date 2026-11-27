/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, expect, it } from 'vitest'
import { scrubBreadcrumb, scrubEvent, trimUrl, trimUrlsIn } from '../scrub'

/*
 *   URLS
 ***************************************************************************************************/
describe('trimUrl', () => {
	it.each([
		['https://app.example.com/orders/42?token=abc#frag', 'https://app.example.com/orders/42'],
		['https://app.example.com/?email=a@b.co', 'https://app.example.com/'],
		['http://localhost:5173/a/b?x=1', 'http://localhost:5173/a/b'],
		['https://user:secret@app.example.com/p?q=1', 'https://app.example.com/p'],
		['https://app.example.com:8443/p#only-a-fragment', 'https://app.example.com:8443/p'],
		['https://app.example.com', 'https://app.example.com/'],
	])('cuts %s to origin and path', (value, expected) => {
		expect(trimUrl(value)).toBe(expected)
	})

	it.each([
		['/orders/42?token=abc#frag', '/orders/42'],
		['/', '/'],
		['/a?b=c', '/a'],
		['?only=query', '/'],
		['#only-a-fragment', '/'],
	])('keeps only the path of a relative url: %s', (value, expected) => {
		expect(trimUrl(value)).toBe(expected)
	})

	it.each([
		['data:text/plain;base64,c2VjcmV0', 'data:'],
		['blob:https://app.example.com/6f0c', 'blob:'],
		['javascript:alert(document.cookie)', 'javascript:'],
	])('keeps only the scheme of one with no origin: %s', (value, expected) => {
		expect(trimUrl(value)).toBe(expected)
	})

	it('returns nothing for text that is not a url at all', () => {
		expect(trimUrl('http://')).toBe('')
	})
})

/*
 *   BREADCRUMBS
 ***************************************************************************************************/
describe('scrubBreadcrumb', () => {
	it('trims url, from and to, whatever else the data holds', () => {
		const breadcrumb = {
			category: 'navigation',
			data: { from: '/a?x=1', to: '/b?y=2#z', status_code: 200, method: 'GET' },
		}

		expect(scrubBreadcrumb(breadcrumb)).toEqual({
			category: 'navigation',
			data: { from: '/a', to: '/b', status_code: 200, method: 'GET' },
		})
	})

	it('trims the url of a fetch or xhr breadcrumb', () => {
		const breadcrumb = { data: { url: 'https://api.example.com/users?id=7&token=t' } }

		expect(scrubBreadcrumb(breadcrumb).data.url).toBe('https://api.example.com/users')
	})

	it('leaves non-string values and a breadcrumb with no data alone', () => {
		const odd = { data: { url: 42, from: undefined, to: null } }

		expect(scrubBreadcrumb(odd).data).toEqual({ url: 42, from: undefined, to: null })
		const bare: { message: string; data?: Record<string, unknown> } = { message: 'hi' }

		expect(scrubBreadcrumb(bare)).toEqual({ message: 'hi' })
	})

	it('cuts the urls in a breadcrumb message', () => {
		const breadcrumb = { message: 'GET https://api.example.com/users?id=7 200' }

		expect(scrubBreadcrumb(breadcrumb).message).toBe('GET https://api.example.com/users 200')
	})

	it('does not change what it was given', () => {
		const data = { url: 'https://a.example/p?q=1' }
		const breadcrumb = { data }

		scrubBreadcrumb(breadcrumb)

		expect(breadcrumb.data).toBe(data)
		expect(data.url).toBe('https://a.example/p?q=1')
	})
})

/*
 *   EVENTS
 ***************************************************************************************************/
describe('trimUrlsIn', () => {
	it.each([
		[
			'Failed to fetch https://api.example.com/users?token=abc#top',
			'Failed to fetch https://api.example.com/users',
		],
		[
			'GET https://a.example/p?x=1 and http://b.example:8080/q?y=2 failed',
			'GET https://a.example/p and http://b.example:8080/q failed',
		],
		['see (https://a.example/p?x=1).', 'see (https://a.example/p).'],
		['load "https://a.example/p?x=1" failed', 'load "https://a.example/p" failed'],
		['ended at https://a.example/p?x=1.', 'ended at https://a.example/p.'],
		['no urls here, just user@example.com', 'no urls here, just user@example.com'],
	])('cuts the urls in %j', (text, expected) => {
		expect(trimUrlsIn(text)).toBe(expected)
	})
})

describe('scrubEvent', () => {
	const event = {
		message: 'boom',
		request: {
			url: 'https://app.example.com/orders/42?token=abc#frag',
			query_string: 'token=abc',
			method: 'GET',
			headers: {
				Referer: 'https://app.example.com/settings?email=a@b.co',
				'User-Agent': 'jsdom',
			},
		},
	}

	it('trims the request url, drops the query string and the Referer header', () => {
		expect(scrubEvent(event).request).toEqual({
			url: 'https://app.example.com/orders/42',
			method: 'GET',
			headers: { 'User-Agent': 'jsdom' },
		})
	})

	it.each(['referer', 'REFERER', 'Referer'])('drops the %s header whatever its case', name => {
		const scrubbed = scrubEvent({ request: { headers: { [name]: 'https://x.example/?a=b' } } })

		expect(scrubbed.request?.headers).toEqual({})
	})

	it('drops a query string given as an object or a list', () => {
		expect(scrubEvent({ request: { query_string: { token: 'abc' } } }).request).toEqual({})
		expect(scrubEvent({ request: { query_string: [['token', 'abc']] } }).request).toEqual({})
	})

	it('keeps the rest of the event, and an event with no request', () => {
		expect(scrubEvent(event).message).toBe('boom')
		const bare: { message: string; request?: { url?: string } } = { message: 'no request' }

		expect(scrubEvent(bare)).toEqual({ message: 'no request' })
	})

	it('cuts the urls in exception values and the event message', () => {
		const scrubbed = scrubEvent({
			message: 'blocked https://app.example.com/a?token=1',
			exception: {
				values: [
					{ value: 'Failed to fetch https://api.example.com/users?email=a@b.co' },
					{},
				],
			},
		})

		expect(scrubbed.message).toBe('blocked https://app.example.com/a')
		expect(scrubbed.exception?.values).toEqual([
			{ value: 'Failed to fetch https://api.example.com/users' },
			{},
		])
	})

	it('removes the props the vue SDK attaches, and nothing else in the vue context', () => {
		const scrubbed = scrubEvent({
			contexts: {
				vue: {
					componentName: 'Form',
					lifecycleHook: 'setup',
					propsData: { email: 'a@b.co' },
				},
				device: { family: 'Desktop' },
			},
		})

		expect(scrubbed.contexts).toEqual({
			vue: { componentName: 'Form', lifecycleHook: 'setup' },
			device: { family: 'Desktop' },
		})
	})

	it('leaves contexts with no vue props as they were', () => {
		const contexts = { vue: { componentName: 'Form' } }

		expect(scrubEvent({ contexts }).contexts).toBe(contexts)
	})

	it('does not change what it was given', () => {
		const copy = structuredClone(event)

		scrubEvent(event)

		expect(event).toEqual(copy)
	})
})
