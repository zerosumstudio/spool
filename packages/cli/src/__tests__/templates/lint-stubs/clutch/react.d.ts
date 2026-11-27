import type { Store } from './index'

export function useStore<State extends object>(store: Store<State>): State
export function useStore<State extends object, Selected>(
	store: Store<State>,
	selector: (state: State) => Selected,
	isEqual?: (a: Selected, b: Selected) => boolean,
): Selected
