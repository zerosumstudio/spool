/*
 *   TYPES
 ***************************************************************************************************/
export interface JsonStyle {
	/** Columns before a line has to wrap. */
	printWidth: number
	/** Columns one level of indentation counts for, when measuring a line. */
	tabWidth: number
}

const HOUSE_STYLE: JsonStyle = { printWidth: 100, tabWidth: 4 }

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const isObject = (value: Json): value is { [key: string]: Json } =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

/*
 *   LAYOUT
 ***************************************************************************************************/
/**
 * Prettier breaks an array that holds several objects (or arrays) with more than one entry each,
 * and a forced break propagates to every group around it.
 */
function breaksArray(items: Json[]): boolean {
	if (items.length < 2) return false

	const first = items[0]
	if (first !== undefined && isObject(first)) {
		return items.every(item => isObject(item) && Object.keys(item).length > 1)
	}

	return Array.isArray(first) && items.every(item => Array.isArray(item) && item.length > 1)
}

function mustBreak(value: Json): boolean {
	if (Array.isArray(value)) return breaksArray(value) || value.some(mustBreak)
	if (isObject(value)) return Object.values(value).some(mustBreak)

	return false
}

function flat(value: Json): string {
	if (Array.isArray(value)) {
		return value.length ? `[${value.map(flat).join(', ')}]` : '[]'
	}
	if (isObject(value)) {
		const entries = Object.entries(value).map(
			([key, inner]) => `${JSON.stringify(key)}: ${flat(inner)}`,
		)

		return entries.length ? `{ ${entries.join(', ')} }` : '{}'
	}

	return JSON.stringify(value)
}

/*
 *   PRINTER
 ***************************************************************************************************/
/**
 * Prints a value as prettier prints JSON written on one line, with house style: tabs, double
 * quotes, a group on one line when it fits and one entry per line when it does not. It exists so
 * `spool.json` and the generated package files need no prettier to look right.
 */
export function printJson(value: unknown, style: JsonStyle = HOUSE_STYLE): string {
	return `${print(value as Json, 0, 0, style)}\n`
}

/**
 * `column` is where this value starts on its line, `trailing` the characters that follow it
 * on that line (a comma), which count toward fitting.
 */
function print(value: Json, depth: number, column: number, style: JsonStyle, trailing = 0): string {
	const isEmptyContainer =
		(Array.isArray(value) && !value.length) || (isObject(value) && !Object.keys(value).length)
	const inline = flat(value)
	const fits = column + inline.length + trailing <= style.printWidth

	if (!Array.isArray(value) && !isObject(value)) return inline
	if (isEmptyContainer || (fits && !mustBreak(value))) return inline

	const indent = '\t'.repeat(depth + 1)
	const inner = (depth + 1) * style.tabWidth
	const closing = '\t'.repeat(depth)

	if (Array.isArray(value)) {
		const lines = value.map((item, index) =>
			print(item, depth + 1, inner, style, index < value.length - 1 ? 1 : 0),
		)

		return `[\n${lines.map((line, index) => `${indent}${line}${index < lines.length - 1 ? ',' : ''}`).join('\n')}\n${closing}]`
	}

	const entries = Object.entries(value)
	const lines = entries.map(([key, item], index) => {
		const prefix = `${JSON.stringify(key)}: `

		return `${indent}${prefix}${print(item, depth + 1, inner + prefix.length, style, index < entries.length - 1 ? 1 : 0)}`
	})

	return `{\n${lines.map((line, index) => `${line}${index < lines.length - 1 ? ',' : ''}`).join('\n')}\n${closing}}`
}

/** Files prettier prints with its `json-stringify` parser: every object and array expanded, as `JSON.stringify` does. */
const STRINGIFIED = new Set(['package.json', 'package-lock.json', 'composer.json'])

export const printStringifiedJson = (value: unknown): string =>
	`${JSON.stringify(value, null, '\t')}\n`

/** Prints `value` the way prettier prints a JSON file called `name`. */
export function printJsonFor(name: string, value: unknown): string {
	const file = name.split('/').pop() ?? name

	return STRINGIFIED.has(file) ? printStringifiedJson(value) : printJson(value)
}
