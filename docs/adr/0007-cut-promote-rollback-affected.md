# 7. `promote`, `rollback` and `affected` are cut

Status: accepted

## Context

`promote` and `rollback` re-ran a deploy command at a recorded sha, and `rollback` only flipped between the last two records. `affected` wrapped `git diff`, which `pnpm --filter "...[ref]"` and `turbo --affected` already do, and passed its ref to git as an option.

## Decision

- Remove all three commands. `deploy --env` still records what it ships.
- Use `pnpm --filter "...[<ref>]"` or `turbo --affected` for affected apps.

## Consequences

- A smaller CLI with fewer things that shell out to git.
- Anyone scripting these commands moves to their CI.
