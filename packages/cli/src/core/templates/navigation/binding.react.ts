import { useSyncExternalStore } from 'react'
import { getLocation, subscribe, type SpoolLocation } from './history'

export function useLocation(): SpoolLocation {
	return useSyncExternalStore(subscribe, getLocation, getLocation)
}
