/*
 *   IMPORTS
 ***************************************************************************************************/
import * as p from '@clack/prompts'
import { CliError } from './errors.js'

/*
 *   INTERACTIVE
 ***************************************************************************************************/
let promptsDisabled = false

/** `--json` runs never prompt, whatever the terminal looks like. */
export function disablePrompts(): void {
	promptsDisabled = true
}

export function enablePrompts(): void {
	promptsDisabled = false
}

/** True when a person can answer: a TTY on stdin, and no `--json`. */
export function canPrompt(): boolean {
	return !promptsDisabled && process.stdin.isTTY
}

/** Awaits a clack prompt. Ctrl+C or Esc says so and throws `CANCELLED`, so nothing threads a null up. */
export async function ask<T>(prompt: Promise<T>): Promise<Exclude<T, symbol>> {
	const answer = await prompt

	if (p.isCancel(answer)) {
		p.cancel('Cancelled.')
		throw new CliError('Cancelled.', 'CANCELLED')
	}

	// clack's cancel is the only symbol a prompt resolves with, and it was handled above.
	return answer as Exclude<T, symbol>
}

/** Throws exit-2 `INPUT_REQUIRED`, naming the flag, for a value that has no default and no prompt. */
export function inputRequired(what: string, flag: string): never {
	throw new CliError(
		`Missing ${what}. Pass ${flag}; spool does not prompt without a terminal.`,
		'INPUT_REQUIRED',
	)
}

/**
 * Asks before a destructive step. `--yes` skips the question. Without a TTY the
 * answer cannot come from anyone, so it throws exit-2 `CONFIRMATION_REQUIRED`
 * instead of assuming yes. Returns false when the person declines.
 */
export async function confirmDestructive(message: string, yes: boolean): Promise<boolean> {
	if (yes) return true

	if (!canPrompt()) {
		throw new CliError(
			`${message} Pass --yes to confirm; spool does not prompt without a terminal.`,
			'CONFIRMATION_REQUIRED',
		)
	}

	return ask(p.confirm({ message, initialValue: false }))
}
