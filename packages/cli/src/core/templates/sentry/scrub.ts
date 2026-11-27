/*
 * What leaves the browser in a Sentry event. A url can carry a token, an email or an id in its
 * query string or fragment, and the Referer header and navigation breadcrumbs repeat it, so
 * every url is cut to its origin and path before it is sent. Pure on purpose: nothing here reads
 * the page or the Sentry client.
 */

/*
 *   TYPES
 ***************************************************************************************************/
interface ScrubbableRequest {
	url?: string
	query_string?: unknown
	headers?: Record<string, string>
}

interface ScrubbableException {
	value?: string
}

export interface ScrubbableEvent {
	request?: ScrubbableRequest
	message?: string
	exception?: { values?: ScrubbableException[] }
	contexts?: Record<string, Record<string, unknown> | undefined>
}

export interface ScrubbableBreadcrumb {
	message?: string
	data?: Record<string, unknown>
}

/*
 *   URLS
 ***************************************************************************************************/
const BREADCRUMB_URL_KEYS = ['url', 'from', 'to']
const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:/i
// An http(s) url inside prose, up to the first space, quote or bracket.
const URL_IN_TEXT = /https?:\/\/[^\s"'<>()[\]{}]+/gi
const TRAILING_PUNCTUATION = /[.,;:!?]+$/
// Only used to read a relative url; none of it ever reaches the result.
const PLACEHOLDER_BASE = 'http://spool.invalid'

/** `value` as origin plus path: no query string, no fragment, no credentials. A relative url
 * keeps just its path, and a scheme that has no origin (data:, blob:) keeps nothing but itself. */
export function trimUrl(value: string): string {
	let url: URL
	try {
		url = new URL(value, PLACEHOLDER_BASE)
	} catch {
		return ''
	}

	if (!ABSOLUTE_URL.test(value)) return url.pathname

	if (url.protocol !== 'http:' && url.protocol !== 'https:') return url.protocol

	return `${url.origin}${url.pathname}`
}

/** `text` with every http(s) url in it cut to origin and path, as in an error message like
 * "Failed to fetch https://api.example.com/users?token=abc". */
export function trimUrlsIn(text: string): string {
	return text.replace(URL_IN_TEXT, found => {
		const punctuation = TRAILING_PUNCTUATION.exec(found)?.[0] ?? ''
		const url = punctuation ? found.slice(0, -punctuation.length) : found

		return `${trimUrl(url) || url}${punctuation}`
	})
}

/*
 *   BREADCRUMBS
 ***************************************************************************************************/
export function scrubBreadcrumb<Breadcrumb extends ScrubbableBreadcrumb>(
	breadcrumb: Breadcrumb,
): Breadcrumb {
	const changes: ScrubbableBreadcrumb = {}

	if (breadcrumb.message !== undefined) changes.message = trimUrlsIn(breadcrumb.message)

	const { data } = breadcrumb

	if (data) {
		const scrubbed: Record<string, unknown> = { ...data }
		for (const key of BREADCRUMB_URL_KEYS) {
			const value = scrubbed[key]

			if (typeof value === 'string') scrubbed[key] = trimUrl(value)
		}

		changes.data = scrubbed
	}

	return { ...breadcrumb, ...changes }
}

/*
 *   EVENTS
 ***************************************************************************************************/
function removeReferer(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'referer'),
	)
}

function scrubRequest(request: ScrubbableRequest): ScrubbableRequest {
	const scrubbed: ScrubbableRequest = { ...request }
	delete scrubbed.query_string

	if (scrubbed.url !== undefined) scrubbed.url = trimUrl(scrubbed.url)

	if (scrubbed.headers) scrubbed.headers = removeReferer(scrubbed.headers)

	return scrubbed
}

function scrubExceptions(values: ScrubbableException[]): ScrubbableException[] {
	return values.map(exception =>
		exception.value === undefined
			? exception
			: { ...exception, value: trimUrlsIn(exception.value) },
	)
}

/** The Vue SDK attaches a component's props to the event. They are the user's data, whatever
 * `attachProps` says, so they are removed here too. */
function removeVueProps(
	contexts: Record<string, Record<string, unknown> | undefined>,
): Record<string, Record<string, unknown> | undefined> {
	const { vue } = contexts

	if (!vue || !('propsData' in vue)) return contexts

	const rest = { ...vue }
	delete rest.propsData

	return { ...contexts, vue: rest }
}

/** An error event with its urls cut to origin and path (in the request, in exception and event
 * messages), its query string and Referer header removed, and no Vue props. */
export function scrubEvent<Payload extends ScrubbableEvent>(event: Payload): Payload {
	const changes: ScrubbableEvent = {}

	if (event.request) changes.request = scrubRequest(event.request)

	if (event.message !== undefined) changes.message = trimUrlsIn(event.message)

	if (event.exception?.values) {
		changes.exception = { ...event.exception, values: scrubExceptions(event.exception.values) }
	}

	if (event.contexts) changes.contexts = removeVueProps(event.contexts)

	return { ...event, ...changes }
}
