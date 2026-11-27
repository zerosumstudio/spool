/*
 *   IMPORTS
 ***************************************************************************************************/
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { CLI_VERSION } from './versions.js'

/*
 *   TYPES
 ***************************************************************************************************/
export const PROVENANCE_FILE = join('.spool', 'generated.json')

/** Bumped when the file's shape changes. An older record is ignored, not migrated. */
const FORMAT = 1

interface ProvenanceFile {
	version: number
	writtenBy: string
	files: Record<string, string>
	/** Files the user has taken over; spool stops offering to regenerate them. */
	owned?: string[]
}

/**
 * - `ours`: the bytes on disk are the bytes spool last wrote.
 * - `edited`: someone changed the file after spool wrote it.
 * - `owned`: the user chose to keep their version, so spool leaves it be.
 * - `unknown`: no record, either from before provenance or not spool's file.
 */
export type Ownership = 'ours' | 'edited' | 'owned' | 'unknown'

/*
 *   HASH
 ***************************************************************************************************/
export function hashContent(content: string): string {
	const normalised = content.split('\r\n').join('\n')
	return createHash('sha256').update(normalised, 'utf8').digest('hex')
}

export function sameContent(a: string, b: string): boolean {
	return hashContent(a) === hashContent(b)
}

/*
 *   PROVENANCE
 ***************************************************************************************************/
export class Provenance {
	private dirty = false

	private constructor(
		private readonly root: string,
		private readonly files: Map<string, string>,
		private readonly owned: Set<string>,
	) {}

	/** A record spool cannot read is treated as absent, never as a conflict. */
	static load(root: string): Provenance {
		const target = join(root, PROVENANCE_FILE)

		if (!existsSync(target)) return new Provenance(root, new Map(), new Set())

		try {
			const parsed = JSON.parse(readFileSync(target, 'utf8')) as ProvenanceFile
			if (parsed.version !== FORMAT) return new Provenance(root, new Map(), new Set())

			return new Provenance(
				root,
				new Map(Object.entries(parsed.files)),
				new Set(parsed.owned ?? []),
			)
		} catch {
			return new Provenance(root, new Map(), new Set())
		}
	}

	ownership(dir: string, rel: string, existing: string): Ownership {
		const key = this.key(dir, rel)

		if (this.owned.has(key)) return 'owned'

		const stored = this.files.get(key)

		if (stored === undefined) return 'unknown'

		return stored === hashContent(existing) ? 'ours' : 'edited'
	}

	claim(dir: string, rel: string): void {
		const key = this.key(dir, rel)

		if (this.owned.has(key)) return

		this.owned.add(key)
		this.files.delete(key)
		this.dirty = true
	}

	record(dir: string, rel: string, content: string): void {
		const key = this.key(dir, rel)
		const hash = hashContent(content)

		if (this.owned.delete(key)) this.dirty = true
		if (this.files.get(key) === hash) return

		this.files.set(key, hash)
		this.dirty = true
	}

	entries(): [string, string][] {
		return [...this.files]
	}

	tracks(rootRelativePath: string): boolean {
		const key = rootRelativePath.split(sep).join('/')
		return this.files.has(key) || this.owned.has(key)
	}

	forget(dir: string, rel: string): void {
		const key = this.key(dir, rel)
		if (this.owned.delete(key)) this.dirty = true
		if (this.files.delete(key)) this.dirty = true
	}

	forgetPrefix(prefix: string): void {
		const base = prefix.split(sep).join('/').replace(/\/$/, '')
		const matches = (key: string): boolean => key === base || key.startsWith(`${base}/`)

		for (const key of [...this.files.keys()]) {
			if (!matches(key)) continue
			this.files.delete(key)
			this.dirty = true
		}
		for (const key of [...this.owned]) {
			if (!matches(key)) continue
			this.owned.delete(key)
			this.dirty = true
		}
	}

	/**
	 * Moves a record from `fromRel` to `toRel` under the same `dir`, for files a
	 * newer spool generates under a different name (For example, the old shell addon's
	 * src/shell/remote.tsx became src/federation/remote.tsx).
	 */
	rename(dir: string, fromRel: string, toRel: string): void {
		const from = this.key(dir, fromRel)
		const to = this.key(dir, toRel)

		if (this.owned.delete(from)) {
			this.owned.add(to)
			this.dirty = true
		}
		const moved = this.files.get(from)

		if (moved !== undefined) {
			this.files.set(to, moved)
			this.files.delete(from)
			this.dirty = true
		}
	}

	/** Drops records for files no longer on disk, so a deleted file stops
	 * showing up as "generated but untracked" if something re-creates it by hand. */
	pruneMissing(root: string): void {
		for (const key of [...this.files.keys()]) {
			if (!existsSync(join(root, key))) {
				this.files.delete(key)
				this.dirty = true
			}
		}
	}

	async save(): Promise<void> {
		if (!this.dirty) return

		const target = join(this.root, PROVENANCE_FILE)
		await mkdir(dirname(target), { recursive: true })

		const payload: ProvenanceFile = {
			version: FORMAT,
			writtenBy: CLI_VERSION,
			// Sorted so committing this file produces a readable diff.
			files: Object.fromEntries([...this.files].sort(([a], [b]) => a.localeCompare(b))),
			...(this.owned.size ? { owned: [...this.owned].sort() } : {}),
		}

		await writeFile(target, `${JSON.stringify(payload, null, '\t')}\n`, 'utf8')

		this.dirty = false
	}

	private key(dir: string, rel: string): string {
		return relative(this.root, join(dir, rel)).split(sep).join('/')
	}
}
