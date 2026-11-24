import { fetchJson } from "../lib/api/internal";
import { permanentBlockConfirmation } from "./device-block-confirmation";
import { openSyncConfirmDialog } from "./sync/sync-dialogs";

const hash = /^[a-f0-9]{64}$/u;
const post = (body: Record<string, unknown>) => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

function removalReview(value: Record<string, unknown>, deviceId: string) {
	const {
		group_id: groupId,
		key_id: keyId,
		coordinator_origin: origin,
		expected_digest: digest,
	} = value;
	if (
		value.device_id !== deviceId ||
		typeof groupId !== "string" ||
		!groupId ||
		typeof origin !== "string" ||
		typeof keyId !== "string" ||
		!hash.test(keyId) ||
		typeof digest !== "string" ||
		!hash.test(digest)
	)
		throw new Error("Block target could not be reviewed");
	return { group_id: groupId, key_id: keyId, coordinator_origin: origin, expected_digest: digest };
}

/** No fallback to Retire, local-only Remove, or a second mutation after an unknown reply. */
export async function confirmAndBlockEnrolledDevice(
	device: { deviceId: string; displayName: string },
	confirm = openSyncConfirmDialog,
) {
	const path = `/api/sync/devices/${encodeURIComponent(device.deviceId)}`;
	const removal = removalReview(
		await fetchJson<Record<string, unknown>>(`${path}/remove/preview`, { method: "POST" }),
		device.deviceId,
	);
	const block = await fetchJson<Record<string, unknown>>(
		`${path}/block-enrolled/preview`,
		post({ group_id: removal.group_id }),
	);
	if (
		typeof block.coordinator_id !== "string" ||
		!block.coordinator_id ||
		block.key_id !== removal.key_id
	)
		throw new Error("Block target changed during review");
	if (!(await confirm(permanentBlockConfirmation(device.displayName)))) return null;
	try {
		// Keep waiting across Remove, refresh, and Block. A read deadline would lose the final outcome.
		const response = await fetch(
			`${path}/block-enrolled`,
			post({ ...removal, coordinator_id: block.coordinator_id }),
		);
		if (!response.ok) return "unknown";
		const result = (await response.json()) as { state?: string } | null;
		switch (result?.state) {
			case "blocked":
			case "removed-but-block-refused":
			case "removed-block-unknown":
				return result.state;
			case "rejected":
			case "refused":
				return "refused";
			default:
				return "unknown";
		}
	} catch {
		return "unknown";
	}
}
