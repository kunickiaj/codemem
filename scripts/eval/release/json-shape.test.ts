import { describe, expect, it } from "vitest";
import { exactKeys, jsonValue, parseJson } from "./json-shape.js";

describe("release-eval JSON shape guards", () => {
	it("rejects unknown and missing fields", () => {
		expect(() => exactKeys({ expected: true, secret: true }, ["expected"], "fixture")).toThrow(
			"unknown field",
		);
		expect(() => exactKeys({}, ["expected"], "fixture")).toThrow("missing field");
	});

	it("rejects sparse arrays, accessors, and circular values", () => {
		const sparse: unknown[] = [];
		sparse.length = 1;
		expect(() => jsonValue(sparse, "fixture")).toThrow("sparse array");
		const accessor = Object.defineProperty({}, "secret", {
			enumerable: true,
			get: () => "secret",
		});
		expect(() => jsonValue(accessor, "fixture")).toThrow("enumerable JSON properties");
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		expect(() => jsonValue(circular, "fixture")).toThrow("circular references");
	});

	it("rejects non-finite numbers and malformed JSON", () => {
		expect(() => jsonValue(Number.NaN, "fixture")).toThrow("non-finite");
		expect(() => parseJson("{not-json", "fixture")).toThrow("valid JSON");
	});
});
