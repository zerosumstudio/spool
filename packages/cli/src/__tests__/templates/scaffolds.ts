/*
 *   IMPORTS
 ***************************************************************************************************/
import { ADDONS, templateExtras } from '../../core/addons.js'
import { appFiles, workspaceFiles } from '../../core/generators.js'
import { sentryEnvFiles } from '../../core/templates/sentry.js'
import { host, remote, makeManifest } from '../helpers.js'
import type { AddonName, Manifest } from '../../core/config.js'
import type { FileMap } from '../../core/filemap.js'

/*
 *   SCAFFOLDS
 ***************************************************************************************************/
/** Every scaffold shape the generators have to get right: one per framework, then all mixed. */
export const SCAFFOLDS: Record<string, () => Manifest> = {
	react: () =>
		makeManifest({
			shell: host({ remotes: ['dash'] }),
			dash: remote({ path: 'apps/dash' }),
		}),
	vue: () =>
		makeManifest({
			shell: host({ framework: 'vue', remotes: ['dash'] }),
			dash: remote({
				framework: 'vue',
				path: 'apps/dash',
				exposes: { './App': './src/mount.ts' },
			}),
		}),
	svelte: () =>
		makeManifest({
			shell: host({ framework: 'svelte', remotes: ['dash'] }),
			dash: remote({
				framework: 'svelte',
				path: 'apps/dash',
				exposes: { './App': './src/mount.ts' },
			}),
		}),
	mixed: () =>
		makeManifest({
			shell: host({ remotes: ['rr', 'vv', 'ss'] }),
			rr: remote({ path: 'apps/rr', port: 5174 }),
			vv: remote({
				framework: 'vue',
				path: 'apps/vv',
				port: 5175,
				exposes: { './App': './src/mount.ts' },
			}),
			ss: remote({
				framework: 'svelte',
				path: 'apps/ss',
				port: 5176,
				exposes: { './App': './src/mount.ts' },
			}),
		}),
	'vue host with react and svelte remotes': () =>
		makeManifest({
			shell: host({ framework: 'vue', remotes: ['rr', 'ss'] }),
			rr: remote({ path: 'apps/rr', port: 5174 }),
			ss: remote({
				framework: 'svelte',
				path: 'apps/ss',
				port: 5175,
				exposes: { './App': './src/mount.ts' },
			}),
		}),
	'svelte host with react and vue remotes': () =>
		makeManifest({
			shell: host({ framework: 'svelte', remotes: ['rr', 'vv'] }),
			rr: remote({ path: 'apps/rr', port: 5174 }),
			vv: remote({
				framework: 'vue',
				path: 'apps/vv',
				port: 5175,
				exposes: { './App': './src/mount.ts' },
			}),
		}),
}

/** What `spool create` writes, minus the disk: the workspace, each app, then each addon. */
export function scaffold(manifest: Manifest, addons: AddonName[]): FileMap {
	for (const name of addons) ADDONS[name].apply?.(manifest)

	const extras = templateExtras(addons)
	const files: FileMap = {
		...workspaceFiles(
			manifest,
			addons.flatMap(name => ADDONS[name].allowBuilds),
		),
	}

	for (const [name, app] of Object.entries(manifest.apps)) {
		for (const [rel, content] of Object.entries(
			appFiles(manifest, name, app, extras, '/workspace'),
		)) {
			files[`${app.path}/${rel}`] = content
		}
	}
	for (const name of addons) Object.assign(files, ADDONS[name].files(manifest, extras))
	if (addons.includes('sentry')) {
		Object.assign(files, sentryEnvFiles(manifest, 'https://key@o1.ingest.sentry.io/1'))
	}

	return files
}
