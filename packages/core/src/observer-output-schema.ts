import * as z from "zod";
import type { ParsedOutput } from "./ingest-types.js";
import { REMEMBER_MEMORY_KINDS } from "./memory-kinds.js";
import { OBSERVER_CONCEPTS } from "./observer-concepts.js";

export const OBSERVER_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const OBSERVER_ENVELOPE_SCHEMA_NAME = "codemem_observer_envelope_v1";

export const OBSERVER_OUTPUT_LIMITS = {
	observations: 50,
	listItems: 100,
	concepts: OBSERVER_CONCEPTS.length,
	textCharacters: 16_384,
} as const;

const stringArraySchema = z.array(z.string());

const observerObservationV1Schema = z.strictObject({
	kind: z.enum(REMEMBER_MEMORY_KINDS),
	title: z.string(),
	narrative: z.string(),
	subtitle: z.string().nullable(),
	facts: stringArraySchema,
	concepts: z.array(z.enum(OBSERVER_CONCEPTS)),
	files_read: stringArraySchema,
	files_modified: stringArraySchema,
});

const observerSummaryV1Schema = z.strictObject({
	request: z.string().describe("The user's request and session goal."),
	investigated: z.string().describe("What was examined or attempted."),
	learned: z.string().describe("Durable discoveries from the session."),
	completed: z.string().describe("Work completed and concrete outcomes."),
	next_steps: z.string().describe("Remaining work, blockers, and next actions."),
	notes: z.string().describe("Relevant decisions, trade-offs, or warnings."),
	files_read: stringArraySchema,
	files_modified: stringArraySchema,
});

const observerEnvelopeV1Schema = z.strictObject({
	schema_version: z.literal(OBSERVER_ENVELOPE_SCHEMA_VERSION),
	status: z.enum(["captured", "skipped"]),
	observations: z.array(observerObservationV1Schema),
	summary: observerSummaryV1Schema.nullable(),
	skip_reason: z.string().nullable(),
});

export type ObserverObservationV1 = z.infer<typeof observerObservationV1Schema>;
export type ObserverSummaryV1 = z.infer<typeof observerSummaryV1Schema>;
export type ObserverEnvelopeV1 = z.infer<typeof observerEnvelopeV1Schema>;

export interface ObserverForcedToolCall {
	name: string;
	input: unknown;
}

export type ObserverEnvelopeFailureReason =
	| "structured_output_refused"
	| "structured_output_truncated"
	| "structured_output_missing"
	| "structured_output_invalid_json"
	| "structured_output_schema_invalid"
	| "forced_tool_missing"
	| "forced_tool_multiple_calls"
	| "forced_tool_input_invalid"
	| "legacy_xml_lossy";

export type ObserverEnvelopeParseResult =
	| { ok: true; envelope: ObserverEnvelopeV1 }
	| { ok: false; reason: ObserverEnvelopeFailureReason; issues: string[] };

type JsonSchemaObject = Record<string, unknown>;

function createProviderEnvelopeSchema(): JsonSchemaObject {
	const schema = z.toJSONSchema(observerEnvelopeV1Schema) as JsonSchemaObject;
	delete schema.$schema;

	// Supported providers accept the existing conservative integer enum, not `const`.
	const properties = schema.properties as Record<string, JsonSchemaObject>;
	properties.schema_version = {
		type: "integer",
		enum: [OBSERVER_ENVELOPE_SCHEMA_VERSION],
	};
	return schema;
}

/** Conservative provider-neutral JSON Schema accepted by supported direct APIs. */
export const OBSERVER_ENVELOPE_JSON_SCHEMA = createProviderEnvelopeSchema();

function formatIssuePath(path: readonly PropertyKey[]): string {
	return path.reduce<string>((formatted, segment) => {
		if (typeof segment === "number") return `${formatted}[${segment}]`;
		return `${formatted}.${String(segment)}`;
	}, "$");
}

function sanitizeStructuralIssue(issue: z.core.$ZodIssue): string {
	const path = formatIssuePath(issue.path);
	if (issue.code === "unrecognized_keys") {
		return `${path} has ${issue.keys.length} unexpected properties`;
	}
	if (issue.code === "invalid_type") return `${path} has an invalid type`;
	return `${path} is invalid`;
}

function validateTextLimit(value: string, path: string, issues: string[]): void {
	if (value.length > OBSERVER_OUTPUT_LIMITS.textCharacters) {
		issues.push(`${path} must contain at most ${OBSERVER_OUTPUT_LIMITS.textCharacters} characters`);
	}
}

function validateListLimits(
	values: string[],
	path: string,
	issues: string[],
	maxItems?: number,
): void {
	const limit = maxItems ?? OBSERVER_OUTPUT_LIMITS.listItems;
	if (values.length > limit) issues.push(`${path} must contain at most ${limit} items`);
	values.forEach((value, index) => {
		validateTextLimit(value, `${path}[${index}]`, issues);
	});
}

function validateEnvelopeLimits(value: ObserverEnvelopeV1, issues: string[]): void {
	if (value.observations.length > OBSERVER_OUTPUT_LIMITS.observations) {
		issues.push(`$.observations must contain at most ${OBSERVER_OUTPUT_LIMITS.observations} items`);
	}
	value.observations.forEach((observation, index) => {
		const path = `$.observations[${index}]`;
		validateTextLimit(observation.title, `${path}.title`, issues);
		validateTextLimit(observation.narrative, `${path}.narrative`, issues);
		if (observation.subtitle !== null) {
			validateTextLimit(observation.subtitle, `${path}.subtitle`, issues);
		}
		validateListLimits(observation.facts, `${path}.facts`, issues);
		validateListLimits(
			observation.concepts,
			`${path}.concepts`,
			issues,
			OBSERVER_OUTPUT_LIMITS.concepts,
		);
		validateListLimits(observation.files_read, `${path}.files_read`, issues);
		validateListLimits(observation.files_modified, `${path}.files_modified`, issues);
	});

	if (value.summary !== null) {
		for (const [key, text] of Object.entries(value.summary)) {
			const path = `$.summary.${key}`;
			if (Array.isArray(text)) validateListLimits(text, path, issues);
			else validateTextLimit(text, path, issues);
		}
	}
	if (value.skip_reason !== null) validateTextLimit(value.skip_reason, "$.skip_reason", issues);
}

function validateEnvelopeState(value: ObserverEnvelopeV1, issues: string[]): void {
	if (value.status === "captured") {
		if (value.skip_reason !== null) {
			issues.push("$.skip_reason must be null when status is captured");
		}
		const hasPersistableObservation = value.observations.some(
			(observation) =>
				observation.title.trim().length > 0 || observation.narrative.trim().length > 0,
		);
		const summary = value.summary;
		const hasPersistableSummary =
			summary !== null &&
			["request", "investigated", "learned", "completed", "next_steps", "notes"].some((key) => {
				const text = summary[key as keyof ObserverSummaryV1];
				return typeof text === "string" && text.trim().length > 0;
			});
		if (!hasPersistableObservation && !hasPersistableSummary) {
			issues.push("captured output must contain observations or a summary");
		}
		return;
	}
	if (value.observations.length > 0) {
		issues.push("$.observations must be empty when status is skipped");
	}
	if (value.summary !== null) issues.push("$.summary must be null when status is skipped");
	if (value.skip_reason !== "low-signal") {
		issues.push('$.skip_reason must equal "low-signal" when status is skipped');
	}
}

export function validateObserverEnvelopeV1(value: unknown): ObserverEnvelopeParseResult {
	const parsed = observerEnvelopeV1Schema.safeParse(value);
	if (!parsed.success) {
		return {
			ok: false,
			reason: "structured_output_schema_invalid",
			issues: parsed.error.issues.map(sanitizeStructuralIssue),
		};
	}

	const issues: string[] = [];
	validateEnvelopeLimits(parsed.data, issues);
	validateEnvelopeState(parsed.data, issues);

	if (issues.length > 0) {
		return { ok: false, reason: "structured_output_schema_invalid", issues };
	}
	return { ok: true, envelope: parsed.data };
}

export function parseObserverEnvelopeV1(raw: string): ObserverEnvelopeParseResult {
	// Do not salvage fences or prose: constrained transports must honor the declared contract.
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return {
			ok: false,
			reason: "structured_output_invalid_json",
			issues: ["observer output is not valid JSON"],
		};
	}
	return validateObserverEnvelopeV1(value);
}

export function parseObserverForcedToolCalls(
	calls: readonly ObserverForcedToolCall[],
): ObserverEnvelopeParseResult {
	if (calls.length === 0) {
		return {
			ok: false,
			reason: "forced_tool_missing",
			issues: ["observer response must contain one record_memories tool call"],
		};
	}
	if (calls.length !== 1) {
		return {
			ok: false,
			reason: "forced_tool_multiple_calls",
			issues: ["observer response must contain exactly one tool call"],
		};
	}
	const call = calls[0];
	if (call?.name !== "record_memories") {
		return {
			ok: false,
			reason: "forced_tool_input_invalid",
			issues: ["observer tool call must use record_memories"],
		};
	}
	const parsed = validateObserverEnvelopeV1(call.input);
	if (!parsed.ok) {
		return {
			ok: false,
			reason: "forced_tool_input_invalid",
			issues: parsed.issues,
		};
	}
	return parsed;
}

function clampText(value: string): string {
	return value.slice(0, OBSERVER_OUTPUT_LIMITS.textCharacters).toWellFormed();
}

function clampList(
	values: string[],
	maxItems: number = OBSERVER_OUTPUT_LIMITS.listItems,
): string[] {
	return values.slice(0, maxItems).map(clampText);
}

export function normalizeObserverEnvelopeV1(envelope: ObserverEnvelopeV1): ParsedOutput {
	return {
		observations: envelope.observations
			.slice(0, OBSERVER_OUTPUT_LIMITS.observations)
			.map((observation) => ({
				kind: observation.kind,
				title: clampText(observation.title),
				narrative: clampText(observation.narrative),
				subtitle: observation.subtitle === null ? null : clampText(observation.subtitle),
				facts: clampList(observation.facts),
				concepts: clampList([...new Set(observation.concepts)], OBSERVER_OUTPUT_LIMITS.concepts),
				filesRead: clampList(observation.files_read),
				filesModified: clampList(observation.files_modified),
			})),
		summary: envelope.summary
			? {
					request: clampText(envelope.summary.request),
					investigated: clampText(envelope.summary.investigated),
					learned: clampText(envelope.summary.learned),
					completed: clampText(envelope.summary.completed),
					nextSteps: clampText(envelope.summary.next_steps),
					notes: clampText(envelope.summary.notes),
					filesRead: clampList(envelope.summary.files_read),
					filesModified: clampList(envelope.summary.files_modified),
				}
			: null,
		skipSummaryReason: envelope.status === "skipped" ? envelope.skip_reason : null,
	};
}
