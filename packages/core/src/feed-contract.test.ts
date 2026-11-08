import { describe, expect, it } from "vitest";
import { feedFullContextText, feedProjectionInfo, projectFeedItem } from "./feed-contract";

const contextRevision = "revision-7";
const fullNarrative = "Every paragraph remains visible. ".repeat(100).trim();
const project = (item: Readonly<Record<string, unknown>>, query?: string) =>
	projectFeedItem({ item, query, contextRevision });

describe("Feed wire content contract", () => {
	it.each([
		{
			item: {
				kind: "session_summary",
				narrative: fullNarrative,
				facts: '[" Summary fact ",42,null," "]',
				body_text: "Duplicate body",
			},
			narrative: fullNarrative,
			body: "",
			facts: ["Summary fact"],
			context: null,
		},
		{
			item: { narrative: "Complete narrative", body_text: "Duplicate body" },
			narrative: "Complete narrative",
			body: "",
			facts: [],
			context: null,
		},
		{
			item: { body_text: " Complete legacy body " },
			narrative: "",
			body: "Complete legacy body",
			facts: [],
			context: null,
		},
		{
			item: {
				narrative: "Deferred complete narrative",
				facts: ["Visible fact"],
				body_text: "Duplicate body",
			},
			narrative: "",
			body: "",
			facts: ["Visible fact"],
			context: "Deferred complete narrative",
		},
		// Facts suppress the legacy body before the UI chooses disclosure content.
		{
			item: { facts: ["Visible fact"], body_text: "Huge hidden legacy body" },
			narrative: "",
			body: "",
			facts: ["Visible fact"],
			context: null,
		},
		{
			item: { facts: "not JSON", narrative: " " },
			narrative: "",
			body: "",
			facts: [],
			context: null,
		},
	])(
		"preserves visible content and defers only eligible context: $item",
		({ item, narrative, body, facts, context }) => {
			// Arrange
			const source = Object.freeze({ id: 7, title: "Stored title", ...item });
			// Act
			const result = project(source);
			// Assert
			expect(result).toMatchObject({
				id: 7,
				title: "Stored title",
				narrative,
				body_text: body,
				facts,
			});
			expect(feedFullContextText(source)).toBe(context);
			expect(result.feed.full_context).toEqual(context ? { revision: contextRevision } : null);
		},
	);

	it.each([
		[{ import_metadata: { is_summary: true } }, true],
		[{ import_metadata: { is_summary: true }, is_summary: false }, false],
		[{ is_summary: "true" }, false],
		[{ import_metadata: { source: " observer_SUMMARY " } }, true],
		[{ import_metadata: { source: "observer_summary" }, source: "" }, false],
	])("retains strict summary classification and outer override: %j", (metadata_json, summary) => {
		// Arrange
		const item = { metadata_json, narrative: "Whole narrative", facts: ["Fact"] };
		// Act
		const result = project(item);
		// Assert
		expect(result.metadata_json).toEqual(summary ? { is_summary: true } : undefined);
		expect(result.narrative).toBe(summary ? "Whole narrative" : "");
		expect(result.feed.full_context).toEqual(summary ? null : { revision: contextRevision });
	});
});

describe("Feed presentation fields", () => {
	it.each([
		[{ tags: [], tags_text: "ignored" }, []],
		[{ tags: "invalid", tags_text: "ignored" }, []],
		[{ tags_text: '["one",2]' }, ["one", "2"]],
		[{ tags_text: " one\t two\nthree " }, ["one", "two", "three"]],
	])("preserves tag precedence and rendered strings: %j", (item, expected) => {
		// Arrange
		const source = { ...item, files: '["src/example.ts",7,null,{"path":"x"}]' };
		// Act
		const result = project(source);
		// Assert
		expect(result.tags).toEqual(expected);
		expect(result.files).toEqual(["src/example.ts", "7", "null", "[object Object]"]);
	});

	it("retains provenance without copying raw metadata or hidden search payloads", () => {
		// Arrange
		const source = {
			id: 7,
			kind: " BuGFix ",
			title: "Complete title",
			actor_id: "actor-7",
			owned_by_self: false,
			resolved_actor_display_name: "Taylor",
			resolved_device_display_name: "Laptop",
			visibility: "private",
			trust_state: "trusted",
			workspace_kind: "",
			origin_source: "mcp",
			origin_device_id: "device-7",
			created_at_utc: "2026-01-01T00:00:00Z",
			subtitle: "Hidden subtitle",
			summary: { request: "Hidden request" },
			facts: ["Visible fact"],
			body_text: "Hidden body",
			metadata_json: {
				visibility: "shared",
				workspace_kind: "personal",
				narrative: "Hidden narrative",
				facts: { raw: "Hidden fact" },
				import_metadata: { trust_state: "unreviewed" },
			},
		};
		// Act
		const result = project(source, "Hidden request");
		// Assert
		expect(result).toMatchObject({
			kind: " BuGFix ",
			actor_id: "actor-7",
			owned_by_self: false,
			resolved_actor_display_name: "Taylor",
			resolved_device_display_name: "Laptop",
			visibility: "private",
			trust_state: "trusted",
			workspace_kind: "personal",
			origin_source: "mcp",
			origin_device_id: "device-7",
			created_at: source.created_at_utc,
			facts: ["Visible fact"],
			body_text: "",
			narrative: "",
		});
		expect(result).not.toHaveProperty("metadata_json");
		for (const field of [
			"subtitle",
			"summary",
			"tags_text",
			"searchOnlyText",
			"search_text",
			"created_at_utc",
		])
			expect(result).not.toHaveProperty(field);
		expect(result.feed.search_match).toEqual({
			label: "Body",
			excerpt:
				"Hidden body Hidden subtitle Hidden narrative request Hidden request raw Hidden fact",
		});
	});

	it.each([
		[
			{ title: "ls", body_text: "Long enough original body to avoid low signal", facts: ["Fact"] },
			false,
		],
		[{ title: "Repeated", body_text: "Repeated", narrative: "Long visible narrative" }, true],
		[{ title: "› list", body_text: "short body" }, true],
		[{}, true],
	])("classifies low signal before dropping the body: %j", (item, expected) => {
		// Arrange
		const source = Object.freeze(item);
		// Act
		const result = project(source);
		// Assert
		expect(result.feed.low_signal).toBe(expected);
	});
});

describe("Feed projection descriptor validation", () => {
	it("recognizes the complete versioned descriptor", () => {
		// Arrange
		const item = project({ id: 7, facts: ["Fact"], narrative: "Context" }, "context");
		// Act
		const result = feedProjectionInfo(item);
		// Assert
		expect(result).toEqual({
			version: 1,
			low_signal: true,
			query: "context",
			matches_query: true,
			search_match: { label: "Content", excerpt: "Context Fact" },
			full_context: { revision: contextRevision },
		});
	});

	it.each([
		null,
		[],
		{},
		{ feed: {} },
		...[
			{ version: 2 },
			{ low_signal: "false" },
			{ query: null },
			{ matches_query: 1 },
			{ search_match: { label: "Title", excerpt: "x" } },
			{ search_match: { label: "Body", excerpt: 7 } },
			{ full_context: {} },
			{ full_context: { revision: 7 } },
		].map((patch) => ({
			feed: {
				version: 1,
				low_signal: false,
				query: "",
				matches_query: false,
				search_match: null,
				full_context: null,
				...patch,
			},
		})),
	])("rejects malformed descriptors: %j", (item) => {
		// Arrange
		const source: unknown = item;
		// Act
		const result = feedProjectionInfo(source);
		// Assert
		expect(result).toBeNull();
	});
});
