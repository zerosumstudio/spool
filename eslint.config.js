import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
	globalIgnores([
		'**/dist',
		'**/node_modules',
		'**/coverage',
		'**/test-results',
		'**/.spool-lint*',
	]),
	{
		files: ['packages/*/src/**/*.{ts,tsx}', 'packages/*/e2e/**/*.ts'],
		extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'module',
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
			globals: globals.node,
		},
		rules: {
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
			],
			'@typescript-eslint/no-explicit-any': 'error',
			'@typescript-eslint/consistent-type-imports': [
				'error',
				{ fixStyle: 'inline-type-imports' },
			],
			'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
			'no-var': 'error',
			eqeqeq: ['error', 'always'],
			'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
			'@typescript-eslint/no-import-type-side-effects': 'error',
			'prefer-template': 'error',
			'@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
			'@typescript-eslint/no-confusing-void-expression': [
				'error',
				{ ignoreArrowShorthand: true, ignoreVoidOperator: true },
			],
			// `void` in a union is how a callback says it may return nothing
			'@typescript-eslint/no-invalid-void-type': 'off',
			'@typescript-eslint/no-non-null-assertion': 'error',
			'@typescript-eslint/no-dynamic-delete': 'error',
			complexity: ['warn', 10],
			'max-depth': ['warn', 3],
		},
	},
	{
		// Tests poke at internals on purpose: mocks, casts, and values only known at run time
		files: ['packages/*/src/**/__tests__/**/*.ts', 'packages/*/e2e/**/*.ts'],
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-non-null-assertion': 'off',
			'@typescript-eslint/no-unsafe-assignment': 'off',
			'@typescript-eslint/no-unsafe-call': 'off',
			'@typescript-eslint/no-unsafe-member-access': 'off',
			'@typescript-eslint/no-unsafe-argument': 'off',
			'@typescript-eslint/no-unsafe-return': 'off',
			'@typescript-eslint/unbound-method': 'off',
			'@typescript-eslint/require-await': 'off',
			'@typescript-eslint/no-unnecessary-condition': 'off',
			'@typescript-eslint/no-extraneous-class': 'off',
			'@typescript-eslint/no-dynamic-delete': 'off',
			complexity: 'off',
			'max-depth': 'off',
		},
	},
	{
		// Config files sit outside the TypeScript project, so no type information here
		files: ['**/*.config.ts', '**/*.config.js'],
		extends: [js.configs.recommended, tseslint.configs.strict],
		languageOptions: { globals: globals.node },
	},
])
