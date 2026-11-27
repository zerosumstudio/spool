# 2. Runtime dependencies: only `@clack/prompts`

Status: accepted

## Context

The CLI installed about 14.6 MB of runtime dependencies: prettier, zod, commander, cross-spawn, picocolors and clack. Node 26 covers most of that.

## Decision

- `@clack/prompts` stays. Node has no prompt library, and clack takes `input` and `output` streams, so tests need no terminal.
- `util.parseArgs` and a small command table replace commander. `util.styleText` replaces picocolors. A hand-written parser replaces zod for `spool.json`.
- cross-spawn and prettier are gone: vite is spawned directly (ADR 5) and the templates are written already formatted, with the workspace's own prettier used only when it is installed.

## Consequences

- A smaller install and fewer supply-chain edges.
- Help text, option parsing and errors are ours to maintain.
- The parser and its error messages are covered by unit tests, not by a schema library.
