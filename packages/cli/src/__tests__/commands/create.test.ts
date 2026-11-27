/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { create } from '../../commands/create.js'
import { freshDir, removeDir } from '../helpers.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
let dir: string
const cwd = process.cwd()

beforeEach(() => {
	dir = freshDir('spool-create-')
	vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
	removeDir(dir)
	vi.restoreAllMocks()
})

const read = (rel: string) => readFileSync(join(dir, rel), 'utf8')

/*
 *   CREATE
 ***************************************************************************************************/
describe('create', () => {
	it('scaffolds a workspace with a host and remotes', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dashboard, profile',
			install: false,
		})

		const manifest = JSON.parse(read('spool.json'))
		expect(manifest.name).toBe('acme')
		expect(manifest.apps.shell).toMatchObject({
			type: 'host',
			port: 5173,
			remotes: ['dashboard', 'profile'],
		})
		expect(manifest.apps.dashboard).toMatchObject({ type: 'remote', port: 5174 })
		expect(manifest.apps.profile).toMatchObject({ type: 'remote', port: 5175 })
	})

	it('writes each app plus the runtime helper the configs read from', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dashboard',
			install: false,
		})

		expect(existsSync(join(dir, 'spool.workspace.ts'))).toBe(true)
		// The helper ships in the package: nothing is generated for vite or for headers.
		expect(existsSync(join(dir, 'spool.vite.ts'))).toBe(false)
		expect(existsSync(join(dir, 'apps/shell/public/_headers'))).toBe(false)
		expect(existsSync(join(dir, 'apps/shell/vite.config.ts'))).toBe(true)
		expect(existsSync(join(dir, 'apps/dashboard/vite.config.ts'))).toBe(true)
		// Wiring is resolved when vite loads the config, from spool.json, never baked in.
		expect(read('apps/shell/vite.config.ts')).toContain("spoolApp('shell'")
		expect(read('apps/shell/vite.config.ts')).not.toContain('localhost')
	})

	it('writes files already formatted to the shipped prettier config', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dashboard',
			install: false,
		})

		// House style: tabs, single quotes, no trailing semicolons.
		const viteConfig = read('apps/shell/vite.config.ts')
		expect(viteConfig).toContain("import { defineConfig } from 'vite'")
		expect(viteConfig).not.toMatch(/;\r?\n/)
		expect(read('spool.workspace.ts')).toContain('\t')
		expect(read('spool.json')).toContain('\t')
	})

	it('gives every host the federation files and runtime dependency with no addon chosen', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dashboard',
			addons: 'none',
			install: false,
		})

		expect(existsSync(join(dir, 'apps/shell/src/federation/remotes.ts'))).toBe(true)
		expect(read('apps/shell/src/federation/remotes.ts')).toContain('dashboard/App')
		expect(JSON.parse(read('apps/shell/package.json')).dependencies).toHaveProperty(
			'@module-federation/runtime',
		)
		expect(existsSync(join(dir, 'apps/dashboard/src/federation'))).toBe(false)
		expect(JSON.parse(read('spool.json')).addons).toEqual([])
	})

	it('refuses federation as an addon name now that it is always on', async () => {
		await expect(
			create(dir, {
				name: 'acme',
				pm: 'pnpm',
				host: 'shell',
				remotes: 'dashboard',
				addons: 'federation',
				install: false,
			}),
		).rejects.toMatchObject({ code: 'INVALID_VALUE' })
	})

	it('tells whoever passes the old shell addon name that it was renamed', async () => {
		await expect(
			create(dir, {
				name: 'acme',
				pm: 'pnpm',
				host: 'shell',
				remotes: 'dashboard',
				addons: 'shell',
				install: false,
			}),
		).rejects.toThrow('renamed to "navigation"')
	})

	it('refuses --here together with a folder, instead of ignoring the folder', async () => {
		await expect(
			create(dir, {
				name: 'acme',
				pm: 'pnpm',
				host: 'shell',
				remotes: 'dashboard',
				here: true,
				install: false,
			}),
		).rejects.toMatchObject({ code: 'USAGE' })
	})

	it('scaffolds per-app frameworks from name:framework specs', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell:svelte',
			remotes: 'dashboard:vue, profile',
			install: false,
		})

		const manifest = JSON.parse(read('spool.json'))
		expect(manifest.apps.shell.framework).toBe('svelte')
		expect(manifest.apps.dashboard.framework).toBe('vue')
		// Remotes without an explicit framework follow the host.
		expect(manifest.apps.profile.framework).toBe('svelte')
		expect(manifest.shared).toEqual(['vue'])
		expect(new Set(manifest.shared).size).toBe(manifest.shared.length)
		expect(existsSync(join(dir, 'apps/shell/src/app/app.svelte'))).toBe(true)
		expect(existsSync(join(dir, 'apps/dashboard/src/app/app.vue'))).toBe(true)
	})

	it('uses --framework as the default for apps without a spec', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dashboard:react',
			framework: 'vue',
			install: false,
		})

		const manifest = JSON.parse(read('spool.json'))
		expect(manifest.apps.shell.framework).toBe('vue')
		expect(manifest.apps.dashboard.framework).toBe('react')
	})

	it('rejects an unknown framework in a spec', async () => {
		await expect(
			create(dir, {
				name: 'acme',
				pm: 'pnpm',
				host: 'shell:angular',
				remotes: '',
				install: false,
			}),
		).rejects.toThrow('Unknown framework')
	})

	it('rejects a host spec with too many colon segments', async () => {
		await expect(
			create(dir, { name: 'acme', pm: 'pnpm', host: 'a:b:c', remotes: '', install: false }),
		).rejects.toThrow('Use "name" or "name:framework"')
	})

	it('scaffolds the requested addons', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dashboard, profile',
			addons: 'ladle, playwright',
			install: false,
		})

		expect(
			JSON.parse(read('packages/ui/package.json')).devDependencies['@ladle/react'],
		).toBeDefined()
		expect(existsSync(join(dir, 'packages/ui/src/Button.stories.tsx'))).toBe(true)

		const spec = read('packages/e2e/tests/shell.spec.ts')
		expect(spec).toContain('shell (host)')
		expect(spec).toContain("name: 'dashboard'")
		expect(spec).toContain("name: 'profile'")
		expect(spec).toContain('toHaveCount(2)')
		expect(read('packages/e2e/playwright.config.ts')).toContain('http://localhost:5173')
		expect(read('packages/e2e/playwright.config.ts')).toContain('pnpm run dev')

		expect(read('pnpm-workspace.yaml')).toContain("'@swc/core': true")
		expect(read('pnpm-workspace.yaml')).toContain("- '@swc/core'")
	})

	it('writes a route-walking e2e spec when the host is a routed shell', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dashboard, profile',
			addons: 'playwright, navigation, state',
			install: false,
		})

		const spec = read('packages/e2e/tests/shell.spec.ts')
		expect(spec).toContain('shell routes to every remote')
		expect(spec).not.toContain('shell (host)')
		expect(spec).toContain("toHaveText('/profile')")
		expect(spec).toContain("getByTestId('route-path')")
		expect(spec).toContain('shared state survives switching remotes')
		expect(JSON.parse(read('packages/e2e/tsconfig.json')).compilerOptions.types).toEqual([
			'node',
		])
	})

	it('wires the shared-state addon through spool.json and every app', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dashboard, widget:svelte',
			addons: 'state',
			install: false,
		})

		const manifest = JSON.parse(read('spool.json'))
		expect(manifest.shared).toContain('@zerosumstudio/clutch')
		expect(manifest.shared).toContain('@zerosumstudio/clutch/react')

		for (const app of ['shell', 'dashboard', 'widget']) {
			const pkg = JSON.parse(read(`apps/${app}/package.json`))
			expect(pkg.dependencies['@zerosumstudio/clutch']).toBeDefined()
			expect(read(`apps/${app}/src/state/counter.ts`)).toContain("'acme:counter'")
		}
	})

	it('shares only the clutch core when no app is react', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell:vue',
			remotes: 'widget:svelte',
			addons: 'state',
			install: false,
		})

		const manifest = JSON.parse(read('spool.json'))
		expect(manifest.shared).toContain('@zerosumstudio/clutch')
		expect(manifest.shared).not.toContain('@zerosumstudio/clutch/react')
	})

	it('scaffolds the shared-counter example when state is picked at create', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dash, widget:svelte',
			addons: 'ladle, playwright, state',
			install: false,
		})

		expect(read('apps/shell/src/app/app.tsx')).toContain('shared-count')
		const dash = read('apps/dash/src/app/app.tsx')
		expect(dash).toContain("import { Button } from 'ui'")
		expect(dash).toContain('<Button onClick={handleIncrement}>Increment</Button>')
		expect(JSON.parse(read('apps/dash/package.json')).dependencies.ui).toBe('workspace:*')
		expect(read('apps/widget/src/app/app.svelte')).toContain('counterStore.set(')
		expect(read('packages/e2e/tests/shell.spec.ts')).toContain('shared state')
	})

	it('falls back to a plain button when ladle is not picked', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: 'dash',
			addons: 'state',
			install: false,
		})

		const dash = read('apps/dash/src/app/app.tsx')
		expect(dash).toContain('<button onClick={handleIncrement}>Increment</button>')
		expect(dash).not.toContain("from 'ui'")
		expect(JSON.parse(read('apps/dash/package.json')).dependencies.ui).toBeUndefined()
	})

	it('rejects an unknown addon', async () => {
		await expect(
			create(dir, {
				name: 'acme',
				pm: 'pnpm',
				host: 'shell',
				remotes: '',
				addons: 'storybook',
				install: false,
			}),
		).rejects.toThrow('Unknown addon')
	})

	it('rejects ladle in a workspace with no react app', async () => {
		await expect(
			create(dir, {
				name: 'acme',
				pm: 'pnpm',
				host: 'shell:svelte',
				remotes: '',
				addons: 'ladle',
				install: false,
			}),
		).rejects.toThrow('react-based')
	})

	it('treats --addons none as no addons', async () => {
		await create(dir, {
			name: 'acme',
			pm: 'pnpm',
			host: 'shell',
			remotes: '',
			addons: 'none',
			install: false,
		})
		expect(existsSync(join(dir, 'packages'))).toBe(false)
	})

	it('scaffolds an npm workspace when --pm npm is chosen', async () => {
		await create(dir, { name: 'acme', pm: 'npm', host: 'shell', remotes: '', install: false })

		const manifest = JSON.parse(read('spool.json'))
		expect(manifest.packageManager).toBe('npm')
		expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
		expect(JSON.parse(read('package.json')).workspaces).toEqual(['apps/*', 'packages/*'])
	})

	it('rejects an unknown package manager', async () => {
		await expect(
			create(dir, { name: 'acme', pm: 'bun', host: 'shell', remotes: '', install: false }),
		).rejects.toThrow('Unknown package manager')
	})

	it('ships the house prettier config into the workspace', async () => {
		await create(dir, { name: 'acme', pm: 'pnpm', host: 'shell', remotes: '', install: false })
		expect(existsSync(join(dir, '.prettierrc'))).toBe(true)
	})

	it('rejects an invalid workspace name', async () => {
		await expect(
			create(dir, {
				name: 'Bad Name',
				pm: 'pnpm',
				host: 'shell',
				remotes: '',
				install: false,
			}),
		).rejects.toThrow('Invalid workspace name')
	})

	it('rejects a remote that collides with the host name', async () => {
		await expect(
			create(dir, {
				name: 'acme',
				pm: 'pnpm',
				host: 'shell',
				remotes: 'shell',
				install: false,
			}),
		).rejects.toThrow('unique')
	})

	it('refuses to overwrite an existing workspace', async () => {
		await create(dir, { name: 'acme', pm: 'pnpm', host: 'shell', remotes: '', install: false })
		await expect(
			create(dir, { name: 'acme', pm: 'pnpm', host: 'shell', remotes: '', install: false }),
		).rejects.toThrow('already a spool workspace')
	})

	it('blames the folder name when a derived workspace name is invalid', async () => {
		await expect(
			create(join(dir, 'Bad Folder'), {
				pm: 'pnpm',
				host: 'shell',
				remotes: '',
				install: false,
			}),
		).rejects.toThrow('pass --name')
	})
})

/*
 *   NAMES AND FOLDERS
 ***************************************************************************************************/
describe('create name and folder validation', () => {
	// Every case passes a folder that exists in tmp, so a regression writes there and nowhere else.
	const attempt = (name: string, host = 'shell') =>
		create(dir, { name, pm: 'pnpm', host, remotes: '', install: false })

	it('rejects Windows device names, "a/b" and a path as a workspace name', async () => {
		for (const name of ['con', 'nul', 'aux', 'prn', 'com1', 'lpt1', 'a/b', '../esc', '..']) {
			await expect(attempt(name)).rejects.toMatchObject({ code: 'INVALID_NAME' })
		}

		expect(existsSync(join(dir, 'spool.json'))).toBe(false)
	})

	it('rejects a device name, "a/b" and a package name as an app name', async () => {
		for (const host of ['con', 'a/b', 'react']) {
			await expect(attempt('acme', host)).rejects.toMatchObject({ code: 'INVALID_NAME' })
		}
	})

	it('rejects a folder that climbs out, or names a device, before writing anything', async () => {
		const work = join(dir, 'work')
		mkdirSync(work)
		process.chdir(work)

		try {
			for (const folder of ['../esc', '..', 'con', 'a/con', 'a/../../esc']) {
				await expect(
					create(folder, {
						name: 'acme',
						pm: 'pnpm',
						host: 'shell',
						remotes: '',
						install: false,
					}),
				).rejects.toMatchObject({ code: 'INVALID_PATH' })
			}

			expect(readdirSync(work)).toEqual([])
			expect(existsSync(join(dir, 'esc'))).toBe(false)
		} finally {
			process.chdir(cwd)
		}
	})

	it('stops when the folder already has files, and leaves them alone', async () => {
		writeFileSync(join(dir, 'notes.txt'), 'mine')

		await expect(attempt('acme')).rejects.toMatchObject({ code: 'TARGET_NOT_EMPTY' })
		expect(readdirSync(dir)).toEqual(['notes.txt'])
	})

	it('--here shares a folder but lists every file it would overwrite, and stops', async () => {
		writeFileSync(join(dir, 'package.json'), '{"mine":true}')
		writeFileSync(join(dir, 'README.md'), 'mine')
		process.chdir(dir)

		try {
			const error = await create(undefined, {
				here: true,
				name: 'acme',
				pm: 'pnpm',
				host: 'shell',
				remotes: '',
				install: false,
			}).catch((caught: unknown) => caught)

			expect(error).toMatchObject({ code: 'TARGET_NOT_EMPTY' })
			expect((error as Error).message).toContain('package.json')
			expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe('{"mine":true}')
			expect(existsSync(join(dir, 'spool.json'))).toBe(false)
		} finally {
			process.chdir(cwd)
		}
	})

	it('--here works in a folder that has unrelated files', async () => {
		writeFileSync(join(dir, 'notes.txt'), 'mine')
		process.chdir(dir)

		try {
			await create(undefined, {
				here: true,
				name: 'acme',
				pm: 'pnpm',
				host: 'shell',
				remotes: '',
				install: false,
			})
			expect(existsSync(join(dir, 'spool.json'))).toBe(true)
		} finally {
			process.chdir(cwd)
		}
	})
})

describe('create without a terminal', () => {
	it('names the missing flag instead of prompting', async () => {
		const missing = [
			[{ name: 'acme', pm: 'pnpm', remotes: '' }, '--host'],
			[{ name: 'acme', pm: 'pnpm', host: 'shell' }, '--remotes'],
			[{ name: 'acme', host: 'shell', remotes: '' }, '--pm'],
			[{ pm: 'pnpm', host: 'shell', remotes: '' }, '--name'],
		] as const

		for (const [opts, flag] of missing) {
			await expect(create(undefined, { ...opts, here: true })).rejects.toMatchObject({
				code: 'INPUT_REQUIRED',
				message: expect.stringContaining(flag),
			})
		}
	})
})
