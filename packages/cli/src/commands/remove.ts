/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { requireWorkspace, saveManifest, type Workspace } from '../core/workspace.js'
import { hostWiringFiles } from '../core/generators.js'
import { federationFiles } from '../core/templates/composition.js'
import { formatFiles } from '../core/format.js'
import { OwnedWriter } from '../core/fswrite.js'
import { Provenance } from '../core/provenance.js'
import { confirmDestructive } from '../util/interactive.js'
import { assertConfined } from '../util/confine.js'
import { CliError } from '../util/errors.js'
import { getApp } from '../core/config.js'
import { withoutKey } from '../util/json.js'
import { log } from '../util/logger.js'

/*
 *   TYPES
 ***************************************************************************************************/
export interface RemoveOptions {
	files?: boolean
	yes?: boolean
}

/*
 *   REMOVE
 ***************************************************************************************************/
export async function remove(name: string, opts: RemoveOptions): Promise<void> {
	const ws = await requireWorkspace()
	const { manifest } = ws

	const app = getApp(manifest, name)

	const appDir = opts.files ? appDirInsideWorkspace(ws, app.path) : undefined
	if (appDir && !(await confirmDelete(app.path, opts.yes ?? false))) {
		log.step(`Left ${app.path} on disk; nothing was removed.`)
		return
	}

	manifest.apps = withoutKey(manifest.apps, name)
	const consumers = unwireConsumers(ws, name)

	const provenance = Provenance.load(ws.root)
	for (const consumer of consumers) await refreshConsumerTypings(ws, consumer, provenance)

	provenance.forgetPrefix(app.path)
	await provenance.save()

	await saveManifest(ws)

	if (appDir) {
		await rm(appDir, { recursive: true, force: true })
		log.step(`deleted ${app.path}`)
	} else {
		log.step(`Left ${app.path} on disk. Delete it yourself, or rerun with --files.`)
	}

	log.success(`removed ${app.type} ${name}`)
	if (consumers.length) {
		log.step(
			`If a consumer's own components still import or mount "${name}/App", remove that code.`,
		)
	}
}

/*
 *   HELPERS
 ***************************************************************************************************/
function confirmDelete(path: string, yes: boolean): Promise<boolean> {
	return confirmDestructive(`Delete ${path} and everything in it?`, yes)
}

interface ConsumerRef {
	name: string
	path: string
	remotes: string[]
}

/** A remote can consume remotes too, so anything that lists the removed app
 * needs unwiring, not just hosts. */
function unwireConsumers(ws: Workspace, remote: string): ConsumerRef[] {
	const affected: ConsumerRef[] = []

	for (const [consumerName, consumer] of Object.entries(ws.manifest.apps)) {
		if (!consumer.remotes.includes(remote)) continue

		consumer.remotes = consumer.remotes.filter(r => r !== remote)
		affected.push({ name: consumerName, path: consumer.path, remotes: consumer.remotes })
		log.step(`unwired ${remote} from ${consumer.type} ${consumerName}`)
	}

	return affected
}

async function refreshConsumerTypings(
	ws: Workspace,
	consumer: ConsumerRef,
	provenance: Provenance,
): Promise<void> {
	const app = getApp(ws.manifest, consumer.name)
	const dir = join(ws.root, consumer.path)
	const writer = new OwnedWriter(ws.root, false, provenance, false)

	if (consumer.remotes.length) {
		const typings = await formatFiles(hostWiringFiles(ws.manifest, app, ws.root), ws.root)
		for (const [rel, content] of Object.entries(typings)) {
			await writer.replaceGenerated(dir, rel, content, consumer.name)
		}
		return
	}

	assertConfined(ws.root, join(dir, 'src/remotes.d.ts'))
	await rm(join(dir, 'src/remotes.d.ts'), { force: true })
	provenance.forget(dir, 'src/remotes.d.ts')

	// A host always has a registry; a remote has one only while it consumes remotes.
	if (app.type !== 'host' && !existsSync(join(dir, 'src/federation/remotes.ts'))) return

	const registry = await formatFiles(federationFiles(ws.manifest, app), ws.root)
	for (const [rel, content] of Object.entries(registry)) {
		await writer.replaceGenerated(dir, rel, content, consumer.name)
	}
}

/** A hand-edited path must never let --files delete outside the workspace. */
function appDirInsideWorkspace(ws: Workspace, appPath: string): string {
	const target = resolve(ws.root, appPath)

	if (target !== ws.root && !target.startsWith(ws.root + sep)) {
		throw new CliError(
			`Refusing to delete "${appPath}": it resolves outside the workspace.`,
			'UNSAFE_PATH',
		)
	}

	if (target === ws.root) {
		throw new CliError(
			`Refusing to delete "${appPath}": it is the workspace root.`,
			'UNSAFE_PATH',
		)
	}

	// A link in the path would send the delete somewhere else, and the prompt shows the harmless name.
	assertConfined(ws.root, target, { allowFinalLink: true })

	return target
}
