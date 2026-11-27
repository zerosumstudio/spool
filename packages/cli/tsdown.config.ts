import { defineConfig } from 'tsdown'
import { STATIC_FILES } from './src/core/templates/static-files.ts'

const shared = {
	format: 'esm',
	platform: 'node',
	target: 'node26',
	minify: false,
	sourcemap: false,
	outDir: 'dist',
	outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
} as const

export default defineConfig([
	{
		...shared,
		// The `bin` entry. Its shebang lives in src/index.ts.
		entry: { index: 'src/index.ts' },
		dts: false,
		clean: true,
		// Static files a generated app gets unchanged; see templates/static-files.ts.
		copy: Object.keys(STATIC_FILES).map(folder => ({
			from: `src/core/templates/${folder}/*.{ts,tsx,vue,svelte}`,
			to: `dist/${folder}`,
			flatten: true,
		})),
	},
	{
		...shared,
		// The `./vite` export that generated vite configs import.
		entry: { vite: 'src/vite.ts' },
		dts: true,
		clean: false,
	},
])
