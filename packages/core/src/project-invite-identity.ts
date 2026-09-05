const MAX_IDENTITY_DISPLAY_LENGTH = 120;
// Keep machine-shaped cases synchronized with ui/src/lib/identity-presentation.ts.
const UUID_NAME = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const MACHINE_PREFIX_NAME = /^(?:actor|device|identity|local):\S+$/iu;
const MACHINE_SLUG_NAME = /^(?:actor|device|identity)[_-][a-z0-9][a-z0-9._:-]{4,}$/iu;
const PENDING_PERSON_NAME = /^pending[_-]\S+$/iu;
const HEX_HOSTNAME = /^[a-f0-9]{12,64}$/iu;
const HOSTNAME_NAME =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

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

export function isHumanPresentationName(value: unknown): boolean {
	if (typeof value !== "string") return false;
	let normalized: string;
	try {
		normalized = normalizeIdentityDisplayName(value, "display_name");
	} catch {
		return false;
	}
	return ![
		UUID_NAME,
		MACHINE_PREFIX_NAME,
		MACHINE_SLUG_NAME,
		PENDING_PERSON_NAME,
		HEX_HOSTNAME,
		HOSTNAME_NAME,
	].some((pattern) => pattern.test(normalized));
}

export function normalizeHumanPresentationName(value: string, field: string): string {
	const normalized = normalizeIdentityDisplayName(value, field);
	if (!isHumanPresentationName(normalized)) throw new Error(`${field}_invalid`);
	return normalized;
}

export function normalizeDeviceNameHint(value: string | null | undefined): string | null {
	const candidate = String(value ?? "").trim();
	const raw = candidate.replace(/\.local$/iu, "");
	if (!raw) return null;
	const normalized = HOSTNAME_NAME.test(candidate) ? raw : raw.replace(/[-_]+/gu, " ");
	return normalizeIdentityDisplayName(normalized, "device_display_name");
}

export function friendlyDeviceName(input: {
	explicitName?: string | null;
	osName?: string | null;
	coordinatorName?: string | null;
	fallbackSeed?: string | null;
}): string {
	for (const candidate of [input.explicitName, input.osName, input.coordinatorName]) {
		const candidateText = String(candidate ?? "").trim();
		const raw = candidateText.replace(/\.local$/iu, "");
		// Classify before separator normalization so UUIDs and machine slugs cannot
		// be disguised as human labels by replacing hyphens or underscores.
		if (HOSTNAME_NAME.test(candidateText)) {
			try {
				const normalized = normalizeDeviceNameHint(candidateText);
				if (normalized) return normalized;
			} catch {
				// Unusable automatic hints must degrade to the generated fallback.
			}
			continue;
		}
		if (!raw || !isHumanPresentationName(raw)) continue;
		try {
			const normalized = normalizeDeviceNameHint(candidate);
			if (normalized && isHumanPresentationName(normalized)) return normalized;
		} catch {
			// Unusable automatic hints must degrade to the generated fallback.
		}
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
