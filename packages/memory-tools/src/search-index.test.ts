import { describe, expect, it } from "vitest";
import { projectSearchIndex } from "./search-index.js";

const oversized = '💡\u0001\\"'.repeat(1_000);

const row = {
	id: Number.MAX_SAFE_INTEGER,
	session_id: Number.MAX_SAFE_INTEGER,
	score: -Number.MIN_VALUE,
	kind: oversized,
	title: oversized,
	created_at: oversized,
	body: "full body",
	metadata: { facts: [oversized], arbitrarilyNested: { text: oversized } },
};

describe("search index projection", () => {
	it.each([
		{ limit: 8, count: 8, budget: 5 * 1024 },
		{ limit: 50, count: 50, budget: 30 * 1024 },
		{ limit: 500, count: 50, budget: 30 * 1024 },
	])("fits $count ranked entries within $budget JSON bytes", ({ limit, count, budget }) => {
		const metadata = {
			...row.metadata,
			widened_from_project: true,
			widened_from_shared: true,
			source_project: oversized,
		};
		const rows = Array.from({ length: 55 }, (_, i) => ({ ...row, id: row.id - i, metadata }));
		const value = projectSearchIndex(rows, limit);

		expect(value.items.map((item) => item.id)).toEqual(rows.slice(0, count).map((item) => item.id));
		expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(budget);
		expect(value.items[0]).toEqual({
			id: row.id,
			session_id: row.session_id,
			score: row.score,
			kind: expect.stringMatching(/…$/u),
			title: expect.stringMatching(/…$/u),
			created_at: expect.stringMatching(/…$/u),
			metadata: {
				widened_from_project: true,
				widened_from_shared: true,
				source_project: expect.stringMatching(/…$/u),
			},
		});
		expect(Buffer.byteLength(JSON.stringify(value.items[0]?.title))).toBeLessThanOrEqual(256);
	});

	it("keeps short fields and does not split a surrogate pair when clipping", () => {
		const title = `a${"💡".repeat(100)}`;
		const value = projectSearchIndex(
			[{ ...row, kind: "change", title, created_at: "2026-10-01T00:00:00Z" }],
			1,
		);
		expect(value.items[0]).toMatchObject({
			kind: "change",
			created_at: "2026-10-01T00:00:00Z",
			title: `a${"💡".repeat(62)}…`,
		});
	});
});
