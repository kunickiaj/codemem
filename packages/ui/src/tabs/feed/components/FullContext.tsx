import type { FeedContextResponse } from "@codemem/core/feed-contract";
import type { JSX } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import * as api from "../../../lib/api";
import { state } from "../../../lib/state";
import { renderNarrativeContent } from "../data/body-renderers";

type ContextReadState =
	| { status: "idle" }
	| { status: "loading"; key: string }
	| { status: "ready"; key: string; context: string }
	| { status: "error"; key: string; reason: "changed" | "unavailable" };

type FullContextProps = {
	id: number;
	revision?: string;
	inline: string;
	title: string;
	onReload: () => Promise<void>;
};

function currentContextScope() {
	return {
		project: state.currentProject || "",
		scope: state.feedScopeFilter,
		q: state.feedQuery.trim(),
		actor: state.viewerActorId,
	};
}

function contextReadResult(options: {
	response: FeedContextResponse;
	id: number;
	revision: string | undefined;
	key: string;
}): ContextReadState {
	const { response, id, revision, key } = options;
	if (response.id !== id || response.revision !== revision) {
		return { status: "error", key, reason: "changed" };
	}
	if (typeof response.context !== "string") {
		return { status: "error", key, reason: "unavailable" };
	}
	return { status: "ready", key, context: response.context };
}

function useContextRead(options: {
	id: number;
	revision: string | undefined;
	open: boolean;
	detailsRef: { current: HTMLDetailsElement | null };
}) {
	const [read, setRead] = useState<ContextReadState>({ status: "idle" });
	const [attempt, setAttempt] = useState(0);
	const controller = useRef<AbortController | null>(null);
	const scope = currentContextScope();
	const scopeKey = JSON.stringify(scope);
	const key = JSON.stringify([options.id, options.revision, scopeKey]);
	useLayoutEffect(() => {
		setRead({ status: "idle" });
		if (!options.open || options.revision === undefined) return;
		const request = new AbortController();
		controller.current = request;
		setRead({ status: "loading", key });
		const isCurrent = () =>
			!request.signal.aborted &&
			options.detailsRef.current?.open &&
			scopeKey === JSON.stringify(currentContextScope());
		async function load() {
			try {
				const response = await api.loadMemoryContext({
					id: options.id,
					project: scope.project,
					scope: scope.scope,
					q: scope.q || undefined,
					classification: "observation",
					signal: request.signal,
				});
				// Global filters can change before the parent has rendered again.
				if (!isCurrent()) return;
				setRead(contextReadResult({ response, id: options.id, revision: options.revision, key }));
			} catch {
				if (isCurrent()) setRead({ status: "error", key, reason: "unavailable" });
			}
		}
		void load();
		return () => {
			request.abort();
			if (controller.current === request) controller.current = null;
		};
	}, [key, options.open, attempt]);
	return {
		read:
			options.open && read.status !== "idle" && read.key === key
				? read
				: ({ status: "idle" } as const),
		retry: () => setAttempt((value) => value + 1),
		discard: () => {
			controller.current?.abort();
			setRead({ status: "idle" });
			setAttempt((value) => value + 1);
		},
	};
}

function ContextReadContent(props: {
	read: ContextReadState;
	onRetry: () => void;
	onReload: () => Promise<void>;
}) {
	const [reloadFailed, setReloadFailed] = useState(false);
	const [reloading, setReloading] = useState(false);
	if (props.read.status === "ready") {
		return renderNarrativeContent(props.read.context, "feed-body narrative");
	}
	if (props.read.status === "loading") {
		return (
			<div data-feed-context-status="" aria-live="polite" aria-busy="true">
				Loading full context…
			</div>
		);
	}
	if (props.read.status !== "error") return null;
	const changed = props.read.reason === "changed";
	const reload = async () => {
		setReloadFailed(false);
		setReloading(true);
		try {
			await props.onReload();
		} catch {
			setReloadFailed(true);
		} finally {
			setReloading(false);
		}
	};
	return (
		<div data-feed-context-status="" aria-live="polite">
			<p>
				{changed
					? "This memory changed. Reload the feed to read its current context."
					: "Full context unavailable. Try again."}
			</p>
			<button
				type="button"
				className="settings-button"
				disabled={reloading}
				onClick={changed ? () => void reload() : props.onRetry}
			>
				{changed ? "Reload feed" : "Retry"}
			</button>
			{reloadFailed ? <p>Feed unavailable. Try reloading again.</p> : null}
		</div>
	);
}

export function FullContext(props: FullContextProps): JSX.Element {
	const [open, setOpen] = useState(false);
	const detailsRef = useRef<HTMLDetailsElement | null>(null);
	const context = useContextRead({ id: props.id, revision: props.revision, open, detailsRef });
	return (
		<details
			className="feed-observation-context"
			ref={detailsRef}
			onToggle={() => {
				const nextOpen = detailsRef.current?.open === true;
				if (!nextOpen) context.discard();
				setOpen(nextOpen);
			}}
		>
			<summary aria-label={`Full context for ${props.title}`}>Full context</summary>
			{props.revision === undefined ? (
				renderNarrativeContent(props.inline, "feed-body narrative")
			) : (
				<ContextReadContent read={context.read} onRetry={context.retry} onReload={props.onReload} />
			)}
		</details>
	);
}
