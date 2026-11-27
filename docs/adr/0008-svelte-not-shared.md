# 8. Svelte is never a federation singleton

Status: accepted

## Context

A Svelte remote exposes `mountApp(target)`, which calls `mount` from its own `svelte`. Its components import `svelte/internal/client`, where the reactive state lives.

- Sharing `svelte` alone split the runtime. The remote's `mount` was the host's copy and its components ran on the remote's own internals. The first mount failed (`reading 'nodes'`).
- Sharing `svelte` together with `svelte/internal/client` and the other internal subpaths broke every Svelte host, even with no addons. Dev threw `Cannot access 'default' before initialization` in the `svelte/internal/client` share wrapper, and a build threw `reading 'attachment'` in the `svelte` one.

## Decision

- `spoolApp` never shares `svelte` or a `svelte/*` subpath, whatever `spool.json` lists.
- Each app keeps its own Svelte. A host mounts a Svelte remote through the mount function that remote built, the way it mounts a Vue one, so a component is always mounted by the runtime that compiled it.

## Consequences

- A page with two Svelte apps carries two copies of the Svelte runtime. They share nothing but the DOM node they are given.
- Shared state goes through `@zerosumstudio/clutch`, which does not depend on Svelte.
- `spool.json` can still list `svelte` in `shared`, and it has no effect. `create` and `add` no longer write it, and `spool upgrade` removes it (with a note), as does the version 1 migration.
