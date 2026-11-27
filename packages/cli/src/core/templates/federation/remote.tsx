import {
	useEffect,
	useMemo,
	useEffectEvent,
	useRef,
	useSyncExternalStore,
	type ComponentType,
	type ReactNode,
} from 'react'
import { createRemoteLoader, warnUnknownRemote, type RemoteError } from './core'
import { remotes, type RemoteEntry, type RemoteName } from './remotes'
import { reportRemoteError } from './report'

type MountFunction = (target: HTMLElement, props?: object) => () => void

export interface RemoteProps<Props extends object = Record<string, never>> {
	name: RemoteName
	/** Forwarded to the remote: props on a component contract, a second
	 * mount(el, props) argument on a mount contract. */
	props?: Props
	/** Shown while the remote is still loading. */
	fallback?: ReactNode
	/** Shown when it fails to load. Call retry to start the load over. Errors
	 * the remote throws once loaded go to the app's error boundaries instead. */
	renderError?: (error: RemoteError, retry: () => void) => ReactNode
	/** Called when it fails to load. */
	onError?: (error: RemoteError, name: RemoteName) => void
}

type RemoteViewProps<Props extends object> = RemoteProps<Props> & { entry: RemoteEntry }

export function Remote<Props extends object = Record<string, never>>(props: RemoteProps<Props>) {
	const entry = remotes[props.name] as RemoteEntry | undefined

	if (!entry) {
		warnUnknownRemote(props.name)

		return null
	}

	// Keyed by name, so a new name starts a new load.
	return <RemoteView key={props.name} {...props} entry={entry} />
}

function RemoteView<Props extends object>({
	name,
	entry,
	props,
	fallback = null,
	renderError = renderDefaultError,
	onError,
}: RemoteViewProps<Props>) {
	const loader = useMemo(() => createRemoteLoader(name, entry.load), [name, entry])
	const state = useSyncExternalStore(loader.subscribe, loader.getState, loader.getState)
	const reportError = useEffectEvent((error: RemoteError) => {
		reportRemoteError(name, error)
		onError?.(error, name)
	})

	useEffect(() => {
		if (state.status === 'error') reportError(state.error)
	}, [state])

	if (state.status === 'loading') return fallback

	if (state.status === 'error') return renderError(state.error, loader.retry)

	if (entry.contract === 'component') {
		const View = state.module.default as ComponentType<Record<string, unknown>>

		return <View {...props} />
	}

	return <MountTarget mount={state.module.default as MountFunction} props={props} />
}

function MountTarget({ mount, props }: { mount: MountFunction; props?: object | undefined }) {
	const target = useRef<HTMLDivElement>(null)
	// A mount function takes its props once, when it mounts.
	const mountProps = useRef(props)

	useEffect(() => {
		if (!target.current) return

		return mount(target.current, mountProps.current)
	}, [mount])

	return <div ref={target} />
}

function reloadPage(): void {
	window.location.reload()
}

/** Unstyled on purpose. Pass renderError to make it yours. */
function renderDefaultError(error: RemoteError, retry: () => void): ReactNode {
	return (
		<div role="alert" data-remote-error="">
			<p>This section could not be loaded.</p>
			<button type="button" onClick={error.needsReload ? reloadPage : retry}>
				{error.needsReload ? 'Reload page' : 'Try again'}
			</button>
		</div>
	)
}
