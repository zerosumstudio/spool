import type { Plugin, ServerOptions } from 'vite'

export interface SpoolApp {
	server: ServerOptions
	federation: object
	plugin: Plugin
}

export function spoolApp(
	name: string,
	options: { root: string; command?: 'build' | 'serve' },
): SpoolApp
