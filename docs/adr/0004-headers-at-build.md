# 4. `_headers` is written at build

Status: accepted

## Context

`public/_headers` was a snapshot written by `create`. The dev server computed the same headers live, so changing `frameAncestors` or `headers` in `spool.json` changed dev and left the shipped file stale. `doctor` did not compare them.

## Decision

- The `./vite` plugin writes `dist/_headers` in `generateBundle` from `spool.json`. Nothing about headers is generated into the workspace.
- Hosts get `frame-ancestors`, `object-src 'none'` and `base-uri 'self'`. `csp: "strict"` adds `script-src` and `connect-src` for the app, its remotes and the override origins.
- Header names must match `^[A-Za-z0-9-]+$`, and values cannot hold CR, LF or other control characters.

## Consequences

- `dist/_headers` always follows `spool.json`.
- A leftover `public/_headers` would be copied into `dist`, so `doctor` reports it.
