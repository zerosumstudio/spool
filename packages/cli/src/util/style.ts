/*
 *   IMPORTS
 ***************************************************************************************************/
import { styleText } from 'node:util'

/*
 *   TYPES
 ***************************************************************************************************/
type Format = Parameters<typeof styleText>[0]
export type Paint = (text: string) => string

export interface Style {
	bold: Paint
	dim: Paint
	red: Paint
	green: Paint
	yellow: Paint
	blue: Paint
	magenta: Paint
	cyan: Paint
}

/*
 *   STYLE
 ***************************************************************************************************/
/** Colours for one output stream. Plain text when the stream is not a TTY or NO_COLOR is set. */
export function createStyle(stream: NodeJS.WriteStream): Style {
	const paint =
		(format: Format): Paint =>
		text =>
			styleText(format, text, { stream })

	return {
		bold: paint('bold'),
		dim: paint('dim'),
		red: paint('red'),
		green: paint('green'),
		yellow: paint('yellow'),
		blue: paint('blue'),
		magenta: paint('magenta'),
		cyan: paint('cyan'),
	}
}

export const style = createStyle(process.stdout)
export const errorStyle = createStyle(process.stderr)
