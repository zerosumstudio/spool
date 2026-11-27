/*
 *   IMPORTS
 ***************************************************************************************************/
import { defineConfig, configDefaults } from 'vitest/config'

/*
 *   VITEST CONFIG
 ***************************************************************************************************/
export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		setupFiles: ['./src/__tests__/setup.ts'],
		include: ['src/**/*.{test,spec}.ts'],
		// `*.spawn.test.ts` starts real child processes; it runs only on request, never by default
		exclude: [...configDefaults.exclude, '**/*.spawn.test.ts'],
		pool: 'forks',
		maxWorkers: 2,
		clearMocks: true,
		restoreMocks: true,
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json', 'html', 'lcov'],
			include: ['src/**/*.ts'],
			exclude: ['src/index.ts', 'src/__tests__/**', '**/*.d.ts', '**/*.config.*', 'dist/**'],
		},
	},
})
