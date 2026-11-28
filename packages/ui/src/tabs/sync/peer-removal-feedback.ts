import type { SyncActionFeedback } from "./components/sync-inline-feedback";

/** Unpairing deletes only this device's pairing, so the result names no other change. */
export function peerRemovalFeedback(
	_result: unknown,
	options: { label: string },
): SyncActionFeedback {
	return {
		message: `Unpaired this device from ${options.label}.`,
		tone: "success",
	};
}
