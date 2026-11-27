# 1. The vite helper ships as `@zerosumstudio/spool/vite`

Status: accepted

## Context

`create` wrote `spool.vite.ts` into every workspace, and each app's `vite.config.ts` imported it. A workspace kept the copy it was scaffolded with, so fixes and checks only arrived through `spool upgrade`, and the CLI carried `helperLacks` warnings for old copies.

## Decision

- The package exports `./vite` (`spoolApp()`), built by tsdown with its own types. Its plugin reads and validates `spool.json` with the same parser as the CLI, writes `_headers` at build, and passes the override origins to the app.
- The generated `vite.config.ts` is a few lines that import it. `spool.vite.ts` and `public/_headers` are no longer generated, and `doctor` flags a leftover `spool.vite.ts` and `public/_headers`.
- `spool eject` writes the helper out for people who want to own it.

## Consequences

- One copy of the logic, updated with the dependency.
- Generated apps need `@zerosumstudio/spool` installed to run vite, so `eject` must replace the import.
