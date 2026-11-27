/*
 *   IMPORTS
 ***************************************************************************************************/
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Workspace } from './workspace.js'
import { hostWiringFiles } from './generators.js'
import { OwnedWriter } from './fswrite.js'
import { formatFiles } from './format.js'
import { Provenance, sameContent } from './provenance.js'

/*
 *   TYPINGS
 ***************************************************************************************************/
const TYPINGS_FILE = 'src/remotes.d.ts'

/**
 * Generated typings are already in house style, so they are written as they are. Only when they
 * differ from the file on disk is the workspace's prettier asked, since its config may format
 * the same typings differently and an unchanged file must stay untouched. That keeps prettier
 * from being loaded on every dev and build.
 */
async function typingsFor(ws: Workspace, target: string, generated: string): Promise<string> {
	if (!existsSync(target) || sameContent(readFileSync(target, 'utf8'), generated))
		return generated

	const formatted = await formatFiles({ [TYPINGS_FILE]: generated }, ws.root)

	return formatted[TYPINGS_FILE] ?? generated
}

export async function syncRemoteTypings(ws: Workspace): Promise<void> {
	const provenance = Provenance.load(ws.root)
	const writer = new OwnedWriter(ws.root, false, provenance, false)

	for (const [name, app] of Object.entries(ws.manifest.apps)) {
		if (!app.remotes.length) continue

		const dir = join(ws.root, app.path)
		const generated = hostWiringFiles(ws.manifest, app, ws.root)[TYPINGS_FILE]
		if (generated === undefined) continue

		await writer.replaceGenerated(
			dir,
			TYPINGS_FILE,
			await typingsFor(ws, join(dir, TYPINGS_FILE), generated),
			name,
		)
	}

	await provenance.save()
}
