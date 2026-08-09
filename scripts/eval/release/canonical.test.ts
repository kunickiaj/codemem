import { describe, expect, it } from "vitest";
import { digestCorpus, serialize } from "./canonical.js";

describe("canonical release-eval data", () => {
	it("normalizes text and orders object keys", () => {
		expect(serialize({ z: "e\u0301\r\n", a: 1 })).toBe('{"a":1,"z":"é\\n"}');
	});

	it("produces an order-independent logical corpus digest", () => {
		const rows = [
			{ case_id: "b", ordinal: 0, row_type: "observer_case", value: { text: "two" } },
			{ case_id: "a", ordinal: 0, row_type: "observer_case", value: { text: "one" } },
		];
		expect(digestCorpus({ schema_version: 1, rows })).toBe(
			digestCorpus({ schema_version: 1, rows: rows.toReversed() }),
		);
	});

	it("rejects duplicate logical rows", () => {
		const row = { case_id: "a", ordinal: 0, row_type: "observer_case", value: null };
		expect(() => digestCorpus({ schema_version: 1, rows: [row, row] })).toThrow("unique");
	});
});
