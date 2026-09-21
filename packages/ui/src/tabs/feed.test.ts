import { describe, expect, it } from "vitest";
import { state } from "../lib/state";
import {
	packTraceContextKey,
	parseInspectorWorkingSet,
	removeFeedItem,
	syncInspectorQueryDraft,
} from "./feed";

describe("feed item removal", () => {
	it("clears the exact row expansion key", () => {
		state.lastFeedItems = [{ id: 7, kind: "change" }];
		state.itemExpandState.set("change:7", true);

		removeFeedItem(7);

		expect(state.itemExpandState.has("change:7")).toBe(false);
	});
});

describe("syncInspectorQueryDraft", () => {
	it("seeds the inspector query from the current feed search", () => {
		expect(
			syncInspectorQueryDraft({
				feedQuery: "coordinator bug",
				hasInspectorOverride: false,
				inspectorQuery: "old value",
			}),
		).toBe("coordinator bug");
	});

	it("keeps the inspector query independent after the user edits it", () => {
		expect(
			syncInspectorQueryDraft({
				feedQuery: "coordinator bug",
				hasInspectorOverride: true,
				inspectorQuery: "routing trace",
			}),
		).toBe("routing trace");
	});
});

describe("parseInspectorWorkingSet", () => {
	it("normalizes comma and newline separated working-set entries", () => {
		expect(parseInspectorWorkingSet("a.ts\n b.ts, c.ts ,,\n")).toEqual(["a.ts", "b.ts", "c.ts"]);
	});
});

describe("packTraceContextKey", () => {
	it("includes working-set files in the trace identity", () => {
		expect(
			packTraceContextKey({
				project: "codemem",
				query: "fix",
				workingSetFiles: ["a.ts"],
			}),
		).not.toBe(
			packTraceContextKey({
				project: "codemem",
				query: "fix",
				workingSetFiles: ["b.ts"],
			}),
		);
	});
});
