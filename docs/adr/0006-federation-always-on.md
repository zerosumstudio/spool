# 6. Federation is always on

Status: accepted

## Context

Hosts without the `federation` addon got separate mounting code for remotes, and the `<Remote>` component existed in three diverging copies.

## Decision

- Every host has `<Remote>`. The separate mounting code, `mountHint`s and the addon switch go.
- One framework-free `federation/core.ts` holds the loading, the timeout and the errors. React, Vue and Svelte wrap it with the same options.

## Consequences

- One behaviour in every framework.
- Existing workspaces get it through `spool upgrade`.
- The `federation` name is ignored in `spool.json` and refused on the command line. The templates no longer read it.
