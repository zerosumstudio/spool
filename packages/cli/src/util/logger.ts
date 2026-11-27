/*
 *   IMPORTS
 ***************************************************************************************************/
import { errorStyle, style as outStyle, type Style } from './style.js'

/*
 *   LOGGER
 ***************************************************************************************************/
let sink: 'stdout' | 'stderr' = 'stdout'

const tag = (s: Style): string => s.bold(s.cyan('spool'))

function write(format: (s: Style) => string): void {
	if (sink === 'stdout') console.log(format(outStyle))
	else console.error(format(errorStyle))
}

export const log = {
	info: (message: string) => {
		write(s => `${tag(s)} ${message}`)
	},
	step: (message: string) => {
		write(s => `${tag(s)} ${s.dim('›')} ${message}`)
	},
	success: (message: string) => {
		write(s => `${tag(s)} ${s.green('✓')} ${message}`)
	},
	warn: (message: string) => {
		write(s => `${tag(s)} ${s.yellow('!')} ${message}`)
	},
	error: (message: string) => {
		console.error(`${tag(errorStyle)} ${errorStyle.red('✗')} ${message}`)
	},
	plain: (message: string) => {
		write(() => message)
	},
	/** Sends logs to stderr, which keeps stdout free for a `--json` document. */
	useStderr: () => {
		sink = 'stderr'
	},
	useStdout: () => {
		sink = 'stdout'
	},
	isStderr: (): boolean => sink === 'stderr',
}
