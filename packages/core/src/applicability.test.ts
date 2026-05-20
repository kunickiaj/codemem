import { describe, expect, it } from "vitest";
import {
	APPLIES_TO_DEFAULT,
	APPLIES_TO_LAYERS,
	type Applicability,
	normalizeApplicability,
	validateApplicability,
} from "./applicability.js";

describe("validateApplicability", () => {
	it("returns the default applicability when neither field is provided", () => {
		const result = validateApplicability({});
		expect(result).toEqual<Applicability>({ applies_to: "project", applies_to_key: null });
	});

	it("returns the default when both fields are explicitly undefined", () => {
		const result = validateApplicability({ applies_to: undefined, applies_to_key: undefined });
		expect(result.applies_to).toBe(APPLIES_TO_DEFAULT);
	});

	it("accepts each known layer", () => {
		for (const layer of APPLIES_TO_LAYERS) {
			const needsKey = layer === "org" || layer === "toolchain";
			const result = validateApplicability({
				applies_to: layer,
				applies_to_key: needsKey ? "key-1" : null,
			});
			expect(result.applies_to).toBe(layer);
		}
	});

	it("normalizes case and whitespace on applies_to", () => {
		const result = validateApplicability({ applies_to: "  USER  " });
		expect(result.applies_to).toBe("user");
	});

	it("rejects unknown applies_to values with a structured error", () => {
		expect(() => validateApplicability({ applies_to: "global" })).toThrow(/applies_to/);
	});

	it("requires applies_to_key when applies_to is 'org'", () => {
		expect(() => validateApplicability({ applies_to: "org" })).toThrow(/applies_to_key/);
		expect(() => validateApplicability({ applies_to: "org", applies_to_key: "  " })).toThrow(
			/applies_to_key/,
		);
	});

	it("requires applies_to_key when applies_to is 'toolchain'", () => {
		expect(() => validateApplicability({ applies_to: "toolchain" })).toThrow(/applies_to_key/);
	});

	it("rejects applies_to_key when applies_to is 'user'", () => {
		expect(() => validateApplicability({ applies_to: "user", applies_to_key: "anything" })).toThrow(
			/applies_to_key/,
		);
	});

	it("rejects applies_to_key when applies_to is 'project'", () => {
		expect(() =>
			validateApplicability({ applies_to: "project", applies_to_key: "anything" }),
		).toThrow(/applies_to_key/);
	});

	it("trims and preserves a valid applies_to_key for org/toolchain", () => {
		const org = validateApplicability({ applies_to: "org", applies_to_key: "  acme  " });
		expect(org.applies_to_key).toBe("acme");
		const tc = validateApplicability({ applies_to: "toolchain", applies_to_key: "pnpm" });
		expect(tc.applies_to_key).toBe("pnpm");
	});

	it("lowercases applies_to_key so casing variants converge", () => {
		expect(
			validateApplicability({ applies_to: "toolchain", applies_to_key: "PNPM" }).applies_to_key,
		).toBe("pnpm");
		expect(
			validateApplicability({ applies_to: "toolchain", applies_to_key: "Pnpm" }).applies_to_key,
		).toBe("pnpm");
	});

	it("collapses internal whitespace in applies_to_key", () => {
		expect(
			validateApplicability({ applies_to: "org", applies_to_key: "ACME   inc" }).applies_to_key,
		).toBe("acme inc");
	});
});

describe("normalizeApplicability (row → Applicability)", () => {
	it("defaults a missing applies_to to 'project'", () => {
		const result = normalizeApplicability({ applies_to: null, applies_to_key: null });
		expect(result).toEqual<Applicability>({ applies_to: "project", applies_to_key: null });
	});

	it("defaults a blank applies_to to 'project' (downgrade safety)", () => {
		const result = normalizeApplicability({ applies_to: "   ", applies_to_key: null });
		expect(result.applies_to).toBe("project");
	});

	it("treats an unknown applies_to as 'project' (downgrade safety, no throw)", () => {
		const result = normalizeApplicability({ applies_to: "future-layer", applies_to_key: "x" });
		expect(result.applies_to).toBe("project");
		expect(result.applies_to_key).toBeNull();
	});

	it("retains a known layer and trims its key", () => {
		const result = normalizeApplicability({ applies_to: "ORG", applies_to_key: "  acme  " });
		expect(result).toEqual<Applicability>({ applies_to: "org", applies_to_key: "acme" });
	});

	it("drops the key for layers that do not allow one", () => {
		const result = normalizeApplicability({ applies_to: "user", applies_to_key: "leaked" });
		expect(result.applies_to_key).toBeNull();
	});
});
