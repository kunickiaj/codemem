import type { CoordinatorEnrollment, readCoordinatorSyncConfig } from "@codemem/core";
import { listAllEnrollments } from "./device-rename.js";

type Config = ReturnType<typeof readCoordinatorSyncConfig>;

function removalSequence({ presence_capabilities }: CoordinatorEnrollment) {
	const sequence = presence_capabilities?.applied_removal_seq;
	return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0
		? sequence
		: null;
}

export async function readRemovalProgress(
	config: Config,
	readConfig: () => Config,
	input: { localId: string; removalSeq: number },
) {
	try {
		const current = readConfig();
		if (
			current.syncCoordinatorUrl !== config.syncCoordinatorUrl ||
			current.syncCoordinatorAdminSecret !== config.syncCoordinatorAdminSecret
		)
			return null;
		return (await listAllEnrollments(config))
			.filter((row) => row.device_id !== input.localId)
			.map((row) => {
				const { device_id, group_id, display_name } = row;
				const sequence = removalSequence(row);
				let state: "older" | "pending" | "applied" = "older";
				if (sequence !== null) state = sequence >= input.removalSeq ? "applied" : "pending";
				return { device_id, group_id, display_name, state };
			});
	} catch {
		// A failed progress read cannot turn a confirmed removal into an error.
		return null;
	}
}

export async function previewOlderRemovalPeers(config: Config, excludedIds: Set<string>) {
	try {
		const rows = await listAllEnrollments(config);
		const supportedIds = new Set(
			rows.filter((row) => removalSequence(row) !== null).map((row) => row.device_id),
		);
		return [
			...new Set(
				rows
					.filter((row) => !excludedIds.has(row.device_id) && !supportedIds.has(row.device_id))
					.map((row) => row.display_name?.trim() || row.device_id),
			),
		];
	} catch {
		// The review must not claim to know which peers support Remove if listing failed.
		return null;
	}
}
