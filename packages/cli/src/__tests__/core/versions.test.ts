/*
 *   IMPORTS
 ***************************************************************************************************/
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { workspaceFiles } from '../../core/generators.js'
import { CLI_VERSION, TOOLCHAIN } from '../../core/versions.js'
import { host, makeManifest } from '../helpers.js'
import { compareVersions, rangeFloor } from '../../util/semver.js'

/*
 *   TEST SETUP
 ***************************************************************************************************/
interface PackageJson {
	dependencies?: Record<string, string>
	devDependencies?: Record<string, string>
}

const cli = createRequire(import.meta.url)('../../../package.json') as PackageJson

/*
 *   TOOLCHAIN DRIFT
 ***************************************************************************************************/
describe('TOOLCHAIN', () => {
	it('does not fall a major behind the versions the CLI itself runs', () => {
		const own = { ...cli.dependencies, ...cli.devDependencies }
		let checked = 0

		for (const [dep, range] of Object.entries(TOOLCHAIN)) {
			const mine = own[dep]
			if (mine === undefined) continue

			const floor = rangeFloor(range)
			const theirs = rangeFloor(mine)
			expect(floor, `TOOLCHAIN.${dep} is ${range}`).not.toBeNull()
			expect(theirs, `the cli's own ${dep} is ${mine}`).not.toBeNull()

			const where = `${dep}: TOOLCHAIN ${range}, cli ${mine}`
			expect(compareVersions(floor!, theirs!), where).toBeLessThanOrEqual(0)
			expect(theirs![0] - floor![0], where).toBeLessThanOrEqual(1)
			checked++
		}

		expect(
			checked,
			'no TOOLCHAIN dep overlaps the CLI, so this test proves nothing',
		).toBeGreaterThan(0)
	})
})

/*
 *   CLI VERSION
 ***************************************************************************************************/
describe('the generated spool range', () => {
	it("is the package's own version, so a new workspace asks for a release that exists", () => {
		const { version } = createRequire(import.meta.url)('../../../package.json') as {
			version: string
		}
		const files = workspaceFiles(makeManifest({ shell: host() }))
		const pkg = JSON.parse(files['package.json']!) as {
			devDependencies: Record<string, string>
		}

		expect(version).toBe('1.0.0')
		expect(pkg.devDependencies['@zerosumstudio/spool']).toBe(`^${version}`)
		expect(CLI_VERSION).toBe(version)
	})
})

/*
 *   RENOVATE
 ***************************************************************************************************/
describe('renovate watches the ranges generated workspaces get', () => {
	const repoRoot = join(import.meta.dirname, '../../../../..')
	const renovate = JSON.parse(readFileSync(join(repoRoot, 'renovate.json'), 'utf8')) as {
		customManagers: {
			managerFilePatterns: string[]
			matchStrings: string[]
			depNameTemplate?: string
		}[]
		packageRules: { matchPackageNames?: string[]; dependencyDashboardApproval?: boolean }[]
	}
	const source = readFileSync(join(import.meta.dirname, '../../core/versions.ts'), 'utf8')

	const found = renovate.customManagers
		.filter(manager =>
			manager.managerFilePatterns.some(pattern => pattern.includes('versions')),
		)
		.flatMap(manager =>
			manager.matchStrings.flatMap(pattern =>
				[...source.matchAll(new RegExp(pattern, 'g'))].map(
					match => manager.depNameTemplate ?? match.groups?.depName,
				),
			),
		)

	it('reads every toolchain and addon range, and the version constants', () => {
		for (const dep of ['react', '@types/node', 'vite', '@ladle/react', 'eslint', 'vitest']) {
			expect(found, dep).toContain(dep)
		}
		for (const dep of ['pnpm', 'turbo', '@sentry/browser', '@sentry/vite-plugin']) {
			expect(found, dep).toContain(dep)
		}
	})

	it('holds @module-federation packages back for approval, since the templates pin them', () => {
		const rule = renovate.packageRules.find(r =>
			r.matchPackageNames?.includes('@module-federation/*'),
		)

		expect(rule?.dependencyDashboardApproval).toBe(true)
	})
})
