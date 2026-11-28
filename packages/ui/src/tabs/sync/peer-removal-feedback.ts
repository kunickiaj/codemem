import type { SyncActionFeedback } from "./components/sync-inline-feedback";

/** Unpairing deletes only this device's pairing, so the peer always stays in its Teams. */
export function peerRemovalFeedback(
	_result: unknown,
	options: { label: string },
): SyncActionFeedback {
	return {
		message: `Unpaired this device from ${options.label}. ${options.label} stays in your Teams.`,
		tone: "success",
	};
}
