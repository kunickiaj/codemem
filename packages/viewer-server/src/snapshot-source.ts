export function snapshotGeneration(raw: string | undefined): number | null {
	if (!raw?.trim()) return null;
	return Number.parseInt(raw, 10);
}

export function snapshotSourceDevice(
	requested: string | undefined,
	localDeviceId: string,
): string | undefined {
	if (requested !== undefined && requested !== localDeviceId)
		throw new Error("retirement_snapshot_source_required");
	return requested;
}

export function snapshotErrorStatus(message: string): 400 | 409 | null {
	if (
		["retirement_snapshot_source_required", "missing_generation", "missing_snapshot_id"].includes(
			message,
		)
	)
		return 400;
	if (message === "generation_mismatch" || message === "boundary_mismatch") return 409;
	return null;
}

export function snapshotPageRequest(
	query: (name: string) => string | undefined,
	localDeviceId: string,
) {
	const generation = snapshotGeneration(query("generation"));
	const snapshotId = query("snapshot_id");
	if (generation === null || !Number.isFinite(generation)) throw new Error("missing_generation");
	if (!snapshotId) throw new Error("missing_snapshot_id");
	const rawLimit = Number.parseInt(query("limit") ?? "200", 10);
	return {
		generation,
		snapshotId,
		baselineCursor: query("baseline_cursor") ?? null,
		pageToken: query("page_token") ?? null,
		sourceDeviceId: snapshotSourceDevice(query("source_device_id"), localDeviceId),
		limit: Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 5000)) : 200,
	};
}
