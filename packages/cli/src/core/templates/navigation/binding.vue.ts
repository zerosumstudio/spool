import { onScopeDispose, shallowRef, type ShallowRef } from 'vue'
import { getLocation, subscribe, type SpoolLocation } from './history'

export function useLocation(): ShallowRef<SpoolLocation> {
	const location = shallowRef<SpoolLocation>(getLocation())
	const stop = subscribe(() => {
		location.value = getLocation()
	})
	onScopeDispose(stop)

	return location
}
