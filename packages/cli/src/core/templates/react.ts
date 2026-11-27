/*
 *   IMPORTS
 ***************************************************************************************************/
import { STATE_COUNT_TESTID, STATE_COUNT_TEXT, STATE_STORE_IMPORT } from './bridges.js'
import { compositionHostApp } from './composition.js'
import { typedExposeDeclaration } from './expose-typing.js'
import { viteEnvFile } from './vite-env.js'
import type { FrameworkTemplate, RemoteRef, TemplateExtras } from './types.js'

export const reactTemplate: FrameworkTemplate = {
	remoteContract: 'component',
	exposeEntry: './src/app/app.tsx',
	htmlEntry: '/src/main.tsx',
	viteEnv: viteEnvFile(''),
	compilerOptions: { jsx: 'react-jsx' },
	vitePlugin: { importLine: "import react from '@vitejs/plugin-react'", call: 'react()' },
	remoteTyping: (ref, ctx) =>
		ref.exposes
			.map(expose => {
				const typed = typedExposeDeclaration(ref, expose, ctx)

				if (typed) return typed

				return `// Run \`spool types\` to type this from the remote's real export.
declare module '${ref.name}/${expose}' {
	const Component: React.ComponentType
	export default Component
}
`
			})
			.join(''),
	sourceFiles: (appName, isHost, refs, extras) => ({
		'src/main.tsx': mainTsx(extras),
		'src/app/app.tsx': isHost ? hostAppFile(appName, refs, extras) : remoteApp(appName, extras),
		'src/app/app.module.css': appStyles(),
	}),
	bridgeFiles: () => ({}),
}

/*
 *   FILE BUILDERS
 ***************************************************************************************************/
function mainTsx(extras: TemplateExtras): string {
	const sentryImport = extras.sentry ? `import { initSentry } from './sentry'\n` : ''
	const sentryCall = extras.sentry ? `initSentry()\n\n` : ''

	return `${sentryImport}import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from '@/app/app'

${sentryCall}const root = document.getElementById('root')

if (!root) throw new Error('index.html has no #root element')

createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
)
`
}

function appStyles(): string {
	return `.app {
	font-family: system-ui;
	padding: 1rem;
	border: 1px solid #ccc;
}

.host {
	font-family: system-ui;
	padding: 1.5rem;
}

.shell {
	font-family: system-ui;
}

.nav {
	display: flex;
	gap: 8px;
	padding: 12px;
	border-bottom: 1px solid #ccc;
}

.path {
	padding: 8px 12px;
	color: #666;
}

.main {
	padding: 12px;
}
`
}

function hostAppFile(appName: string, refs: RemoteRef[], extras: TemplateExtras): string {
	return extras.composed
		? compositionHostApp('react', appName, refs)
		: hostApp(appName, refs, extras)
}

function hostApp(appName: string, refs: RemoteRef[], extras: TemplateExtras): string {
	const remoteImport = refs.length ? `import { Remote } from '@/federation'\n` : ''
	const stateImports = extras.stateExample
		? `import { useStore } from '@zerosumstudio/clutch/react'\nimport { counterStore } from '${STATE_STORE_IMPORT}'\n`
		: ''
	const stateHook = extras.stateExample
		? `	const count = useStore(counterStore, s => s.count)\n\n`
		: ''
	const stateLine = extras.stateExample
		? `\n			<p data-testid="${STATE_COUNT_TESTID}">${STATE_COUNT_TEXT} {count}</p>`
		: ''

	const sections = refs
		.map(
			r => `			<section>
				<h2>${r.name}</h2>
				<Remote name="${r.name}" fallback={<p>Loading ${r.name}...</p>} />
			</section>`,
		)
		.join('\n')
	const noRemotes = `			<p>No remotes mounted yet.</p>`

	return `${remoteImport}${stateImports}
import styles from './app.module.css'

export default function App() {
${stateHook}	return (
		<main className={styles.host}>
			<h1>${appName} (host)</h1>${stateLine}
${sections || noRemotes}
		</main>
	)
}
`
}

function remoteApp(appName: string, extras: TemplateExtras): string {
	if (!extras.stateExample) {
		return `import styles from './app.module.css'

export default function App() {
	return (
		<div className={styles.app}>
			<strong>${appName}</strong>: a remote module exposed via Module Federation.
		</div>
	)
}
`
	}

	const buttonImport = extras.uiButton ? `\nimport { Button } from 'ui'` : ''
	const button = extras.uiButton
		? `<Button onClick={handleIncrement}>Increment</Button>`
		: `<button onClick={handleIncrement}>Increment</button>`

	return `import { useStore } from '@zerosumstudio/clutch/react'
import { counterStore } from '${STATE_STORE_IMPORT}'${buttonImport}

import styles from './app.module.css'

export default function App() {
	const count = useStore(counterStore, s => s.count)
	const handleIncrement = () => {
		counterStore.set(s => ({ count: s.count + 1 }))
	}

	return (
		<div className={styles.app}>
			<p>
				<strong>${appName}</strong>: a remote module exposed via Module Federation.
			</p>
			<p>${STATE_COUNT_TEXT} {count}</p>
			${button}
		</div>
	)
}
`
}
