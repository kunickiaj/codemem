import { feedFullContextText, projectFeedItem } from "@codemem/core/feed-contract";
import { describe, expect, it } from "vitest";
import type { FeedItem } from "../types";
import {
	buildFeedCardViewModel,
	feedItemMatchesQuery,
	hiddenSearchMatch,
	highlightFeedText,
} from "./card-view-model";
import { authorLabel, deviceLabel, isLowSignalObservation, mergeMetadata } from "./helpers";

describe("Feed projection parity with the existing UI", () => {
	it.each<FeedItem>([
		{
			kind: "session_summary",
			narrative: "Entire summary",
			facts: ["Every fact"],
			body_text: "Hidden duplicate",
		},
		{ kind: "change", narrative: "Entire narrative without facts" },
		{ kind: "discovery", body_text: "Entire legacy body" },
		{ kind: "bugfix", narrative: "Closed disclosure narrative", facts: ["Visible key point"] },
		{
			kind: "bugfix",
			body_text: "Hidden body must not become context",
			facts: ["Visible key point"],
		},
		{
			kind: " session_summary ",
			narrative: "Whitespace kind is not summary-like",
			facts: ["Fact"],
		},
		{
			kind: " BuGFix ",
			metadata_json: { import_metadata: { source: "observer_summary" } },
			narrative: "Imported summary",
			facts: ["Fact"],
		},
	])("preserves visible modes, canonical kind and row identity: %j", (fields) => {
		// Arrange
		const item = {
			id: 17,
			title: " Stored title ",
			tags_text: "one two",
			files: ["example.ts", 3],
			...fields,
		};
		const before = buildFeedCardViewModel(item);
		const expectedContext =
			!before.isSessionSummary && before.content.facts.length
				? before.content.narrative || before.content.body || null
				: null;
		// Act
		const projected = projectFeedItem({ item, contextRevision: "r17" });
		const after = buildFeedCardViewModel(projected);
		// Assert
		expect(after.displayTitle).toBe("Stored title");
		expect(after.displayKind).toBe(before.displayKind);
		expect(after.rowKey).toBe(`${String(fields.kind).toLowerCase()}:17`);
		expect(after.isSessionSummary).toBe(before.isSessionSummary);
		expect(after.content.facts).toEqual(before.content.facts);
		expect(after.content.body).toBe(before.content.body);
		expect(after.content.narrative).toBe(expectedContext ? "" : before.content.narrative);
		expect(after.tags).toEqual(["one", "two"]);
		expect(after.files).toEqual(["example.ts", "3"]);
		expect(feedFullContextText(item)).toBe(expectedContext);
		expect(projected.feed.full_context).toEqual(expectedContext ? { revision: "r17" } : null);
		expect(projected.feed.low_signal).toBe(isLowSignalObservation(item));
	});
});

describe("Feed search parity", () => {
	it.each([
		{
			query: "needle",
			fields: { narrative: "A Needle in content", facts: ["Fact"] },
			match: { label: "Content", excerpt: "A Needle in content Fact" },
			matches: true,
		},
		{
			query: "needle",
			fields: { body_text: "Legacy Needle", facts: ["Fact"] },
			match: { label: "Body", excerpt: "Legacy Needle" },
			matches: true,
		},
		{
			query: "needle",
			fields: { subtitle: "Needle subtitle" },
			match: { label: "Body", excerpt: "Needle subtitle" },
			matches: true,
		},
		{
			query: "needle",
			fields: { metadata_json: { import_metadata: { request: "Needle request" } } },
			match: { label: "Body", excerpt: "Needle request" },
			matches: true,
		},
		{
			query: "needle",
			fields: { title: "Needle title", body_text: "Needle body" },
			match: null,
			matches: true,
		},
		{ query: "project", fields: { project: "Project label" }, match: null, matches: true },
		{ query: " tag ", fields: { tags_text: '["tag"]' }, match: null, matches: true },
		{ query: "tag", fields: { tags: [], tags_text: "tag" }, match: null, matches: false },
		{ query: "17", fields: {}, match: null, matches: true },
		{ query: "017", fields: {}, match: null, matches: false },
		{ query: "missing", fields: {}, match: null, matches: false },
		{ query: "  ", fields: {}, match: null, matches: false },
		{
			query: "İ",
			fields: { body_text: "İstanbul <b>" },
			match: { label: "Content", excerpt: "İstanbul <b>" },
			matches: true,
		},
		{
			query: "ος",
			fields: { body_text: "ΟΣ ends here" },
			match: { label: "Content", excerpt: "ΟΣ ends here" },
			matches: true,
		},
		{
			query: "two\nwords",
			fields: { body_text: "two\nwords" },
			match: { label: "Content", excerpt: "" },
			matches: true,
		},
		{
			query: "NEEDLE",
			fields: { body_text: `${"a".repeat(80)}Needle${"z".repeat(100)}` },
			match: { label: "Content", excerpt: `…${"a".repeat(70)}Needle${"z".repeat(90)}…` },
			matches: true,
		},
	])("retains legacy search evidence for $query: $fields", ({ query, fields, match, matches }) => {
		// Arrange
		const item: FeedItem = { id: 17, title: "Stored title", ...fields };
		const before = buildFeedCardViewModel(item);
		// Act
		const result = projectFeedItem({ item: { ...item }, query, contextRevision: "r17" });
		// Assert
		expect(result.feed.search_match).toEqual(match);
		expect(result.feed.search_match).toEqual(hiddenSearchMatch(before, query));
		expect(result.feed.matches_query).toBe(matches);
		expect(result.feed.matches_query).toBe(feedItemMatchesQuery(item, query));
	});

	it("keeps author and device presentation with flattened provenance", () => {
		// Arrange
		const item = {
			id: 17,
			actor_id: "actor-17",
			resolved_actor_display_name: "Taylor",
			resolved_device_display_name: "Laptop",
			metadata_json: {
				import_metadata: {
					origin_device_id: "device-17",
					visibility: "shared",
					trust_state: "unreviewed",
					workspace_kind: "personal",
					origin_source: "mcp",
				},
			},
		};
		// Act
		const result = projectFeedItem({ item, contextRevision: "r17" });
		// Assert
		expect(authorLabel(result)).toBe("Taylor");
		expect(deviceLabel(result)).toBe(deviceLabel(item, mergeMetadata(item.metadata_json)));
		expect(deviceLabel(result)).toBe("Device Laptop");
		expect(result).toMatchObject({
			visibility: "shared",
			trust_state: "unreviewed",
			workspace_kind: "personal",
			origin_source: "mcp",
			origin_device_id: "device-17",
		});
	});

	it("leaves excerpts unescaped until the UI highlights them", () => {
		// Arrange
		const item = { body_text: '<script>Needle & "text"</script>' };
		// Act
		const result = projectFeedItem({ item, query: "needle", contextRevision: "r17" });
		const html = highlightFeedText(result.feed.search_match?.excerpt || "", "needle");
		// Assert
		expect(result.feed.search_match?.excerpt).toBe(item.body_text);
		expect(html).toBe(
			'&lt;script&gt;<mark class="match">Needle</mark> &amp; &quot;text&quot;&lt;/script&gt;',
		);
		expect(html).not.toContain("<script>");
	});
});
