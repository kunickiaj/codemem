import { createReadDeadline, DEFAULT_READ_DEADLINE_MS, type ReadDeadline } from "./read-request";

export interface RefreshSession {
	generation: number;
	isCurrent: () => boolean;
	isOwned: () => boolean;
	signal: AbortSignal;
}

export interface RefreshSessionOwner {
	begin: () => RefreshSession;
	cancel: (reason?: unknown) => void;
	finish: (session: RefreshSession) => void;
	outstanding: () => number;
}

export function createRefreshSessionOwner(
	timeoutMs = DEFAULT_READ_DEADLINE_MS,
): RefreshSessionOwner {
	let generation = 0;
	let active: { deadline: ReadDeadline; generation: number } | null = null;

	const cancel = (reason?: unknown) => {
		if (!active) return;
		active.deadline.abort(reason);
		active.deadline.dispose();
		active = null;
	};

	return {
		begin: () => {
			cancel();
			const deadline = createReadDeadline(timeoutMs);
			const sessionGeneration = ++generation;
			active = { deadline, generation: sessionGeneration };
			return {
				generation: sessionGeneration,
				isCurrent: () => active?.generation === sessionGeneration && !deadline.signal.aborted,
				isOwned: () => active?.generation === sessionGeneration,
				signal: deadline.signal,
			};
		},
		cancel,
		finish: (session) => {
			if (active?.generation !== session.generation) return;
			active.deadline.dispose();
			active = null;
		},
		outstanding: () => (active ? 1 : 0),
	};
}
