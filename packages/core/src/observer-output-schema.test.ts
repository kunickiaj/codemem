import { describe, expect, it } from "vitest";
import {
	normalizeObserverEnvelopeV1,
	OBSERVER_ENVELOPE_JSON_SCHEMA,
	OBSERVER_OUTPUT_LIMITS,
	parseObserverEnvelopeV1,
	validateObserverEnvelopeV1,
} from "./observer-output-schema.js";

function validCapture() {
	return {
		schema_version: 1,
		status: "captured",
		observations: [
			{
				kind: "decision",
				title: "Use a versioned envelope",
				narrative: "The observer now emits constrained JSON.",
				subtitle: null,
				facts: ["The envelope is validated locally."],
				concepts: ["what-changed"],
				files_read: ["packages/core/src/observer-client.ts"],
				files_modified: [],
			},
		],
		summary: null,
		skip_reason: null,
	};
}

describe("observer envelope v1", () => {
	it("publishes a closed provider schema", () => {
		expect(OBSERVER_ENVELOPE_JSON_SCHEMA).toMatchInlineSnapshot(`
			{
			  "additionalProperties": false,
			  "properties": {
			    "observations": {
			      "items": {
			        "additionalProperties": false,
			        "properties": {
			          "concepts": {
			            "items": {
			              "enum": [
			                "how-it-works",
			                "why-it-exists",
			                "what-changed",
			                "problem-solution",
			                "gotcha",
			                "pattern",
			                "trade-off",
			              ],
			              "type": "string",
			            },
			            "type": "array",
			          },
			          "facts": {
			            "items": {
			              "type": "string",
			            },
			            "type": "array",
			          },
			          "files_modified": {
			            "items": {
			              "type": "string",
			            },
			            "type": "array",
			          },
			          "files_read": {
			            "items": {
			              "type": "string",
			            },
			            "type": "array",
			          },
			          "kind": {
			            "enum": [
			              "discovery",
			              "change",
			              "feature",
			              "bugfix",
			              "refactor",
			              "decision",
			              "exploration",
			            ],
			            "type": "string",
			          },
			          "narrative": {
			            "type": "string",
			          },
			          "subtitle": {
			            "type": [
			              "string",
			              "null",
			            ],
			          },
			          "title": {
			            "type": "string",
			          },
			        },
			        "required": [
			          "kind",
			          "title",
			          "narrative",
			          "subtitle",
			          "facts",
			          "concepts",
			          "files_read",
			          "files_modified",
			        ],
			        "type": "object",
			      },
			      "type": "array",
			    },
			    "schema_version": {
			      "enum": [
			        1,
			      ],
			      "type": "integer",
			    },
			    "skip_reason": {
			      "type": [
			        "string",
			        "null",
			      ],
			    },
			    "status": {
			      "enum": [
			        "captured",
			        "skipped",
			      ],
			      "type": "string",
			    },
			    "summary": {
			      "anyOf": [
			        {
			          "additionalProperties": false,
			          "properties": {
			            "completed": {
			              "description": "Work completed and concrete outcomes.",
			              "type": "string",
			            },
			            "files_modified": {
			              "items": {
			                "type": "string",
			              },
			              "type": "array",
			            },
			            "files_read": {
			              "items": {
			                "type": "string",
			              },
			              "type": "array",
			            },
			            "investigated": {
			              "description": "What was examined or attempted.",
			              "type": "string",
			            },
			            "learned": {
			              "description": "Durable discoveries from the session.",
			              "type": "string",
			            },
			            "next_steps": {
			              "description": "Remaining work, blockers, and next actions.",
			              "type": "string",
			            },
			            "notes": {
			              "description": "Relevant decisions, trade-offs, or warnings.",
			              "type": "string",
			            },
			            "request": {
			              "description": "The user's request and session goal.",
			              "type": "string",
			            },
			          },
			          "required": [
			            "request",
			            "investigated",
			            "learned",
			            "completed",
			            "next_steps",
			            "notes",
			            "files_read",
			            "files_modified",
			          ],
			          "type": "object",
			        },
			        {
			          "type": "null",
			        },
			      ],
			    },
			  },
			  "required": [
			    "schema_version",
			    "status",
			    "observations",
			    "summary",
			    "skip_reason",
			  ],
			  "type": "object",
			}
		`);
	});
});

describe("observer envelope validation", () => {
	it("validates and normalizes captured observations", () => {
		const result = validateObserverEnvelopeV1(validCapture());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(normalizeObserverEnvelopeV1(result.envelope)).toEqual({
			observations: [
				{
					kind: "decision",
					title: "Use a versioned envelope",
					narrative: "The observer now emits constrained JSON.",
					subtitle: null,
					facts: ["The envelope is validated locally."],
					concepts: ["what-changed"],
					filesRead: ["packages/core/src/observer-client.ts"],
					filesModified: [],
				},
			],
			summary: null,
			skipSummaryReason: null,
		});
	});

	it("accepts a summary-only capture", () => {
		const value = validCapture();
		value.observations = [];
		value.summary = {
			request: "Replace XML",
			investigated: "Observer transports",
			learned: "Direct APIs support schemas",
			completed: "Defined the contract",
			next_steps: "Wire ingestion",
			notes: "",
			files_read: [],
			files_modified: [],
		};
		expect(validateObserverEnvelopeV1(value).ok).toBe(true);
	});

	it("keeps an intentional skip distinct", () => {
		const result = validateObserverEnvelopeV1({
			schema_version: 1,
			status: "skipped",
			observations: [],
			summary: null,
			skip_reason: "low-signal",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(normalizeObserverEnvelopeV1(result.envelope).skipSummaryReason).toBe("low-signal");
	});
});

describe("observer envelope failures", () => {
	it.each([
		["non-object root", []],
		["unsupported version", { ...validCapture(), schema_version: 2 }],
		["unknown envelope property", { ...validCapture(), extra: true }],
		[
			"unsupported kind",
			{ ...validCapture(), observations: [{ ...validCapture().observations[0], kind: "note" }] },
		],
		[
			"missing required array",
			{
				...validCapture(),
				observations: [{ ...validCapture().observations[0], facts: undefined }],
			},
		],
		["captured skip reason", { ...validCapture(), skip_reason: "low-signal" }],
		["empty capture", { ...validCapture(), observations: [] }],
		["skipped observation", { ...validCapture(), status: "skipped", skip_reason: "low-signal" }],
		[
			"skipped summary",
			{
				...validCapture(),
				status: "skipped",
				observations: [],
				summary: {
					request: "request",
					investigated: "",
					learned: "",
					completed: "",
					next_steps: "",
					notes: "",
					files_read: [],
					files_modified: [],
				},
				skip_reason: "low-signal",
			},
		],
		[
			"non-string fact",
			{
				...validCapture(),
				observations: [{ ...validCapture().observations[0], facts: [1] }],
			},
		],
		[
			"non-canonical concept",
			{
				...validCapture(),
				observations: [{ ...validCapture().observations[0], concepts: ["Gotcha"] }],
			},
		],
		[
			"empty skip reason",
			{ ...validCapture(), status: "skipped", observations: [], skip_reason: " " },
		],
		[
			"unsupported skip reason",
			{ ...validCapture(), status: "skipped", observations: [], skip_reason: "other" },
		],
	])("rejects %s", (_name, value) => {
		expect(validateObserverEnvelopeV1(value).ok).toBe(false);
	});

	it("rejects provider-valid output with local size overages", () => {
		const value = validCapture();
		value.observations[0].title = "x".repeat(OBSERVER_OUTPUT_LIMITS.textCharacters + 1);
		value.observations[0].facts = Array.from(
			{ length: OBSERVER_OUTPUT_LIMITS.listItems + 1 },
			() => "fact",
		);
		const result = validateObserverEnvelopeV1(value);
		expect(result).toMatchObject({
			ok: false,
			reason: "structured_output_schema_invalid",
		});
	});

	it("rejects observation-count overages before normalization", () => {
		const value = validCapture();
		value.observations = Array.from(
			{ length: OBSERVER_OUTPUT_LIMITS.observations + 1 },
			(_, index) => ({
				...validCapture().observations[0],
				title: `${index}${"x".repeat(OBSERVER_OUTPUT_LIMITS.textCharacters)}`,
				facts: Array.from({ length: OBSERVER_OUTPUT_LIMITS.listItems + 1 }, () => "fact"),
				concepts: Array.from({ length: OBSERVER_OUTPUT_LIMITS.concepts + 1 }, () => "gotcha"),
			}),
		);
		const result = validateObserverEnvelopeV1(value);
		expect(result).toMatchObject({
			ok: false,
			reason: "structured_output_schema_invalid",
		});
	});

	it("keeps clipped text well-formed at a surrogate-pair boundary", () => {
		const value = validCapture();
		value.observations[0].title = `${"x".repeat(OBSERVER_OUTPUT_LIMITS.textCharacters - 1)}💾`;
		const title = normalizeObserverEnvelopeV1(value).observations[0]?.title;
		expect(title).toBe(`${"x".repeat(OBSERVER_OUTPUT_LIMITS.textCharacters - 1)}�`);
		expect(title?.isWellFormed()).toBe(true);
	});
});

describe("observer envelope persistability", () => {
	it("rejects captured output with no persistable content", () => {
		const emptySummary = {
			request: "",
			investigated: "",
			learned: "",
			completed: "",
			next_steps: "",
			notes: "",
			files_read: [],
			files_modified: [],
		};
		const emptyObservation = {
			...validCapture().observations[0],
			title: "",
			narrative: "",
		};

		expect(
			validateObserverEnvelopeV1({
				...validCapture(),
				observations: [emptyObservation],
				summary: emptySummary,
			}),
		).toMatchObject({ ok: false, reason: "structured_output_schema_invalid" });
	});

	it("classifies invalid JSON separately from schema failures", () => {
		expect(parseObserverEnvelopeV1("not json")).toEqual({
			ok: false,
			reason: "structured_output_invalid_json",
			issues: ["observer output is not valid JSON"],
		});
		expect(parseObserverEnvelopeV1("{}")).toMatchObject({
			ok: false,
			reason: "structured_output_schema_invalid",
		});
	});
});
