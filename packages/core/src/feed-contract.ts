/** Browser-safe Feed wire contract. Derive search evidence before omitting hidden text. */
export type FeedProjectionInfo = {
	version: 1;
	low_signal: boolean;
	query: string;
	matches_query: boolean;
	search_match: { label: "Content" | "Body"; excerpt: string } | null;
	full_context: { revision: string } | null;
};

export type FeedContextResponse = { id: number; revision: string; context: string };

export type FeedListItem = {
	id: number;
	session_id?: number | string;
	kind?: string;
	title?: string;
	created_at?: string;
	updated_at?: string;
	project?: string;
	owned_by_self?: boolean;
	actor_id?: string;
	actor_display_name?: string;
	resolved_actor_display_name?: string;
	visibility?: string;
	trust_state?: string;
	workspace_kind?: string;
	origin_source?: string;
	origin_device_id?: string;
	resolved_device_display_name?: string;
	facts: string[];
	tags: string[];
	files: string[];
	body_text: string;
	narrative: string;
	metadata_json?: { is_summary: boolean };
	feed: FeedProjectionInfo;
};

type FeedRow = Readonly<Record<string, unknown>>;

function object(value: unknown): FeedRow {
	return value && typeof value === "object" ? (value as FeedRow) : {};
}

function metadata(item: FeedRow): FeedRow {
	const outer = object(item.metadata_json);
	return { ...object(outer.import_metadata), ...outer };
}

function parseArray(value: unknown): unknown[] {
	if (Array.isArray(value)) return value;
	if (typeof value !== "string" || !value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function normalize(value: unknown): string {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

function isSummary(item: FeedRow): boolean {
	const meta = metadata(item);
	return (
		String(item.kind || "").toLowerCase() === "session_summary" ||
		meta.is_summary === true ||
		String(meta.source || "")
			.trim()
			.toLowerCase() === "observer_summary"
	);
}

function content(item: FeedRow) {
	const narrative = String(item.narrative || "").trim();
	const facts = parseArray(item.facts)
		.filter((fact): fact is string => typeof fact === "string")
		.map((fact) => fact.trim())
		.filter(Boolean);
	const legacyBody = String(item.body_text || "").trim();
	const body = narrative || facts.length ? "" : legacyBody;
	return {
		narrative,
		facts,
		body,
		legacyBody,
		searchText: [narrative, ...facts, body].filter(Boolean).join("\n"),
	};
}

/** Only the existing, initially closed observation disclosure is deferred. */
export function feedFullContextText(item: FeedRow): string | null {
	const model = content(item);
	if (isSummary(item) || !model.facts.length) return null;
	return model.narrative || model.body || null;
}

function tags(item: FeedRow): unknown[] {
	if (item.tags != null) return parseArray(item.tags);
	const parsed = parseArray(item.tags_text);
	if (parsed.length) return parsed;
	return typeof item.tags_text === "string"
		? item.tags_text.trim().split(/\s+/).filter(Boolean)
		: [];
}

function searchableValue(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return value.map(searchableValue).filter(Boolean).join("\n");
	if (value && typeof value === "object") {
		return Object.entries(value)
			.map(([key, entry]) => `${key}\n${searchableValue(entry)}`)
			.filter((entry) => entry.trim())
			.join("\n");
	}
	return value == null ? "" : String(value).trim();
}

function searchModel(item: FeedRow) {
	const model = content(item);
	const meta = metadata(item);
	const rendered = normalize(model.searchText);
	const indexed = [
		item.subtitle,
		meta.subtitle,
		meta.narrative,
		searchableValue(item.facts),
		searchableValue(item.summary),
		searchableValue(meta.facts),
		searchableValue(meta.summary),
		searchableValue(meta.request),
	]
		.map((candidate) => String(candidate || "").trim())
		.filter((candidate) => candidate && !rendered.includes(normalize(candidate)))
		.join("\n");
	return {
		...model,
		title: String(item.title || "(untitled)").trim() || "(untitled)",
		kind: isSummary(item)
			? "session_summary"
			: String(item.kind || "")
					.trim()
					.toLowerCase() || "change",
		searchOnlyText: [model.narrative || model.facts.length ? model.legacyBody : "", indexed]
			.filter(Boolean)
			.join("\n"),
	};
}

function matchesQuery(options: {
	item: FeedRow;
	model: ReturnType<typeof searchModel>;
	query: string;
}): boolean {
	const { item, model, query } = options;
	if (!query) return false;
	const id = Number(item.id || item.memory_id || 0);
	if (Number.isSafeInteger(id) && id > 0 && query === String(id)) return true;
	return [
		model.title,
		model.kind,
		String(item.project || ""),
		model.searchOnlyText,
		model.searchText,
		...tags(item).map(String),
	].some((text) => text.toLowerCase().includes(query));
}

function excerpt(options: { text: string; query: string }): string {
	const text = options.text.replace(/\s+/g, " ").trim();
	const offsets: { start: number; end: number }[] = [];
	let sourceOffset = 0;
	for (const character of text) {
		const span = { start: sourceOffset, end: sourceOffset + character.length };
		for (let unit = 0; unit < character.toLowerCase().length; unit++) offsets.push(span);
		sourceOffset = span.end;
	}
	// Whole-string folding preserves contextual casing, while offsets preserve Unicode spans.
	const index = text.toLowerCase().indexOf(options.query);
	const matchStart = offsets[index]?.start;
	const matchEnd = offsets[index + options.query.length - 1]?.end;
	if (index < 0 || matchStart === undefined || matchEnd === undefined) return "";
	const start = Math.max(0, matchStart - 70);
	const end = Math.min(text.length, matchEnd + 90);
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function searchMatch(options: {
	model: ReturnType<typeof searchModel>;
	query: string;
}): FeedProjectionInfo["search_match"] {
	const { model, query } = options;
	if (!query || model.title.toLowerCase().includes(query)) return null;
	if (model.searchText.toLowerCase().includes(query))
		return { label: "Content", excerpt: excerpt({ text: model.searchText, query }) };
	if (model.searchOnlyText.toLowerCase().includes(query))
		return { label: "Body", excerpt: excerpt({ text: model.searchOnlyText, query }) };
	return null;
}

function lowSignal(item: FeedRow): boolean {
	const title = normalize(item.title);
	const body = normalize(item.body_text);
	const combined = body || title;
	if (!title && !body) return true;
	if (combined.length < 10) return true;
	if (title && body && title === body && combined.length < 40) return true;
	if ((title.charAt(0) === "└" || title.charAt(0) === "›") && combined.length < 40) return true;
	if (title.startsWith("list ") && combined.length < 20) return true;
	return combined === "ls" || combined === "list ls";
}

function identity(item: FeedRow) {
	const result: Partial<FeedListItem> = {};
	for (const key of [
		"kind",
		"title",
		"updated_at",
		"project",
		"actor_id",
		"actor_display_name",
		"resolved_actor_display_name",
		"resolved_device_display_name",
	] as const) {
		if (item[key] != null) result[key] = String(item[key]);
	}
	const createdAt = item.created_at || item.created_at_utc;
	if (createdAt != null) result.created_at = String(createdAt);
	if (typeof item.session_id === "number" || typeof item.session_id === "string")
		result.session_id = item.session_id;
	if (typeof item.owned_by_self === "boolean") result.owned_by_self = item.owned_by_self;
	const meta = metadata(item);
	for (const key of [
		"visibility",
		"trust_state",
		"workspace_kind",
		"origin_source",
		"origin_device_id",
	] as const) {
		const value = item[key] || meta[key];
		if (value != null) result[key] = String(value);
	}
	return result;
}

export function projectFeedItem(options: {
	item: FeedRow;
	query?: string;
	contextRevision: string;
}): FeedListItem {
	const { item } = options;
	const model = searchModel(item);
	const query = (options.query || "").trim().toLowerCase().slice(0, 256);
	const context = feedFullContextText(item);
	return {
		...identity(item),
		id: Number(item.id || item.memory_id || 0),
		facts: model.facts,
		tags: tags(item).map(String),
		files: parseArray(item.files || []).map(String),
		body_text: model.body,
		narrative: context ? "" : model.narrative,
		...(isSummary(item) ? { metadata_json: { is_summary: true } } : {}),
		feed: {
			version: 1,
			low_signal: lowSignal(item),
			query,
			matches_query: matchesQuery({ item, model, query }),
			search_match: searchMatch({ model, query }),
			full_context: context ? { revision: options.contextRevision } : null,
		},
	};
}

/** Reject unversioned or malformed rows so callers can retain their raw-row fallback. */
export function feedProjectionInfo(item: unknown): FeedProjectionInfo | null {
	const feed = object(object(item).feed);
	if (
		feed.version !== 1 ||
		typeof feed.low_signal !== "boolean" ||
		typeof feed.query !== "string" ||
		typeof feed.matches_query !== "boolean"
	)
		return null;
	const match = object(feed.search_match);
	if (
		feed.search_match !== null &&
		((match.label !== "Content" && match.label !== "Body") || typeof match.excerpt !== "string")
	)
		return null;
	const context = object(feed.full_context);
	if (feed.full_context !== null && typeof context.revision !== "string") return null;
	return feed as FeedProjectionInfo;
}
