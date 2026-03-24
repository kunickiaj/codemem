/**
 * Tag derivation — port of Python's codemem/store/tags.py.
 *
 * Derives searchable tags from memory kind, title, concepts, and file paths.
 * Used at ingest time to populate memory_items.tags_text inline (matching
 * Python's store_observation → derive_tags flow).
 */

const STOPWORDS = new Set([
	"the",
	"and",
	"for",
	"with",
	"this",
	"that",
	"from",
	"are",
	"was",
	"were",
	"has",
	"have",
	"had",
	"not",
	"but",
	"can",
	"will",
	"all",
	"been",
	"each",
	"which",
	"their",
	"said",
	"its",
	"into",
	"than",
	"other",
	"some",
	"could",
	"them",
	"about",
	"then",
	"made",
	"after",
	"many",
	"also",
	"did",
	"just",
	"should",
	"over",
	"such",
	"there",
	"would",
	"more",
	"now",
	"very",
	"when",
	"what",
	"your",
	"how",
	"out",
	"our",
	"his",
	"her",
	"she",
	"him",
	"most",
]);

/**
 * Normalize a raw value into a tag-safe lowercase slug.
 * Returns empty string if the value is empty, a stopword, or too short.
 */
export function normalizeTag(value: string, stopwords?: Set<string>): string {
	let lowered = (value || "").trim().toLowerCase();
	if (!lowered) return "";
	lowered = lowered
		.replace(/[^a-z0-9_]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	if (!lowered) return "";
	const words = stopwords ?? STOPWORDS;
	if (words.has(lowered)) return "";
	if (lowered.length > 40) lowered = lowered.slice(0, 40).replace(/-$/, "");
	return lowered;
}

/**
 * Extract tags from a file path (basename, parent dir, top-level dir).
 */
export function fileTags(pathValue: string, stopwords?: Set<string>): string[] {
	const raw = (pathValue || "").trim();
	if (!raw) return [];
	const parts = raw.split(/[\\/]+/).filter((p): p is string => !!p && p !== "." && p !== "..");
	if (!parts.length) return [];

	const tags: string[] = [];
	const last = parts.at(-1);
	if (last) {
		const basename = normalizeTag(last, stopwords);
		if (basename) tags.push(basename);
	}
	if (parts.length >= 2) {
		const secondLast = parts.at(-2);
		if (secondLast) {
			const parent = normalizeTag(secondLast, stopwords);
			if (parent) tags.push(parent);
		}
	}
	if (parts.length >= 3) {
		const first = parts.at(0);
		if (first) {
			const top = normalizeTag(first, stopwords);
			if (top) tags.push(top);
		}
	}
	return tags;
}

/**
 * Derive tags from memory metadata, matching Python's derive_tags().
 *
 * Sources (in priority order):
 * 1. Memory kind
 * 2. Concepts (from observer XML output)
 * 3. File paths (read + modified)
 * 4. Title tokens (fallback when nothing else produced tags)
 */
export function deriveTags(opts: {
	kind: string;
	title?: string;
	concepts?: string[];
	filesRead?: string[];
	filesModified?: string[];
	stopwords?: Set<string>;
}): string[] {
	const words = opts.stopwords ?? STOPWORDS;
	const tags: string[] = [];

	const kindTag = normalizeTag(opts.kind, words);
	if (kindTag) tags.push(kindTag);

	for (const concept of opts.concepts ?? []) {
		const normalized = normalizeTag(concept, words);
		if (normalized) tags.push(normalized);
	}

	for (const pathValue of [...(opts.filesRead ?? []), ...(opts.filesModified ?? [])]) {
		tags.push(...fileTags(pathValue, words));
	}

	// Fallback: extract tokens from title if no other tags were found
	if (!tags.length && opts.title) {
		for (const match of opts.title.toLowerCase().matchAll(/[a-z0-9_]+/g)) {
			const normalized = normalizeTag(match[0], words);
			if (normalized) tags.push(normalized);
		}
	}

	// Dedupe while preserving order, cap at 20
	const deduped: string[] = [];
	const seen = new Set<string>();
	for (const tag of tags) {
		if (seen.has(tag)) continue;
		seen.add(tag);
		deduped.push(tag);
		if (deduped.length >= 20) break;
	}
	return deduped;
}
