import { describe, expect, it } from "vitest";
import { parseReleaseEvalManifest } from "./manifest.js";

function manifest(): unknown {
	return {
		schema_version: 1,
		benchmark_profile: "release-v1",
		corpora: [
			{
				tier: "public",
				schema_version: 1,
				source_path: "corpus.json",
				expected_digest: `sha256:${"a".repeat(64)}`,
			},
		],
		evaluator: {
			commit: "b".repeat(40),
			configuration: {
				provider: "fixture",
				transport: "fake",
				endpoint_mode: "provider_default",
				model: "fixture-v1",
				temperature: 0,
				openai_responses: false,
				reasoning_effort: null,
				reasoning_summary: null,
				max_output_tokens: 512,
				tier_routing_enabled: false,
			},
		},
		subjects: [
			{
				label: "candidate",
				requested_ref: "b".repeat(40),
				observer_context_schema_version: 1,
				subject: { kind: "candidate", version: "0.40.0" },
				components: ["observer", "retrieval", "injection"],
			},
		],
		repetitions: 1,
	};
}

describe("release eval manifest", () => {
	it("strictly binds versioned subjects and evaluator configuration", () => {
		expect(parseReleaseEvalManifest(manifest())).toMatchObject({
			subjects: [
				{
					subject: { kind: "candidate", version: "0.40.0" },
					components: ["observer", "retrieval", "injection"],
				},
			],
		});
	});

	it("rejects unknown fields and malformed version provenance", () => {
		expect(() =>
			parseReleaseEvalManifest({ ...(manifest() as object), private_path: "/private" }),
		).toThrow("unknown field");
		const invalid = manifest() as { subjects: Array<{ subject: { version: string } }> };
		const subject = invalid.subjects[0];
		if (!subject) throw new Error("fixture subject missing");
		subject.subject.version = "latest";
		expect(() => parseReleaseEvalManifest(invalid)).toThrow("semantic version");
	});

	it("rejects unknown, duplicate, and invalid PR3 components", () => {
		const withComponents = (components: unknown[]): unknown => {
			const value = manifest() as { subjects: Array<{ components: unknown[] }> };
			const subject = value.subjects[0];
			if (!subject) throw new Error("fixture subject missing");
			subject.components = components;
			return value;
		};
		expect(() => parseReleaseEvalManifest(withComponents(["observer", "unsupported"]))).toThrow(
			"is not supported",
		);
		expect(() => parseReleaseEvalManifest(withComponents(["observer", "observer"]))).toThrow(
			"must not contain duplicates",
		);
		expect(() => parseReleaseEvalManifest(withComponents([]))).toThrow("must be non-empty");
		expect(() => parseReleaseEvalManifest(withComponents(["observer", 1]))).toThrow(
			"is not supported",
		);
	});
});
