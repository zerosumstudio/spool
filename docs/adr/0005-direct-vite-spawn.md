# 5. Vite is spawned directly

Status: accepted

## Context

Every app ran as `pm run dev|preview|build` through cross-spawn. On Windows that is five or six processes per app, and `--kill` found them by port and old pid files.

## Decision

- Start vite with `process.execPath` and the script its `bin` field names, read from the vite that is installed for the app. `vite/bin/vite.js` is not an exported subpath, so it is not resolved by name, and the lookup stops at the workspace root. Only `install` goes through the package manager.
- `--kill` ends only the pids in the pidfile whose start time and command line match, and reports the owner of any other port without killing it.
- Build concurrency defaults to `min(4, cores / 2)`.

## Consequences

- Two processes per app, and no `.cmd` shim layer.
- Accepting an unrelated process on a manifest port is the user's call, not ours.
