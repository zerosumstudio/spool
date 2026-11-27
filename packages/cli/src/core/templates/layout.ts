/*
 *   IMPORTS
 ***************************************************************************************************/
import { PRETTIER_OPTIONS } from '../format.js'

/*
 *   LAYOUT
 ***************************************************************************************************/
const PRINT_WIDTH: number = PRETTIER_OPTIONS.printWidth
const TAB_WIDTH: number = PRETTIER_OPTIONS.tabWidth

/** Whether prettier would keep `line` on one line, counting each leading tab as a full indent. */
export function fitsOnLine(line: string): boolean {
	return line.replaceAll('\t', ' '.repeat(TAB_WIDTH)).length <= PRINT_WIDTH
}

/** Prettier's layout for an array property: on one line when it fits, one item a line when not. */
export function formatArrayProperty(name: string, items: string[], depth: number): string {
	const indent = '\t'.repeat(depth)
	const oneLine = `${indent}${name}: [${items.join(', ')}],`

	if (fitsOnLine(oneLine)) return oneLine

	const lines = items.map(item => `${indent}\t${item},`).join('\n')

	return `${indent}${name}: [\n${lines}\n${indent}],`
}
