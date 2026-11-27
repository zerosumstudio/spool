<script lang="ts">
	import { untrack, type Snippet } from 'svelte'
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

	interface Props {
		name: RemoteName
		/** Forwarded to the remote's mount(el, props). */
		props?: object
		/** Shown while the remote is still loading. */
		fallback?: Snippet
		/** Shown when it fails to load. Call retry to start the load over. */
		error?: Snippet<[RemoteError, () => void]>
		/** Called when it fails to load. */
		onError?: (error: RemoteError, name: RemoteName) => void
	}

	let { name, props, fallback, error, onError }: Props = $props()

	// Undefined while the name is not in the registry.
	let remote = $state.raw<RemoteState>()
	let target = $state<HTMLElement>()
	let loader: RemoteLoader | undefined

	function retry(): void {
		loader?.retry()
	}

	function reloadPage(): void {
		window.location.reload()
	}

	$effect(() => {
		const current = name
		const entry = remotes[current] as RemoteEntry | undefined
		if (!entry) {
			warnUnknownRemote(current)
			loader = undefined
			remote = undefined

			return
		}

		const next = createRemoteLoader(current, entry.load)
		let shown: RemoteState | undefined
		const sync = () => {
			const latest = next.getState()
			if (latest === shown) return

			shown = latest
			remote = latest
			if (latest.status === 'error') {
				reportRemoteError(current, latest.error)
				onError?.(latest.error, current)
			}
		}

		loader = next
		const stop = next.subscribe(sync)
		untrack(sync)

		return stop
	})

	$effect(() => {
		if (remote?.status !== 'ready' || !target) return

		const element = target
		const mount = remote.module.default

		return untrack(() => {
			const entry = remotes[name] as RemoteEntry | undefined
			const isComponent = entry?.contract === 'component'
			if (isComponent) return entry.mountComponent?.(mount, element, props)

			return (mount as MountFunction)(element, props)
		})
	})
</script>

{#if remote?.status === 'loading'}
	{@render fallback?.()}
{:else if remote?.status === 'error'}
	{#if error}
		{@render error(remote.error, retry)}
	{:else}
		<div role="alert" data-remote-error>
			<p>This section could not be loaded.</p>
			{#if remote.error.needsReload}
				<button type="button" onclick={reloadPage}>Reload page</button>
			{:else}
				<button type="button" onclick={retry}>Try again</button>
			{/if}
		</div>
	{/if}
{/if}
<div bind:this={target}></div>
