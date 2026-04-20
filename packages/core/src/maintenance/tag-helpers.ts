/* Tag-derivation helpers for the memory_items.tags_text backfill. */

export function normalizeTag(value: string): string {
	let normalized = value.trim().toLowerCase();
	if (!normalized) return "";
	normalized = normalized.replace(/[^a-z0-9_]+/g, "-");
	normalized = normalized.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
	if (!normalized) return "";
	if (normalized.length > 40) normalized = normalized.slice(0, 40).replace(/-+$/g, "");
	return normalized;
}

export function fileTags(pathValue: string): string[] {
	const raw = pathValue.trim();
	if (!raw) return [];
	const parts = raw.split(/[\\/]+/).filter((part) => part && part !== "." && part !== "..");
	if (parts.length === 0) return [];
	const tags: string[] = [];
	const basename = normalizeTag(parts[parts.length - 1] ?? "");
	if (basename) tags.push(basename);
	if (parts.length >= 2) {
		const parent = normalizeTag(parts[parts.length - 2] ?? "");
		if (parent) tags.push(parent);
	}
	if (parts.length >= 3) {
		const top = normalizeTag(parts[0] ?? "");
		if (top) tags.push(top);
	}
	return tags;
}

export function parseJsonStringList(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((item) => (typeof item === "string" ? item.trim() : ""))
			.filter((item) => item.length > 0);
	} catch {
		return [];
	}
}

export function deriveTags(input: {
	kind: string;
	title: string;
	concepts: string[];
	filesRead: string[];
	filesModified: string[];
}): string[] {
	const tags: string[] = [];
	const kindTag = normalizeTag(input.kind);
	if (kindTag) tags.push(kindTag);

	for (const concept of input.concepts) {
		const tag = normalizeTag(concept);
		if (tag) tags.push(tag);
	}

	for (const filePath of [...input.filesRead, ...input.filesModified]) {
		tags.push(...fileTags(filePath));
	}

	if (tags.length === 0 && input.title.trim()) {
		const tokens = input.title.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
		for (const token of tokens) {
			const tag = normalizeTag(token);
			if (tag) tags.push(tag);
		}
	}

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
