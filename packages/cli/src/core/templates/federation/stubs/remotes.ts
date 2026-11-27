/*
 * Stands in for the registry spool generates (see remotesRegistry in composition.ts), so the
 * files beside this folder type-check in this repo. Never copied into a host.
 */
import { loadRemote } from '../core'

export interface RemoteEntry {
	contract: 'component' | 'mount'
	load: () => Promise<{ default: unknown }>
	mountComponent?: (component: unknown, target: HTMLElement, props?: object) => () => void
}

export const remotes = {
	sample: {
		contract: 'component',
		load: () =>
			loadRemote('sample/App', { importRemote: () => Promise.resolve({ default: null }) }),
	},
} satisfies Record<string, RemoteEntry>

export type RemoteName = keyof typeof remotes
