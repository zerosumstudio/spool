# 3. `spool.json` version 2

Status: accepted

## Context

Several settings failed open: `overrides: true` accepted any origin, `server.cors: true` replaced the localhost allowlist, and headers and paths were not checked for what they become on disk or in a header file.

## Decision

- `version` is required and is 2. A file with version 1, or no version, fails with `MANIFEST_VERSION` and points at `spool upgrade`.
- `overrides` is `{ "origins": [...] }`, `server.cors` is a list of origins, and `deployEnv` lists the secrets an app's deploy step gets. `csp` is `default` or `strict`.
- Names, paths, exposes, header names and values, origins and urls are checked by one names and paths module.
- `spool upgrade` migrates version 1 with `migrateManifest`: `overrides: true` becomes an empty origin list, `cors: true` becomes the app origins, `shell` becomes `navigation`, `federation` is dropped, `svelte` leaves `shared` (ADR 8), and `rspack` is dropped.
- Unknown keys are errors, since the file is edited by hand.

## Consequences

- Commands refuse a version 1 workspace until it is upgraded.
- `federation` is ignored in `spool.json` and refused on the command line, since federation is always on (ADR 6). `shell` is refused with a note that it became `navigation`.
