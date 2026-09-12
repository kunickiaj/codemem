import {
	MEMORY_FILTER_FIELD_TYPES,
	MEMORY_FILTER_NAMES,
	type MemoryFilterFieldType,
	type MemoryFilterName,
	REMEMBER_MEMORY_KINDS,
} from "@codemem/core";
import { describe, expect, it } from "vitest";
import { filterNames, filterSchema, memoryKindSchema } from "./schemas.js";

describe("memoryKindSchema", () => {
	it("accepts every remember kind from the core catalog", () => {
		for (const kind of REMEMBER_MEMORY_KINDS) {
			expect(memoryKindSchema.safeParse(kind).success).toBe(true);
		}
	});

	it("rejects session_summary and unknown kinds", () => {
		expect(memoryKindSchema.safeParse("session_summary").success).toBe(false);
		expect(memoryKindSchema.safeParse("not-a-kind").success).toBe(false);
	});
});

describe("filterSchema parity with the shared core catalog", () => {
	it("exposes exactly the shared filter names in both surfaces", () => {
		expect(filterNames).toEqual([...MEMORY_FILTER_NAMES]);
		expect(Object.keys(filterSchema).toSorted()).toEqual([...MEMORY_FILTER_NAMES]);
	});

	it("accepts and rejects values per the shared field types", () => {
		const valid: Record<MemoryFilterFieldType, unknown> = {
			string: "x",
			"string-array": ["x", "y"],
			int: 2,
			number: 1.5,
			"boolean-or-string": true,
		};
		const invalid: Record<MemoryFilterFieldType, unknown[]> = {
			string: [false, 3],
			"string-array": ["x", [1], { x: 1 }],
			int: [1.5, "2", true],
			number: ["abc", false],
			"boolean-or-string": [3],
		};
		for (const [name, fieldType] of Object.entries(MEMORY_FILTER_FIELD_TYPES)) {
			const field = filterSchema[name as MemoryFilterName];
			expect(field.safeParse(valid[fieldType]).success, name).toBe(true);
			expect(field.safeParse(undefined).success, name).toBe(true);
			for (const bad of invalid[fieldType]) {
				expect(field.safeParse(bad).success, `${name}: ${JSON.stringify(bad)}`).toBe(false);
			}
		}
	});
});
