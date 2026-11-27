# 9. The CLI contract: exit codes, error codes and `--json`

Status: accepted

## Context

Scripts and CI call spool, and a person reads its output. Both need the same facts to be reliable: what the exit code means, what an error is called, and what stdout holds.

## Decision

- **Exit codes.** 0 is success, 1 is a failure (a build, a check, a port, a file), 2 is bad usage or input that could not be asked for, and 130 is a cancel.
- **Error codes.** Every failure is a `CliError(message, code)`, the one type the CLI throws. Codes are upper-case words with no suffix (`INVALID_NAME`, `TARGET_EXISTS`, `CHECK_FAILED`). The usage codes (`USAGE`, `INVALID_NAME`, `INVALID_PATH`, `INVALID_VALUE`, `INPUT_REQUIRED`, `CONFIRMATION_REQUIRED`) exit 2, `CANCELLED` exits 130, and the rest exit 1.
- **`--json`.** A command that takes `--json` prints exactly one document to stdout: `{ "ok": true, "command": "build", ...fields }`, or `{ "ok": false, "command", "error": { "code", "message" }, ...fields }`, with what the command had collected (`results`, `problems`) kept on a failure. Logs go to stderr, and so does the output of the commands spool runs for you. A bad flag under `--json` gets the failure document too.
- **No terminal.** Without a TTY, or under `--json`, spool never prompts. A missing value exits 2 with `INPUT_REQUIRED` and names the flag. A destructive step without `--yes` exits 2 with `CONFIRMATION_REQUIRED`, and never assumes yes.
- **One cancel path.** Ctrl+C at a prompt throws `CANCELLED`, so nothing threads a null up through its callers.
- **The vite entry.** Errors thrown while a vite config loads carry a `[spool]` prefix, like the warnings spool logs there.

## Consequences

- A script can branch on the exit code or on `error.code`, and parse stdout with no cleaning.
- A new failure needs a code from the list in `util/errors.ts`, and a new usage code must be added to the usage list there.
- Changing a code or the document shape is a breaking change.
