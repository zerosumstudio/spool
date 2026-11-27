/*
 *   IMPORTS
 ***************************************************************************************************/
import { WORKSPACE_FILE, type AppConfig, type Framework, type Manifest } from './config.js'
import type { FileMap } from './filemap.js'
import { PRETTIER_OPTIONS } from './format.js'
import { printJson, printStringifiedJson } from './json-format.js'
import {
	appDependencies,
	FRAMEWORK_DEPS,
	NODE_RANGE,
	NODE_VERSION,
	PNPM_VERSION,
	rootDevDependencies,
} from './versions.js'
import { yamlKey } from '../util/names.js'
import {
	ALIAS_FILE,
	remoteAliasModule,
	remoteStubs,
	TEST_SCRIPTS,
	typeCheckAll,
	vitestConfig,
} from './templates/quality.js'
import {
	NO_EXTRAS,
	TEMPLATES,
	remoteRefs,
	type RemoteRef,
	type RemoteTypingContext,
	type TemplateExtras,
} from './templates/index.js'
import { helperFiles } from './templates/helpers.js'
import { formatArrayProperty } from './templates/layout.js'
import { DEPLOY_ENVIRONMENT } from './templates/workflows.js'
import { sentryVitePlugin } from './templates/sentry.js'
import { federationFiles } from './templates/composition.js'

/*
 *   TYPES
 ***************************************************************************************************/

/*
 *   HELPERS
 ***************************************************************************************************/
const json = (value: unknown): string => printJson(value)

/** The generated helpers as a writable FileMap; `spool add` uses it to self-heal. */

/**
 * Reads spool.json at import time like the vite helper does, so anything
 * built on it stays right as apps come and go. A hand-kept copy of the app
 * list is the thing this exists to delete.
 */
/*
 *   WORKSPACE FILES
 ***************************************************************************************************/
/** Workspace-root files, generated once by `spool create`. */
export function workspaceFiles(m: Manifest, allowBuilds: string[] = []): FileMap {
	const files: FileMap = {
		'spool.json': json(m),
		...helperFiles(),
		'.nvmrc': `${NODE_VERSION}\n`,
		'.prettierrc': prettierrc(m),
		// The package manager writes the lockfile and pnpm rewrites the workspace file, each in its own style.
		'.prettierignore': `pnpm-lock.yaml\npnpm-workspace.yaml\npackage-lock.json\nyarn.lock\n.yarn/\n`,
		'package.json': workspacePackageJson(m),
		'.gitignore': gitignore(m),
		// Otherwise a file authored on Windows shows as entirely changed to
		// everyone else the first time they touch it.
		'.gitattributes': `* text=auto eol=lf\n`,
		'tsconfig.base.json': json({
			compilerOptions: {
				target: 'ES2022',
				lib: ['ES2022', 'DOM', 'DOM.Iterable'],
				module: 'ESNext',
				moduleResolution: 'Bundler',
				strict: true,
				noUncheckedIndexedAccess: true,
				noImplicitOverride: true,
				verbatimModuleSyntax: true,
				skipLibCheck: true,
				forceConsistentCasingInFileNames: true,
				isolatedModules: true,
				noEmit: true,
			},
		}),
		// Root-level project so editors type-check the workspace helper.
		'tsconfig.json': json({
			extends: './tsconfig.base.json',
			// TypeScript 6 stopped auto-including @types, and the helper is node code.
			compilerOptions: { types: ['node'] },
			include: [WORKSPACE_FILE],
		}),
		'README.md': workspaceReadme(m),
	}

	// pnpm declares its workspace (and its postinstall-script allowlist) in a
	// dedicated file; npm and yarn read a `workspaces` field in package.json.
	if (m.packageManager === 'pnpm') {
		const builds = [...new Set(['esbuild', ...allowBuilds])].sort()
		files['pnpm-workspace.yaml'] =
			`packages:\n  - 'apps/*'\n  - 'packages/*'\n\n# These postinstall scripts fetch platform binaries (esbuild via vite).\n# allowBuilds is the pnpm 11+ spelling; onlyBuiltDependencies covers pnpm 10.\nallowBuilds:\n${builds.map(build => `  ${yamlKey(build)}: true`).join('\n')}\nonlyBuiltDependencies:\n${builds.map(build => `  - ${yamlKey(build)}`).join('\n')}\n`
	}

	// Yarn Berry defaults to Plug'n'Play, which breaks Vite and Module
	// Federation. Pin the node_modules linker; Yarn Classic ignores this file.
	if (m.packageManager === 'yarn') {
		files['.yarnrc.yml'] =
			`# Use the node_modules linker instead of Plug'n'Play so Vite and Module\n# Federation resolve dependencies the way they expect. Honored by Yarn 3+;\n# Yarn 1 ignores this file and already uses node_modules.\nnodeLinker: node-modules\n`
	}
	return files
}

/**
 * Prettier reads a `.prettierrc` as YAML, and checks it as YAML, so the house style is written
 * as plain YAML. JSON in that file would be reformatted by `prettier --check`. A workspace that
 * lints and has a Svelte app lists the Svelte plugin, which `rootDevDependencies` installs: a
 * plugin that is listed but missing makes prettier fail.
 */
export function prettierrc(m: Manifest): string {
	const options = Object.entries(PRETTIER_OPTIONS).map(
		([key, value]) => `${key}: ${String(value)}`,
	)
	const plugins = hasSveltePlugin(m) ? ['plugins:', '    - prettier-plugin-svelte'] : []

	return `${[...options, ...plugins].join('\n')}\n`
}

function hasSveltePlugin(m: Manifest): boolean {
	return (
		m.addons.includes('lint') && Object.values(m.apps).some(app => app.framework === 'svelte')
	)
}

function gitignore(m: Manifest): string {
	// .spool/generated.json and deploys.json are committed; types and pidfiles are regenerated.
	const base = `node_modules/\ndist/\n.spool/types/\n.spool/*.pid\n*.tsbuildinfo\n.DS_Store\n*.log\n.env\n.env.*\n!.env.example\n`
	if (m.packageManager !== 'yarn') return base
	// Yarn Berry writes these; the allowlist keeps committed Berry assets while
	// ignoring the cache and PnP files. Harmless under Yarn Classic.
	return `${base}\n# Yarn Berry\n.yarn/*\n!.yarn/patches\n!.yarn/plugins\n!.yarn/releases\n!.yarn/sdks\n!.yarn/versions\n.pnp.*\n`
}

export function workspaceScripts(m: Manifest): Record<string, string> {
	const scripts: Record<string, string> = {
		dev: 'spool dev',
		build: 'spool build',
		preview: 'spool preview',
		doctor: 'spool doctor',
		'type-check': `spool types && ${typeCheckAll(m)}`,
	}

	if (m.addons.includes('lint')) {
		scripts.lint = 'eslint .'
		scripts.format = 'prettier --write .'
		scripts['format:check'] = 'prettier --check .'
	}
	if (m.addons.includes('test')) scripts.test = testAll(m)

	return scripts
}

/** Run every package that has a test script, however this manager spells it. */
function testAll(m: Manifest): string {
	if (m.packageManager === 'npm') return 'npm run test --workspaces --if-present'
	if (m.packageManager === 'yarn') return 'yarn workspaces foreach -A run test'
	return 'pnpm -r test'
}

function workspacePackageJson(m: Manifest): string {
	const pkg: Record<string, unknown> = {
		// A root named like a dependency (ws, vite) is resolved by pnpm as that package.
		name: `${m.name}-workspace`,
		version: '0.0.0',
		private: true,
		type: 'module',
		engines: { node: NODE_RANGE },
		scripts: workspaceScripts(m),
	}

	if (m.packageManager === 'pnpm') {
		// pnpm/action-setup and corepack read the version from here.
		pkg.packageManager = `pnpm@${PNPM_VERSION}`
	} else {
		pkg.workspaces = ['apps/*', 'packages/*']
	}

	pkg.devDependencies = sortKeys(rootDevDependencies(m))
	return printStringifiedJson(pkg)
}

function workspaceReadme(m: Manifest): string {
	return `# ${m.name}\n\nMicro-frontend workspace scaffolded with [spool](https://github.com/zerosumstudio/spool).\n\nAll federation wiring lives in \`spool.json\`; each app's \`vite.config.ts\` reads it\nthrough \`@zerosumstudio/spool/vite\` when vite loads it, so editing the manifest is all you ever do.\n\nRequires Node 26 or newer.\n\n## Commands\n\n\`\`\`bash\n${m.packageManager} install    # install all apps\nspool dev           # run host + remotes together\nspool build         # coordinated production build\nspool preview       # serve the built apps locally\nspool deploy        # run each app's deploy command\nspool add <name>    # add a host or remote app\nspool remove <name> # remove an app and unwire it\nspool addon <name>  # add extras\nspool types         # type each remote's exposes\nspool ci            # generate per-app deploy workflows\nspool upgrade       # sync generated files to the installed spool\nspool doctor        # check ports, wiring and shared deps\nspool eject         # remove spool, keep the generated files\n\`\`\`\n\n## Deploying remotes\n\nA host resolves each remote in this order:\n\n1. \`SPOOL_REMOTE_<NAME>\` env var (ad-hoc override, e.g. point one remote at staging)\n2. the remote's \`urls\` entry for \`SPOOL_ENV\` / \`--env\` (production builds only)\n3. the remote's \`url\` in \`spool.json\` (its deployed \`mf-manifest.json\`, used in production builds)\n4. \`http://localhost:<port>/mf-manifest.json\` (local dev)\n\n## Deploy secrets in CI\n\nA deploy job passes no secrets by default. List the ones an app's deploy command reads in \`deployEnv\` in \`spool.json\`, then rerun \`spool ci --force\`.\n\n\`spool ci\` writes one deploy workflow per app, each running in the \`${DEPLOY_ENVIRONMENT}\` GitHub environment. An environment accepts every branch until you restrict it, so in Settings > Environments set Deployment branches to \`main\` and add required reviewers. Without that, anyone with write access can run the workflow from their own branch and read the deploy secrets.\n\nCommit \`.spool/generated.json\`: it lets \`spool upgrade\` tell your edits from spool's own output.\n`
}

/*
 *   APPS
 ***************************************************************************************************/
export function defaultExposes(framework: Framework): Record<string, string> {
	return { './App': TEMPLATES[framework].exposeEntry }
}

export function appFiles(
	m: Manifest,
	appName: string,
	app: AppConfig,
	extras: TemplateExtras = NO_EXTRAS,
	root: string = process.cwd(),
): FileMap {
	const isHost = app.type === 'host'
	const refs = app.remotes.length ? remoteRefs(m, app) : []
	const files: FileMap = {
		'package.json': appPackageJson(m, appName, app, extras),
		'tsconfig.json': appTsConfig(app.framework, m.addons.includes('test')),
		'index.html': indexHtml(appName, app.framework),
		'src/vite-env.d.ts': TEMPLATES[app.framework].viteEnv,
		...TEMPLATES[app.framework].sourceFiles(appName, isHost, refs, extras),
		...appConfigFiles(appName, app, m.addons.includes('sentry')),
		...(isHost || app.remotes.length ? federationFiles(m, app) : {}),
	}

	if (refs.length) {
		files['src/remotes.d.ts'] = remoteTypings(refs, { root, hostPath: app.path })
	}
	if (m.addons.includes('test')) {
		files['vitest.config.ts'] = vitestConfig(app.framework)
		files[ALIAS_FILE] = remoteAliasModule(m, app)
		Object.assign(files, remoteStubs(m, app))
	}
	return files
}

/**
 * The generated files `spool upgrade` refreshes on every run. Response headers are
 * not among them: the `@zerosumstudio/spool/vite` plugin writes `_headers` at build.
 */
export function appConfigFiles(appName: string, app: AppConfig, sentry = false): FileMap {
	return {
		'vite.config.ts': viteConfig(appName, app, sentry),
	}
}

/**
 * Host files to rewrite when its remotes change. Only the ambient typings;
 * the vite config reads spool.json itself.
 */
export function hostWiringFiles(
	m: Manifest,
	host: AppConfig,
	root: string = process.cwd(),
): FileMap {
	const files: FileMap = {}
	if (host.type !== 'host' && !host.remotes.length) return files
	if (host.remotes.length) {
		files['src/remotes.d.ts'] = remoteTypings(remoteRefs(m, host), {
			root,
			hostPath: host.path,
		})
	}

	// The registry and the <Remote> primitive both depend on the host's remotes
	// (the primitive imports the react bridge only when one needs it), so both
	// are regenerated together whenever the remotes change.
	Object.assign(files, federationFiles(m, host))

	// Only the alias map names the remotes; vitest.config.ts stays the user’s.
	if (m.addons.includes('test')) {
		files[ALIAS_FILE] = remoteAliasModule(m, host)
		Object.assign(files, remoteStubs(m, host))
	}
	return files
}

/*
 *   FILE BUILDERS
 ***************************************************************************************************/
function appPackageJson(
	m: Manifest,
	appName: string,
	app: AppConfig,
	extras: TemplateExtras,
): string {
	const { dependencies, devDependencies } = appDependencies(m, app)

	// The example button lives in the ladle ui workspace package; npm and yarn
	// link workspace packages by bare name, pnpm needs the workspace protocol.
	if (extras.uiButton && app.framework === 'react' && app.type === 'remote') {
		dependencies.ui = m.packageManager === 'pnpm' ? 'workspace:*' : '*'
	}

	return printStringifiedJson({
		name: appName,
		version: '0.0.0',
		private: true,
		type: 'module',
		engines: { node: NODE_RANGE },
		scripts: {
			dev: 'vite',
			build: 'vite build',
			preview: 'vite preview',
			'type-check': TYPE_CHECK[app.framework],
			...(m.addons.includes('test') ? TEST_SCRIPTS : {}),
		},
		dependencies: sortKeys(dependencies),
		devDependencies: sortKeys(devDependencies),
	})
}

/** Plain tsc cannot read .vue or .svelte files, so those frameworks bring their own checker. */
const TYPE_CHECK: Record<Framework, string> = {
	react: 'tsc --noEmit',
	vue: 'vue-tsc --noEmit',
	svelte: 'svelte-check --tsconfig ./tsconfig.json',
}

function sortKeys(record: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)))
}

function appTsConfig(framework: Framework, hasTest: boolean): string {
	// Compiler options like the JSX runtime are per app, so one framework's
	// settings never leak into another's through the shared base config. `@`
	// maps to src (matched by the vite alias) so apps import from "@/...".
	return json({
		extends: '../../tsconfig.base.json',
		compilerOptions: {
			...TEMPLATES[framework].compilerOptions,
			paths: { '@/*': ['./src/*'] },
		},
		include: ['src', 'vite.config.ts', ...(hasTest ? ['vitest.config.ts'] : [])],
	})
}

/** Node's own modules first, then packages by name. */
function sortImports(lines: string[]): string {
	const specifier = (line: string): string => /from '([^']+)'/.exec(line)?.[1] ?? line
	const isNode = (line: string): boolean => specifier(line).startsWith('node:')

	return [...lines]
		.sort(
			(a, b) =>
				Number(isNode(b)) - Number(isNode(a)) || specifier(a).localeCompare(specifier(b)),
		)
		.join('\n')
}

export function viteConfig(appName: string, app: AppConfig, sentry: boolean): string {
	const plugin = TEMPLATES[app.framework].vitePlugin
	const sentryPlugin = sentry ? sentryVitePlugin(appName) : undefined

	const imports = sortImports([
		"import { defineConfig } from 'vite'",
		"import { resolve as resolvePath } from 'node:path'",
		...plugin.importLine.split('\n'),
		"import { federation } from '@module-federation/vite'",
		...(sentryPlugin ? sentryPlugin.importLine.split('\n') : []),
		"import { spoolApp } from '@zerosumstudio/spool/vite'",
	])

	const plugins = [
		plugin.call,
		'federation(app.federation)',
		'app.plugin',
		...(sentryPlugin ? [sentryPlugin.entry] : []),
	]

	const buildOptions = sentry
		? "{ target: 'esnext', sourcemap: 'hidden' }"
		: "{ target: 'esnext' }"
	const dedupe = FRAMEWORK_DEPS[app.framework].dependencies.map(dep => `'${dep}'`)
	const helper = sentryPlugin ? `\n${sentryPlugin.helper}` : ''

	return `${imports}
${helper}
// Generated by spool. Wiring comes from spool.json when vite loads this file.
// Edit spool.json, not this file.
export default defineConfig(({ command }) => {
	const app = spoolApp('${appName}', { root: import.meta.dirname, command })

	return {
		server: app.server,
		preview: app.server,
		// dedupe keeps one copy of the framework when a linked library brings its own.
		resolve: {
			alias: { '@': resolvePath(import.meta.dirname, 'src') },
${formatArrayProperty('dedupe', dedupe, 3)}
		},
${formatArrayProperty('plugins', plugins, 2)}
		// Module Federation needs top-level await, so the target is locked.
		build: ${buildOptions},
	}
})
`
}

function indexHtml(appName: string, framework: Framework): string {
	const entry = TEMPLATES[framework].htmlEntry
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0" />
		<title>${appName}</title>
	</head>
	<body>
		<div id="root"></div>
		<script type="module" src="${entry}"></script>
	</body>
</html>
`
}

function remoteTypings(refs: RemoteRef[], ctx: RemoteTypingContext): string {
	return refs.map(ref => TEMPLATES[ref.framework].remoteTyping(ref, ctx)).join('')
}
