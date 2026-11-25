export const SEARCH_INDEX_DEFAULT_LIMIT = 8;
export const SEARCH_INDEX_MAX_LIMIT = 50;

export const SEARCH_INDEX_DESCRIPTION =
	"Keyword-search memories when you know exact terms or identifiers. Returns compact entries without bodies: IDs, clipped titles, and widening labels when present. Expand selected IDs with memory_get or memory_get_observations.";

export function clampSearchIndexLimit(limit: number): number {
	if (Number.isNaN(limit)) return SEARCH_INDEX_DEFAULT_LIMIT;
	return Math.min(SEARCH_INDEX_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function clipJsonString(value: string, maxBytes: number): string {
	if (value.length <= maxBytes - 2 && Buffer.byteLength(JSON.stringify(value)) <= maxBytes) {
		return value;
	}

	// Budget for JSON quoting and escapes as well as the UTF-8 bytes of the ellipsis.
	let remaining = maxBytes - 5;
	let prefix = "";
	for (const character of value) {
		remaining -= Buffer.byteLength(JSON.stringify(character)) - 2;
		if (remaining < 0) break;
		prefix += character;
	}
	return `${prefix}…`;
}

function isInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function wideningLabels(value: unknown) {
	if (value === null || typeof value !== "object") return {};
	const metadata = value as Record<string, unknown>;
	return {
		...(metadata.widened_from_project === true ? { widened_from_project: true as const } : {}),
		...(metadata.widened_from_shared === true ? { widened_from_shared: true as const } : {}),
		...(metadata.widened_from_project === true && typeof metadata.source_project === "string"
			? { source_project: clipJsonString(metadata.source_project, 48) }
			: {}),
	};
}

function indexItem(value: unknown) {
	if (value === null || typeof value !== "object") return [];
	const { id, kind, title, score, created_at, session_id, metadata } = value as Record<
		string,
		unknown
	>;
	if (!isInteger(id) || !isInteger(session_id)) return [];
	if (typeof score !== "number" || !Number.isFinite(score)) return [];
	if (typeof kind !== "string" || typeof title !== "string" || typeof created_at !== "string") {
		return [];
	}
	return [
		{
			id,
			kind: clipJsonString(kind, 48),
			title: clipJsonString(title, 256),
			score,
			created_at: clipJsonString(created_at, 48),
			session_id,
			metadata: wideningLabels(metadata),
		},
	];
}

/** Keep ranked results and label widening without copying stored metadata wholesale. */
export function projectSearchIndex(rows: readonly unknown[], limit: number) {
	return { items: rows.slice(0, clampSearchIndexLimit(limit)).flatMap(indexItem) };
}
