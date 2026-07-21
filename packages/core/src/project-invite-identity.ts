const MAX_IDENTITY_DISPLAY_LENGTH = 120;

export interface ProjectInviteSummary {
	display_name: string;
	existing_memory_count: number;
}

export function normalizeIdentityDisplayName(value: string, field: string): string {
	if ([...value].some((character) => /[\p{Cc}\p{Cf}]/u.test(character))) {
		throw new Error(`${field}_invalid`);
	}
	const normalized = value.replace(/\s+/gu, " ").trim();
	if (!normalized) throw new Error(`${field}_required`);
	if ([...normalized].length > MAX_IDENTITY_DISPLAY_LENGTH) {
		throw new Error(`${field}_too_long`);
	}
	return normalized;
}

export function normalizeDeviceNameHint(value: string | null | undefined): string | null {
	const raw = String(value ?? "").replace(/\.local$/iu, "");
	if (!raw.trim()) return null;
	return normalizeIdentityDisplayName(raw.replace(/[-_]+/gu, " "), "device_display_name");
}

export function friendlyDeviceName(input: {
	explicitName?: string | null;
	osName?: string | null;
	coordinatorName?: string | null;
	fallbackSeed?: string | null;
}): string {
	for (const candidate of [input.explicitName, input.osName, input.coordinatorName]) {
		const normalized = normalizeDeviceNameHint(candidate);
		if (normalized) return normalized;
	}
	const seed = String(input.fallbackSeed ?? "")
		.replace(/[^a-z0-9]/giu, "")
		.slice(0, 6);
	return seed ? `Codemem device ${seed}` : "Codemem device";
}

export function normalizeProjectInviteSummaries(value: unknown): ProjectInviteSummary[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
		throw new Error("project_summaries_invalid");
	}
	return value.map((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			throw new Error("project_summaries_invalid");
		}
		const record = item as Record<string, unknown>;
		if (
			!Number.isSafeInteger(record.existing_memory_count) ||
			Number(record.existing_memory_count) < 0
		) {
			throw new Error("project_summaries_invalid");
		}
		return {
			display_name: normalizeIdentityDisplayName(String(record.display_name ?? ""), "project_name"),
			existing_memory_count: Number(record.existing_memory_count),
		};
	});
}
