import { createSubscriber } from 'svelte/reactivity'
import { getLocation, subscribe, type SpoolLocation } from './history'

const track = createSubscriber(update => subscribe(update))

/** The current url. Reading `location.current` in a component or an effect re-runs it on navigation. */
export const location = {
	get current(): SpoolLocation {
		track()

		return getLocation()
	},
}
