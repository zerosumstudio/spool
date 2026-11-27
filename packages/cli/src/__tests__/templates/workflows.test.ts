/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as prettier from 'prettier'
import { PRETTIER_OPTIONS } from '../../core/format.js'
import { ACTION_PINS, actionRef, ciWorkflows } from '../../core/templates/workflows.js'
import { NODE_VERSION } from '../../core/versions.js'
import { makeManifest, host, remote } from '../helpers.js'

/*
 *   HELPERS
 ***************************************************************************************************/
const REPO_ROOT = join(import.meta.dirname, '../../../../..')

const deploy = (yaml: Record<string, string>, name = 'dashboard'): string =>
	yaml[`.github/workflows/deploy-${name}.yml`]!

/*
 *   RAW GENERATION
 ***************************************************************************************************/
describe('ciWorkflows', () => {
	const m = makeManifest({
		shell: host({ remotes: ['dashboard'], deploy: 'deploy-shell-cmd' }),
		dashboard: remote({ deploy: 'wrangler pages deploy dist --project-name=dash' }),
	})

	it('writes values the way prettier writes YAML: single quotes', () => {
		const yaml = deploy(ciWorkflows(m))

		expect(yaml).toContain("working-directory: 'apps/dashboard'")
		expect(yaml).toContain("run: 'wrangler pages deploy dist --project-name=dash'")
		expect(yaml).toContain(`node-version: '${NODE_VERSION}'`)
		expect(yaml).toContain("cache: 'pnpm'")
	})

	it('quotes a deploy command that itself contains a colon, double quotes or an apostrophe', () => {
		for (const command of [
			'echo "release: v1" && wrangler deploy',
			"echo it's done && wrangler deploy",
			'echo \'both "kinds"\' && wrangler deploy',
		]) {
			const tricky = makeManifest({ dashboard: remote({ deploy: command }) })
			const yaml = deploy(ciWorkflows(tricky))

			expect(yaml).toMatch(/run: ['"]/)
		}
	})

	it('sets contents:read permissions and a concurrency group on both workflows', () => {
		const files = ciWorkflows(m)

		for (const yaml of [files['.github/workflows/ci.yml']!, deploy(files)]) {
			expect(yaml).toContain('permissions:\n    contents: read')
			expect(yaml).toContain('concurrency:')
		}
	})

	it('cancels superseded checks but never a deploy that is running', () => {
		const files = ciWorkflows(m)

		expect(files['.github/workflows/ci.yml']).toContain('cancel-in-progress: true')
		expect(deploy(files)).toContain('cancel-in-progress: false')
		expect(deploy(files)).not.toContain('cancel-in-progress: true')
	})

	it('sets persist-credentials: false on every checkout', () => {
		const files = ciWorkflows(m)
		const yaml = deploy(files)

		expect(files['.github/workflows/ci.yml']).toContain('persist-credentials: false')
		expect(yaml.match(/persist-credentials: false/g)).toHaveLength(2)
	})

	it('makes the deploy job need the check job', () => {
		const yaml = deploy(ciWorkflows(m))

		expect(yaml.indexOf('check:')).toBeLessThan(yaml.indexOf('needs: check'))
	})

	it('keeps workflow_dispatch on both workflows', () => {
		const files = ciWorkflows(m)

		expect(files['.github/workflows/ci.yml']).toContain('workflow_dispatch:')
		expect(deploy(files)).toContain('workflow_dispatch:')
	})

	describe('path filters', () => {
		it('includes the app folder and workspace-level files', () => {
			const yaml = deploy(ciWorkflows(m))

			expect(yaml).toContain("'apps/dashboard/**'")
			expect(yaml).toContain("'spool.json'")
			expect(yaml).not.toContain('spool.vite.ts')
			expect(yaml).toContain("'spool.workspace.ts'")
			expect(yaml).toContain("'tsconfig.base.json'")
			expect(yaml).toContain("'pnpm-lock.yaml'")
		})

		it('falls back to packages/** with no package globs given', () => {
			const yaml = deploy(ciWorkflows(m))

			expect(yaml).toContain("'packages/**'")
			expect(yaml).not.toContain("'apps/shell/**'")
		})

		it('uses the given package globs, excluding other apps own folders', () => {
			const yaml = deploy(ciWorkflows(m, {}, { packageGlobs: ['packages/ui', 'apps/shell'] }))

			expect(yaml).toContain("'packages/ui/**'")
			expect(yaml).not.toContain("'apps/shell/**'")
		})

		it('has no path filters on the check workflow', () => {
			expect(ciWorkflows(m)['.github/workflows/ci.yml']).not.toContain('paths:')
		})
	})

	describe('node version', () => {
		it('defaults to the node version the generated workspace pins', () => {
			expect(NODE_VERSION).toBe('26')
			expect(ciWorkflows(m)['.github/workflows/ci.yml']).toContain("node-version: '26'")
		})

		it('uses a given node version', () => {
			const yaml = ciWorkflows(m, {}, { nodeVersion: '24.1.0' })['.github/workflows/ci.yml']!

			expect(yaml).toContain("node-version: '24.1.0'")
		})
	})

	describe('the check workflow', () => {
		const scripts = { build: 'spool build', doctor: 'spool doctor', lint: 'eslint .' }

		it('runs the root scripts that exist, in a sensible order', () => {
			const yaml = ciWorkflows(m, scripts)['.github/workflows/ci.yml']!

			expect(yaml.indexOf('run doctor')).toBeLessThan(yaml.indexOf('run lint'))
			expect(yaml.indexOf('run lint')).toBeLessThan(yaml.indexOf('run build'))
		})

		it('leaves out a script the workspace does not have', () => {
			const yaml = ciWorkflows(m, scripts)['.github/workflows/ci.yml']!

			expect(yaml).not.toContain('run test')
			expect(yaml).not.toContain('run type-check')
		})

		it('skips the pnpm setup action for npm', () => {
			const npm = makeManifest({ dashboard: remote() })
			npm.packageManager = 'npm'
			const yaml = ciWorkflows(npm, scripts)['.github/workflows/ci.yml']!

			expect(yaml).toContain('npm ci')
			expect(yaml).not.toContain('pnpm/action-setup')
		})
	})
})

/*
 *   ACTION PINS
 ***************************************************************************************************/
describe('action pins', () => {
	const m = makeManifest({ dashboard: remote({ deploy: 'wrangler deploy' }) })
	const workflows = Object.values(ciWorkflows(m, { build: 'x' }))

	it('pins every action to a 40 character commit with its release tag in a comment', () => {
		for (const yaml of workflows) {
			const uses = [...yaml.matchAll(/uses: (\S+)(.*)/g)]

			expect(uses.length).toBeGreaterThan(0)
			for (const [, ref, comment] of uses) {
				expect(ref, yaml).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/)
				expect(comment).toMatch(/^ # v\d+\.\d+\.\d+$/)
			}
		}
	})

	it('never refers to an action by a moving tag', () => {
		for (const yaml of workflows) expect(yaml).not.toMatch(/uses: \S+@v\d/)
	})

	it('uses setup-node 7', () => {
		expect(ACTION_PINS.setupNode.tag).toMatch(/^v7\./)
		expect(workflows.join('\n')).toContain(actionRef('setupNode'))
	})

	it('writes the table entry into the workflow as owner/repo@sha # tag', () => {
		for (const key of Object.keys(ACTION_PINS) as (keyof typeof ACTION_PINS)[]) {
			const { action, sha, tag } = ACTION_PINS[key]

			expect(actionRef(key)).toBe(`${action}@${sha} # ${tag}`)
			expect(sha).toMatch(/^[0-9a-f]{40}$/)
		}
	})

	it('is the table renovate.json reads, entry for entry', () => {
		const source = readFileSync(
			join(REPO_ROOT, 'packages/cli/src/core/templates/workflows.ts'),
			'utf8',
		)
		const renovate = JSON.parse(readFileSync(join(REPO_ROOT, 'renovate.json'), 'utf8')) as {
			customManagers: { matchStrings: string[]; datasourceTemplate: string }[]
		}
		const manager = renovate.customManagers[0]!
		const pattern = new RegExp(manager.matchStrings[0]!, 'g')

		const found = [...source.matchAll(pattern)].map(match => ({
			action: match.groups!.depName,
			sha: match.groups!.currentDigest,
			tag: match.groups!.currentValue,
		}))

		expect(manager.datasourceTemplate).toBe('github-tags')
		expect(found).toEqual(Object.values(ACTION_PINS))
	})
})

/*
 *   DEPLOY SECRETS
 ***************************************************************************************************/
describe('deploy job', () => {
	it('runs in a GitHub environment, so its secrets reach this job only', () => {
		const m = makeManifest({ dashboard: remote({ deploy: 'wrangler deploy' }) })
		const yaml = deploy(ciWorkflows(m))
		const job = yaml.slice(yaml.indexOf('    deploy:'))

		expect(job).toContain('environment: production')
	})

	it('only runs on main, and says to restrict the environment to it', () => {
		const m = makeManifest({ dashboard: remote({ deploy: 'wrangler deploy' }) })
		const yaml = deploy(ciWorkflows(m))
		const job = yaml.slice(yaml.indexOf('    deploy:'))

		expect(job).toContain("if: github.ref == 'refs/heads/main'")
		expect(job).toContain('Deployment branches')
		expect(job).toContain('required reviewers')
	})

	it('passes only the secrets the app lists in deployEnv, as real env', () => {
		const m = makeManifest({
			dashboard: remote({
				deploy: 'wrangler deploy',
				deployEnv: ['CLOUDFLARE_API_TOKEN', 'SENTRY_AUTH_TOKEN'],
			}),
		})
		const yaml = deploy(ciWorkflows(m))

		expect(yaml).toContain(
			'              env:\n                  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n                  SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}',
		)
	})

	it('passes no secret at all by default, and says how to add one', () => {
		const m = makeManifest({ dashboard: remote({ deploy: 'wrangler deploy' }) })
		const yaml = deploy(ciWorkflows(m))

		expect(yaml).not.toContain('secrets.')
		expect(yaml).not.toContain('CLOUDFLARE')
		expect(yaml).not.toContain('env:\n                  ')
		expect(yaml).toContain('"deployEnv" in')
	})
})

/*
 *   HOUSE STYLE
 ***************************************************************************************************/
describe('generated workflows are already prettier clean', () => {
	for (const pm of ['pnpm', 'npm', 'yarn'] as const) {
		it(`for ${pm}, with and without deployEnv`, async () => {
			const m = makeManifest({
				shell: host({
					remotes: ['dashboard'],
					deploy: 'echo "it\'s: done"',
					deployEnv: ['TOKEN'],
				}),
				dashboard: remote({ deploy: 'wrangler pages deploy dist' }),
			})
			m.packageManager = pm

			for (const [rel, content] of Object.entries(
				ciWorkflows(
					m,
					{ doctor: 'x', lint: 'x', build: 'x' },
					{ packageGlobs: ['packages/ui'] },
				),
			)) {
				const clean = await prettier.check(content, { ...PRETTIER_OPTIONS, filepath: rel })

				expect(clean, rel).toBe(true)
			}
		})
	}
})

/*
 *   ONE PIN SET
 ***************************************************************************************************/
describe("this repository's own workflows", () => {
	const dir = join(REPO_ROOT, '.github/workflows')
	const used = readdirSync(dir)
		.filter(file => file.endsWith('.yml'))
		.flatMap(file =>
			[
				...readFileSync(join(dir, file), 'utf8').matchAll(
					/uses: (\S+)@([0-9a-f]{40}) # (\S+)/g,
				),
			].map(([, action, sha, tag]) => ({ file, action: action!, sha: sha!, tag: tag! })),
		)

	it('pin the actions in the generator table to the very same commits', () => {
		for (const { action, sha, tag } of Object.values(ACTION_PINS)) {
			const mine = used.filter(entry => entry.action === action)

			expect(mine.length, action).toBeGreaterThan(0)
			for (const entry of mine) {
				expect({ sha: entry.sha, tag: entry.tag }, `${entry.file}: ${action}`).toEqual({
					sha,
					tag,
				})
			}
		}
	})

	it('pin every action by commit', () => {
		for (const file of readdirSync(dir).filter(name => name.endsWith('.yml'))) {
			expect(readFileSync(join(dir, file), 'utf8'), file).not.toMatch(/uses: \S+@v\d/)
		}
	})
})
