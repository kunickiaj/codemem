/**
 * Applicability of a memory: where the rule applies (user / org / toolchain /
 * project). Orthogonal to scope_id (sharing domain — WHO can read) and to
 * memory_concept_refs (WHAT the memory is about). Foundation for the layered
 * sticky-rules pack band (bead codemem-uyhx → codemem-qqmd).
 */

export const APPLIES_TO_LAYERS = ["user", "org", "toolchain", "project"] as const;

export type AppliesTo = (typeof APPLIES_TO_LAYERS)[number];

export const APPLIES_TO_DEFAULT: AppliesTo = "project";

const APPLIES_TO_REQUIRES_KEY: ReadonlySet<AppliesTo> = new Set(["org", "toolchain"]);

const APPLIES_TO_VALUES: ReadonlySet<string> = new Set(APPLIES_TO_LAYERS);

export interface Applicability {
	applies_to: AppliesTo;
	applies_to_key: string | null;
}

export interface ApplicabilityInput {
	applies_to?: AppliesTo | string | null;
	applies_to_key?: string | null;
}

function normalizeLayer(value: unknown): AppliesTo | null {
	if (typeof value !== "string") return null;
	const lower = value.trim().toLowerCase();
	return APPLIES_TO_VALUES.has(lower) ? (lower as AppliesTo) : null;
}

function normalizeKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

/**
 * Strict validation for the write path. Rejects unknown layers and enforces
 * the applies_to_key contract: required for org/toolchain, forbidden for
 * user/project. Returns a normalized Applicability ready for insert.
 */
export function validateApplicability(input: ApplicabilityInput): Applicability {
	const rawLayer = input.applies_to;
	if (rawLayer == null) {
		const key = normalizeKey(input.applies_to_key);
		if (key !== null) {
			throw new Error(
				`applies_to_key is only valid when applies_to is 'org' or 'toolchain' (got applies_to_key='${key}' with no applies_to)`,
			);
		}
		return { applies_to: APPLIES_TO_DEFAULT, applies_to_key: null };
	}

	const layer = normalizeLayer(rawLayer);
	if (layer === null) {
		throw new Error(
			`Invalid applies_to '${String(rawLayer)}'. Allowed: ${APPLIES_TO_LAYERS.join(", ")}`,
		);
	}

	const key = normalizeKey(input.applies_to_key);
	const needsKey = APPLIES_TO_REQUIRES_KEY.has(layer);
	if (needsKey && key === null) {
		throw new Error(
			`applies_to_key is required when applies_to is '${layer}' (got missing or blank key)`,
		);
	}
	if (!needsKey && key !== null) {
		throw new Error(`applies_to_key must be null when applies_to is '${layer}' (got '${key}')`);
	}
	return { applies_to: layer, applies_to_key: key };
}

/**
 * Lenient normalization for the read/replication path. Unknown layers degrade
 * to 'project' (downgrade safety: older peers that emit an unrecognized layer
 * never poison the local store). Keys that should not exist for the resolved
 * layer are dropped.
 */
export function normalizeApplicability(raw: {
	applies_to: unknown;
	applies_to_key: unknown;
}): Applicability {
	const layer = normalizeLayer(raw.applies_to) ?? APPLIES_TO_DEFAULT;
	const key = APPLIES_TO_REQUIRES_KEY.has(layer) ? normalizeKey(raw.applies_to_key) : null;
	return { applies_to: layer, applies_to_key: key };
}
