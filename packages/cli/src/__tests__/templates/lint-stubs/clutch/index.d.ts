export interface Plugin<State extends object> {
	name: string
	onInit?(state: State): void
}

export interface Store<State extends object> {
	getState(): State
	subscribe(listener: (state: State) => void): () => void
	set(update: Partial<State> | ((state: State) => Partial<State>), description?: string): void
	with(plugin: Plugin<State>): this
}

export function createStore<State extends object>(config: { initialState: State }): Store<State>

export function sharedStore<Shared>(
	key: string,
	factory: () => Shared,
	config?: {
		contract?: number | string
		version?: number
		migrate?: (previousState: unknown, fromVersion: number) => unknown
	},
): Shared

export function validate<State extends object>(
	validator: (state: State) => boolean | string,
): Plugin<State>
