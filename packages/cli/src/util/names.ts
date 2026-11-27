/*
 *   CASING
 ***************************************************************************************************/
/** PascalCase an app name for use as a React component identifier. */
export function pascalCase(name: string): string {
	return name
		.split(/[-_ ]+/)
		.filter(Boolean)
		.map(word => word.charAt(0).toUpperCase() + word.slice(1))
		.join('')
}

/** camelCase an app name for use as a variable identifier. */
export function camelCase(name: string): string {
	const pascal = pascalCase(name)
	return pascal.charAt(0).toLowerCase() + pascal.slice(1)
}

/** "@scope/pkg/subpath" and "pkg/subpath" resolve to the installable package. */
export function packageName(specifier: string): string {
	const parts = specifier.split('/')
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier)
}

/** Env var that overrides where hosts load a remote from, e.g. SPOOL_REMOTE_MY_APP. */
export function remoteEnvVar(name: string): string {
	return `SPOOL_REMOTE_${name.toUpperCase().replace(/-/g, '_')}`
}

/** YAML keys starting with a reserved indicator (like @scope) need quoting. */
export const yamlKey = (name: string): string => (name.startsWith('@') ? `'${name}'` : name)

/** Splits a comma-separated list, dropping empty entries. */
export function splitList(value: string): string[] {
	return value
		.split(',')
		.map(item => item.trim())
		.filter(Boolean)
}

/*
 *   NAMES
 ***************************************************************************************************/
/**
 * Workspace and app names become folder names, npm package names, federation
 * container names and (via PascalCase) React component identifiers. Restrict
 * them to a safe, portable subset: lowercase, starts with a letter, single
 * hyphens between segments. This also blocks path traversal (`..`, slashes).
 */
export const NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export const MAX_NAME_LENGTH = 64

/**
 * Windows treats these as devices in any folder, with any extension, and with spaces or
 * dots after the name (`con .txt`, `con.`), so a workspace holding one cannot be cloned
 * there. Banned on every OS.
 */
const DEVICE_NAME =
	/^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9¹²³]|lpt[0-9¹²³])[\s.]*(?:\..*)?$/i

/**
 * A remote `name` is imported as `name/<expose>`, so an app that shares a
 * package's name would shadow it. The manifest's own `shared` list adds to these.
 */
export const SHARED_PACKAGE_NAMES: readonly string[] = [
	'react',
	'react-dom',
	'vue',
	'svelte',
	'vite',
]

export interface NameOptions {
	/** Packages the workspace shares, from `spool.json`. */
	shared?: readonly string[]
}

export function isDeviceName(segment: string): boolean {
	return DEVICE_NAME.test(segment)
}

/** Returns an error message if `value` is not a valid name, else undefined. */
export function validateName(
	value: string,
	label = 'name',
	options: NameOptions = {},
): string | undefined {
	const trimmed = value.trim()

	if (!trimmed) return `Please enter a ${label}.`
	if (trimmed !== value) {
		return `Invalid ${label} "${value}": remove the spaces around it.`
	}
	if (trimmed.length > MAX_NAME_LENGTH) {
		return `Invalid ${label}: at most ${MAX_NAME_LENGTH} characters.`
	}
	if (!NAME_PATTERN.test(trimmed)) {
		return `Invalid ${label} "${value}". Use lowercase letters, digits and single hyphens, starting with a letter (e.g. "dashboard").`
	}
	if (isDeviceName(trimmed)) {
		return `Invalid ${label} "${value}": Windows reserves it as a device name, so the workspace could not be cloned there.`
	}

	const shared = [...SHARED_PACKAGE_NAMES, ...(options.shared ?? [])]
	if (shared.includes(trimmed)) {
		return `Invalid ${label} "${value}": it is the name of a shared package, and "${trimmed}/<module>" would clash with it.`
	}

	return undefined
}

/*
 *   PATHS
 ***************************************************************************************************/
/** An app's folder, relative to the workspace root. No `.`, `..`, uppercase or odd characters. */
export const APP_PATH_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/

/** The module an expose points at, relative to its app. */
export const EXPOSE_SOURCE_PATTERN = /^(?:\.\/)?[A-Za-z0-9_][\w.-]*(\/[A-Za-z0-9_][\w.-]*)*$/

/** An expose key: `./` and a path, which a host imports as `remote/<key>`. */
export const EXPOSE_KEY_PATTERN = /^\.\/[A-Za-z0-9_][\w.-]*(\/[A-Za-z0-9_][\w.-]*)*$/

// eslint-disable-next-line no-control-regex -- control characters are what this rejects
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/
const FORBIDDEN_SEGMENT_CHARACTER = /[<>:"|?*]/

/**
 * True for a relative path that stays inside the folder it is joined to.
 * Rejects absolute paths, UNC (`\\server\share`), drive-relative paths (`C:foo`),
 * `:` anywhere (an NTFS alternate data stream, `a:b`), control characters and `..`.
 */
export function isConfinedPath(value: string): boolean {
	if (!value || CONTROL_CHARACTER.test(value)) return false
	if (value.startsWith('/') || value.startsWith('\\') || value.includes(':')) return false

	return !value.split(/[\\/]/).some(segment => segment === '..')
}

/** True for a single folder or file name that Windows and POSIX both accept as-is. */
export function isSafeSegment(segment: string): boolean {
	if (!segment || segment === '..' || isDeviceName(segment)) return false
	if (CONTROL_CHARACTER.test(segment) || FORBIDDEN_SEGMENT_CHARACTER.test(segment)) return false

	return segment === '.' || !/[. ]$/.test(segment)
}

/** Returns an error message if `path` is not a valid app folder, else undefined. */
export function validateAppPath(path: string): string | undefined {
	if (!isConfinedPath(path) || path.endsWith('/')) {
		return `"${path}" must be a relative path inside the workspace, with no "..", no drive or UNC prefix and no trailing slash.`
	}
	if (!APP_PATH_PATTERN.test(path)) {
		return `"${path}" may only use lowercase letters, digits, ".", "_" and "-", in folders separated by "/".`
	}

	return path.split('/').every(isSafeSegment)
		? undefined
		: `"${path}" has a segment Windows reserves or cannot store.`
}

/** Returns an error message if `source` is not a valid expose source, else undefined. */
export function validateExposeSource(source: string): string | undefined {
	if (!isConfinedPath(source) || !EXPOSE_SOURCE_PATTERN.test(source)) {
		return `"${source}" must be a relative file path inside the app, like "./src/app.tsx".`
	}

	return source.split('/').every(isSafeSegment)
		? undefined
		: `"${source}" has a segment Windows reserves or cannot store.`
}

const UNC_OR_DEVICE_PATH = /^(?:\\\\|\/\/)/
const DRIVE_ROOT = /^[a-zA-Z]:[\\/]/
const DRIVE_RELATIVE = /^[a-zA-Z]:/

/**
 * Returns an error message if `dir`, as typed after `spool create`, is unsafe to
 * create. Relative paths may nest but never climb; absolute drive and POSIX
 * paths are the caller's explicit choice; UNC and `\\?\` device paths are not.
 */
export function validateDirArgument(dir: string): string | undefined {
	if (!dir.trim()) return 'Please enter a folder.'
	if (CONTROL_CHARACTER.test(dir)) return `Invalid folder "${dir}".`
	if (UNC_OR_DEVICE_PATH.test(dir)) {
		return `Invalid folder "${dir}": network and device paths are not allowed.`
	}
	if (!DRIVE_ROOT.test(dir) && DRIVE_RELATIVE.test(dir)) {
		return `Invalid folder "${dir}": a drive-relative path is ambiguous.`
	}

	const rest = DRIVE_ROOT.test(dir) ? dir.slice(3) : dir
	const bad = rest
		.split(/[\\/]/)
		.filter(Boolean)
		.find(segment => !isSafeSegment(segment))

	return bad === undefined
		? undefined
		: `Invalid folder "${dir}": "${bad}" is not allowed (parent folders, Windows device names and special characters are rejected).`
}

/*
 *   HEADERS AND URLS
 ***************************************************************************************************/
export const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/

/** A header value must stay on one line: CR, LF and other control characters split a header file. */
export function isSafeHeaderValue(value: string): boolean {
	// eslint-disable-next-line no-control-regex -- control characters are what this rejects
	return !/[\x00-\x08\x0a-\x1f\x7f]/.test(value)
}

/** A CSP source expression: no whitespace, `;` or `,`, which would add directives or sources. */
export function isSafeCspSource(value: string): boolean {
	return value !== '' && !/[\s;,]/.test(value) && !CONTROL_CHARACTER.test(value)
}

export function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value)

		return url.protocol === 'http:' || url.protocol === 'https:'
	} catch {
		return false
	}
}

/** An http(s) URL with no `user:password@`, which would ship in the public bundle. */
export function isPublicHttpUrl(value: string): boolean {
	if (!isHttpUrl(value)) return false

	const url = new URL(value)

	return url.username === '' && url.password === ''
}

/** An environment name, as `deploy --env`, `dev --rest env:<name>` and `urls` keys spell it. */
export const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/** `https://host[:port]` exactly: no path, query, fragment, trailing slash or credentials. */
export function isOrigin(value: string): boolean {
	if (!isHttpUrl(value)) return false

	return new URL(value).origin === value
}
