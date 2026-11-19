import type { SyncActionFeedback } from "./components/sync-inline-feedback";

/** A local disconnect can leave the device's Project access unchanged. */
export function peerRemovalFeedback(
	result: unknown,
	options: { label: string; removedMessage?: string },
): SyncActionFeedback {
	if (result && typeof result === "object" && Reflect.get(result, "binding") === "kept") {
		return {
			message: `Disconnected this device from ${options.label}. The device stays in Projects. An administrator's device can remove it.`,
			tone: "success",
		};
	}
	return {
		message: options.removedMessage ?? `Removed peer ${options.label}.`,
		tone: "success",
	};
}
