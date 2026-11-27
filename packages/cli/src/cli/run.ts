/*
 *   IMPORTS
 ***************************************************************************************************/
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util'
import { CLI_VERSION } from '../core/versions.js'
import { CliError, EXIT, errorCodeOf, exitCodeFor } from '../util/errors.js'
import { disablePrompts, enablePrompts } from '../util/interactive.js'
import { failureDocument, formatJson, successDocument } from '../util/json.js'
import { log } from '../util/logger.js'
import { style } from '../util/style.js'
import { COMMANDS, type CommandSpec, type OptionValues } from './commands.js'

/*
 *   HELP
 ***************************************************************************************************/
const DESCRIPTION = 'Toolset for micro frontends and modular frontend projects'

function pad(text: string, width: number): string {
	return text.padEnd(width)
}

export function formatHelp(): string {
	const width = Math.max(...COMMANDS.map(c => `${c.name} ${c.args}`.trim().length)) + 2
	const rows = COMMANDS.map(
		c => `  ${style.cyan(pad(`${c.name} ${c.args}`.trim(), width))}${c.summary}`,
	)

	return [
		`spool ${CLI_VERSION}`,
		DESCRIPTION,
		'',
		`${style.bold('Usage:')} spool <command> [options]`,
		'',
		style.bold('Commands:'),
		...rows,
		'',
		"Run `spool <command> --help` for a command's options.",
		'Options: -h, --help   -v, --version',
	].join('\n')
}

function optionLabel(name: string, option: CommandSpec['options'][string]): string {
	const short = option.short ? `-${option.short}, ` : ''
	const value = option.value ? ` ${option.value}` : ''

	return `${short}--${name}${value}`
}

export function formatCommandHelp(command: CommandSpec): string {
	const entries = Object.entries(command.options)
	const width =
		Math.max(0, ...entries.map(([name, option]) => optionLabel(name, option).length)) + 2
	const rows = entries.map(
		([name, option]) =>
			`  ${style.cyan(pad(optionLabel(name, option), width))}${option.description}`,
	)

	return [
		`${style.bold('Usage:')} spool ${`${command.name} ${command.args}`.trim()} [options]`,
		command.summary,
		...(rows.length ? ['', style.bold('Options:'), ...rows] : []),
		...(command.json ? ['', 'With --json, exit codes: 0 ok, 1 failure, 2 bad usage.'] : []),
	].join('\n')
}

/*
 *   PARSING
 ***************************************************************************************************/
const camelCase = (key: string): string =>
	key.replace(/-(\w)/g, (_, letter: string) => letter.toUpperCase())

function toParseArgsOptions(command: CommandSpec): ParseArgsOptionsConfig {
	const options: ParseArgsOptionsConfig = {}

	for (const [name, option] of Object.entries(command.options)) {
		options[name] = {
			type: option.type,
			...(option.short ? { short: option.short } : {}),
		}
	}
	options.help = { type: 'boolean', short: 'h' }

	return options
}

interface Parsed {
	args: string[]
	values: OptionValues
	help: boolean
}

/** Our own sentence for what `parseArgs` rejected, from its error code rather than its text. */
function describeParseError(error: unknown): string {
	const { code, message } = error as { code?: string; message?: string }
	const option = /'(-[^' ]*)/.exec(message ?? '')?.[1]

	if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option) return `Unknown option ${option}.`
	if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) {
		return `Option ${option} needs a value.`
	}

	return `${(message ?? String(error)).split('. To specify')[0] ?? ''}.`
}

function parseCommandArgs(command: CommandSpec, argv: string[]): Parsed {
	let parsed
	try {
		parsed = parseArgs({
			args: argv,
			options: toParseArgsOptions(command),
			allowPositionals: true,
			allowNegative: true,
			strict: true,
		})
	} catch (error) {
		throw new CliError(
			`${describeParseError(error)} Run \`spool ${command.name} --help\`.`,
			'USAGE',
		)
	}

	const values: OptionValues = {}
	for (const [key, value] of Object.entries(parsed.values)) {
		if (key === 'help' || typeof value === 'object') continue

		values[camelCase(key)] = value
	}

	return { args: parsed.positionals, values, help: parsed.values.help === true }
}

function checkArguments(command: CommandSpec, args: string[]): void {
	if (args.length >= command.minArgs && args.length <= command.maxArgs) return

	const usage = `spool ${`${command.name} ${command.args}`.trim()}`

	throw new CliError(`Usage: ${usage}. Run \`spool ${command.name} --help\`.`, 'USAGE')
}

/*
 *   RUN
 ***************************************************************************************************/
function findCommand(name: string): CommandSpec {
	const command = COMMANDS.find(c => c.name === name)
	if (command) return command

	const known = COMMANDS.map(c => c.name).join(', ')

	throw new CliError(`Unknown command "${name}". Commands: ${known}.`, 'USAGE')
}

/** Prints the failure for a person, or leaves it to the JSON document. Cancel already said so. */
function reportFailure(error: unknown, asJson: boolean): void {
	if (asJson || errorCodeOf(error) === 'CANCELLED') return

	if (error instanceof CliError) log.error(error.message)
	else console.error(error)
}

async function runCommand(command: CommandSpec, argv: string[]): Promise<number> {
	// Read before parsing, so a bad flag still gets its JSON document.
	const asJson = command.json && argv.includes('--json') && !argv.includes('--no-json')

	try {
		const parsed = parseCommandArgs(command, argv)

		if (parsed.help) {
			console.log(formatCommandHelp(command))
			return EXIT.ok
		}

		checkArguments(command, parsed.args)

		if (asJson) {
			log.useStderr()
			disablePrompts()
		} else {
			log.useStdout()
			enablePrompts()
		}

		const result = await command.run(parsed.args, parsed.values)
		if (asJson) process.stdout.write(formatJson(successDocument(command.name, result ?? {})))

		return EXIT.ok
	} catch (error) {
		reportFailure(error, asJson)

		if (asJson) {
			const document = failureDocument(command.name, error)
			log.error(document.error.message)
			process.stdout.write(formatJson(document))
		}

		return exitCodeFor(error)
	}
}

/**
 * Runs the CLI and resolves to the process exit code: 0 ok, 1 failure, 2 bad
 * usage or input that could not be asked for, 130 cancelled.
 */
export async function runCli(argv: string[]): Promise<number> {
	const [first, ...rest] = argv

	if (first === undefined || first === '-h' || first === '--help') {
		console.log(formatHelp())
		return EXIT.ok
	}
	if (first === '-v' || first === '--version') {
		console.log(CLI_VERSION)
		return EXIT.ok
	}

	try {
		if (first === 'help') {
			console.log(
				rest[0] === undefined ? formatHelp() : formatCommandHelp(findCommand(rest[0])),
			)
			return EXIT.ok
		}

		return await runCommand(findCommand(first), rest)
	} catch (error) {
		reportFailure(error, false)

		return exitCodeFor(error)
	}
}
