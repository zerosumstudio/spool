/**
 * `src/vite-env.d.ts`. The env vars spool's templates read are typed here, so lint does not see
 * the `any` vite's own index signature gives every other key. `declarations` is whatever the
 * framework adds, e.g. a module declaration for its single-file components.
 */
export function viteEnvFile(declarations: string): string {
	return `/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly VITE_SENTRY_DSN?: string
	readonly VITE_SPOOL_ENV?: string
}
${declarations}`
}
