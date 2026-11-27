export interface SpoolLocation {
	pathname: string
	search: string
	hash: string
}

const EVENT = 'spool:navigation'

let cached: SpoolLocation = readLocation()

function readLocation(): SpoolLocation {
	const { pathname, search, hash } = window.location

	return { pathname, search, hash }
}

// The flag name is shared with 4.x hosts that may sit on the same page, so it keeps its old name.
function patchHistory(): void {
	const flagged = window as typeof window & { __spoolShell?: boolean }

	if (flagged.__spoolShell) return

	flagged.__spoolShell = true

	for (const method of ['pushState', 'replaceState'] as const) {
		const original = history[method].bind(history)
		history[method] = function (this: History, ...args: Parameters<History['pushState']>) {
			original(...args)
			window.dispatchEvent(new Event(EVENT))
		}
	}

	window.addEventListener('popstate', () => window.dispatchEvent(new Event(EVENT)))
}

patchHistory()

export function getLocation(): SpoolLocation {
	const next = readLocation()
	const changed =
		next.pathname !== cached.pathname ||
		next.search !== cached.search ||
		next.hash !== cached.hash

	if (changed) cached = next

	return cached
}

export function navigate(to: string, options: { replace?: boolean } = {}): void {
	history[options.replace ? 'replaceState' : 'pushState'](null, '', to)
}

interface LinkClick {
	button: number
	metaKey: boolean
	ctrlKey: boolean
	shiftKey: boolean
	altKey: boolean
	currentTarget: { pathname: string; search: string; hash: string }
	preventDefault(): void
}

/** The click handler for an `<a href>` that changes the url without a page load. A click that
 * asks the browser for a new tab or window is left to it. */
export function navigateOnClick(event: LinkClick): void {
	const isPlainClick =
		event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

	if (!isPlainClick) return

	const { pathname, search, hash } = event.currentTarget

	event.preventDefault()
	navigate(`${pathname}${search}${hash}`)
}

export function subscribe(listener: () => void): () => void {
	window.addEventListener(EVENT, listener)

	return () => {
		window.removeEventListener(EVENT, listener)
	}
}

function matchesPrefix(pathname: string, prefix: string): boolean {
	return pathname === prefix || pathname.startsWith(`${prefix.replace(/\/$/, '')}/`)
}

/** The value at the longest url prefix in `routes` that matches `pathname`. */
export function matchRoute<Name extends string>(
	pathname: string,
	routes: Record<string, Name>,
): Name | undefined {
	return Object.entries(routes)
		.filter(([prefix]) => matchesPrefix(pathname, prefix))
		.sort((a, b) => b[0].length - a[0].length)[0]?.[1]
}
