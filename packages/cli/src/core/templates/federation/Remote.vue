<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import {
	createRemoteLoader,
	warnUnknownRemote,
	type RemoteError,
	type RemoteLoader,
	type RemoteState,
} from './core'
import { remotes, type RemoteEntry, type RemoteName } from './remotes'
import { reportRemoteError } from './report'

type MountFunction = (target: HTMLElement, props?: object) => () => void

const input = defineProps<{
	name: RemoteName
	/** Forwarded to the remote's mount(el, props). */
	props?: object
}>()
const emit = defineEmits<{
	/** The remote failed to load. */
	error: [error: RemoteError, name: RemoteName]
}>()
defineSlots<{
	/** Shown while the remote is still loading. */
	fallback?(): unknown
	/** Shown when it fails to load. Call retry to start the load over. */
	error?(scope: { error: RemoteError; retry: () => void }): unknown
}>()

// Undefined while the name is not in the registry.
const state = shallowRef<RemoteState>()
const target = ref<HTMLElement | null>(null)
let loader: RemoteLoader | undefined
let stop: (() => void) | undefined

const needsReload = computed(() => state.value?.status === 'error' && state.value.error.needsReload)

function retry(): void {
	loader?.retry()
}

function handleDefaultAction(): void {
	if (needsReload.value) window.location.reload()
	else retry()
}

function sync(current: RemoteLoader, name: RemoteName): void {
	const next = current.getState()
	if (next === state.value) return

	state.value = next
	if (next.status === 'error') {
		reportRemoteError(name, next.error)
		emit('error', next.error, name)
	}
}

watch(
	() => input.name,
	name => {
		stop?.()
		stop = undefined

		const entry = remotes[name] as RemoteEntry | undefined
		if (!entry) {
			warnUnknownRemote(name)
			loader = undefined
			state.value = undefined

			return
		}

		const current = createRemoteLoader(name, entry.load)
		loader = current
		stop = current.subscribe(() => {
			sync(current, name)
		})
		sync(current, name)
	},
	{ immediate: true },
)

watch(
	[state, target],
	([current, element], _previous, onCleanup) => {
		if (current?.status !== 'ready' || !element) return

		const entry = remotes[input.name] as RemoteEntry | undefined
		const mount = current.module.default
		const unmount =
			entry?.contract === 'component'
				? entry.mountComponent?.(mount, element, input.props)
				: (mount as MountFunction)(element, input.props)
		if (unmount) onCleanup(unmount)
	},
	{ flush: 'post' },
)

onBeforeUnmount(() => {
	stop?.()
})
</script>

<template>
	<slot v-if="state?.status === 'loading'" name="fallback" />
	<template v-else-if="state?.status === 'error'">
		<slot name="error" :error="state.error" :retry="retry">
			<div role="alert" data-remote-error>
				<p>This section could not be loaded.</p>
				<button type="button" @click="handleDefaultAction">
					{{ needsReload ? 'Reload page' : 'Try again' }}
				</button>
			</div>
		</slot>
	</template>
	<div ref="target"></div>
</template>
