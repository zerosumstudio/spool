#!/usr/bin/env node
/*
 *   IMPORTS
 ***************************************************************************************************/
import { runCli } from './cli/run.js'
import { hardenExecutableSearch } from './util/system.js'

/*
 *   ENTRY POINT
 ***************************************************************************************************/
// The single exit point. Everything below throws, and runCli turns it into an exit code.
hardenExecutableSearch()

process.exitCode = await runCli(process.argv.slice(2))
