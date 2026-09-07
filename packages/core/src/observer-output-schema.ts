import type { ParsedOutput } from "./ingest-types.js";
import { REMEMBER_MEMORY_KINDS, type RememberMemoryKind } from "./memory-kinds.js";
import { OBSERVER_CONCEPTS } from "./observer-concepts.js";

export const OBSERVER_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const OBSERVER_ENVELOPE_SCHEMA_NAME = "codemem_observer_envelope_v1";

export const OBSERVER_OUTPUT_LIMITS = {
	observations: 50,
	listItems: 100,
	concepts: OBSERVER_CONCEPTS.length,
	textCharacters: 16_384,
} as const;

export interface ObserverObservationV1 {
	kind: RememberMemoryKind;
	title: string;
	narrative: string;
	subtitle: string | null;
	facts: string[];
	concepts: string[];
	files_read: string[];
	files_modified: string[];
}

export interface ObserverSummaryV1 {
	request: string;
	investigated: string;
	learned: string;
	completed: string;
	next_steps: string;
	notes: string;
	files_read: string[];
	files_modified: string[];
}

export interface ObserverEnvelopeV1 {
	schema_version: typeof OBSERVER_ENVELOPE_SCHEMA_VERSION;
	status: "captured" | "skipped";
	observations: ObserverObservationV1[];
	summary: ObserverSummaryV1 | null;
	skip_reason: string | null;
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

const stringSchema = {
	type: "string",
} as const;

const stringArraySchema = {
	type: "array",
	items: stringSchema,
} as const;

const observationSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		kind: { type: "string", enum: [...REMEMBER_MEMORY_KINDS] },
		title: stringSchema,
		narrative: stringSchema,
		subtitle: { type: ["string", "null"] },
		facts: stringArraySchema,
		concepts: {
			type: "array",
			items: { ...stringSchema, enum: [...OBSERVER_CONCEPTS] },
		},
		files_read: stringArraySchema,
		files_modified: stringArraySchema,
	},
	required: [
		"kind",
		"title",
		"narrative",
		"subtitle",
		"facts",
		"concepts",
		"files_read",
		"files_modified",
	],
} as const;

const summarySchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		request: { ...stringSchema, description: "The user's request and session goal." },
		investigated: { ...stringSchema, description: "What was examined or attempted." },
		learned: { ...stringSchema, description: "Durable discoveries from the session." },
		completed: { ...stringSchema, description: "Work completed and concrete outcomes." },
		next_steps: {
			...stringSchema,
			description: "Remaining work, blockers, and next actions.",
		},
		notes: { ...stringSchema, description: "Relevant decisions, trade-offs, or warnings." },
		files_read: stringArraySchema,
		files_modified: stringArraySchema,
	},
	required: [
		"request",
		"investigated",
		"learned",
		"completed",
		"next_steps",
		"notes",
		"files_read",
		"files_modified",
	],
} as const;

/** Conservative provider-neutral JSON Schema accepted by supported direct APIs. */
export const OBSERVER_ENVELOPE_JSON_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	properties: {
		schema_version: { type: "integer", enum: [OBSERVER_ENVELOPE_SCHEMA_VERSION] },
		status: { type: "string", enum: ["captured", "skipped"] },
		observations: {
			type: "array",
			items: observationSchema,
		},
		summary: { anyOf: [summarySchema, { type: "null" }] },
		skip_reason: { type: ["string", "null"] },
	},
	required: ["schema_version", "status", "observations", "summary", "skip_reason"],
};

const ENVELOPE_KEYS = [
	"schema_version",
	"status",
	"observations",
	"summary",
	"skip_reason",
] as const;
const OBSERVATION_KEYS = [
	"kind",
	"title",
	"narrative",
	"subtitle",
	"facts",
	"concepts",
	"files_read",
	"files_modified",
] as const;
const SUMMARY_KEYS = [
	"request",
	"investigated",
	"learned",
	"completed",
	"next_steps",
	"notes",
	"files_read",
	"files_modified",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateExactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	path: string,
	issues: string[],
): void {
	for (const key of keys) {
		if (!Object.hasOwn(value, key)) issues.push(`${path}.${key} is required`);
	}
	const unexpectedCount = Object.keys(value).filter((key) => !keys.includes(key)).length;
	if (unexpectedCount > 0) issues.push(`${path} has ${unexpectedCount} unexpected properties`);
}

function validateString(value: unknown, path: string, issues: string[]): value is string {
	if (typeof value !== "string") {
		issues.push(`${path} must be a string`);
		return false;
	}
	if (value.length > OBSERVER_OUTPUT_LIMITS.textCharacters) {
		issues.push(`${path} must contain at most ${OBSERVER_OUTPUT_LIMITS.textCharacters} characters`);
	}
	return true;
}

function validateStringArray(
	value: unknown,
	path: string,
	issues: string[],
	options: { allowed?: ReadonlySet<string>; maxItems?: number } = {},
): void {
	if (!Array.isArray(value)) {
		issues.push(`${path} must be an array`);
		return;
	}
	const maxItems = options.maxItems ?? OBSERVER_OUTPUT_LIMITS.listItems;
	if (value.length > maxItems) {
		issues.push(`${path} must contain at most ${maxItems} items`);
	}
	for (const [index, item] of value.entries()) {
		if (!validateString(item, `${path}[${index}]`, issues)) continue;
		if (options.allowed && !options.allowed.has(item)) {
			issues.push(`${path}[${index}] is not allowed`);
		}
	}
}

function validateObservation(value: unknown, index: number, issues: string[]): void {
	const path = `$.observations[${index}]`;
	if (!isRecord(value)) {
		issues.push(`${path} must be an object`);
		return;
	}
	validateExactKeys(value, OBSERVATION_KEYS, path, issues);
	if (
		typeof value.kind !== "string" ||
		!REMEMBER_MEMORY_KINDS.includes(value.kind as RememberMemoryKind)
	) {
		issues.push(`${path}.kind is not supported`);
	}
	validateString(value.title, `${path}.title`, issues);
	validateString(value.narrative, `${path}.narrative`, issues);
	if (value.subtitle !== null) validateString(value.subtitle, `${path}.subtitle`, issues);
	validateStringArray(value.facts, `${path}.facts`, issues);
	validateStringArray(value.concepts, `${path}.concepts`, issues, {
		allowed: new Set(OBSERVER_CONCEPTS),
		maxItems: OBSERVER_OUTPUT_LIMITS.concepts,
	});
	validateStringArray(value.files_read, `${path}.files_read`, issues);
	validateStringArray(value.files_modified, `${path}.files_modified`, issues);
}

function validateSummary(value: unknown, issues: string[]): void {
	if (!isRecord(value)) {
		issues.push("$.summary must be an object or null");
		return;
	}
	validateExactKeys(value, SUMMARY_KEYS, "$.summary", issues);
	for (const key of SUMMARY_KEYS) {
		if (key === "files_read" || key === "files_modified") {
			validateStringArray(value[key], `$.summary.${key}`, issues);
			continue;
		}
		validateString(value[key], `$.summary.${key}`, issues);
	}
}

function validateEnvelopeFields(value: Record<string, unknown>, issues: string[]): void {
	validateExactKeys(value, ENVELOPE_KEYS, "$", issues);
	if (value.schema_version !== OBSERVER_ENVELOPE_SCHEMA_VERSION) {
		issues.push(`$.schema_version must equal ${OBSERVER_ENVELOPE_SCHEMA_VERSION}`);
	}
	if (value.status !== "captured" && value.status !== "skipped") {
		issues.push('$.status must equal "captured" or "skipped"');
	}
	if (!Array.isArray(value.observations)) {
		issues.push("$.observations must be an array");
	} else {
		if (value.observations.length > OBSERVER_OUTPUT_LIMITS.observations) {
			issues.push(
				`$.observations must contain at most ${OBSERVER_OUTPUT_LIMITS.observations} items`,
			);
		}
		value.observations.forEach((observation, index) => {
			validateObservation(observation, index, issues);
		});
	}
	if (value.summary !== null) validateSummary(value.summary, issues);
	if (value.skip_reason !== null) validateString(value.skip_reason, "$.skip_reason", issues);
}

function validateEnvelopeState(value: Record<string, unknown>, issues: string[]): void {
	if (value.status === "captured") {
		if (value.skip_reason !== null) {
			issues.push("$.skip_reason must be null when status is captured");
		}
		const hasPersistableObservation =
			Array.isArray(value.observations) &&
			value.observations.some(
				(observation) =>
					isRecord(observation) &&
					((typeof observation.title === "string" && observation.title.trim().length > 0) ||
						(typeof observation.narrative === "string" && observation.narrative.trim().length > 0)),
			);
		const summary = isRecord(value.summary) ? value.summary : null;
		const hasPersistableSummary =
			summary !== null &&
			["request", "investigated", "learned", "completed", "next_steps", "notes"].some((key) => {
				const text = summary[key];
				return typeof text === "string" && text.trim().length > 0;
			});
		if (!hasPersistableObservation && !hasPersistableSummary) {
			issues.push("captured output must contain observations or a summary");
		}
		return;
	}
	if (value.status !== "skipped") return;
	if (Array.isArray(value.observations) && value.observations.length > 0) {
		issues.push("$.observations must be empty when status is skipped");
	}
	if (value.summary !== null) issues.push("$.summary must be null when status is skipped");
	if (value.skip_reason !== "low-signal") {
		issues.push('$.skip_reason must equal "low-signal" when status is skipped');
	}
}

export function validateObserverEnvelopeV1(value: unknown): ObserverEnvelopeParseResult {
	const issues: string[] = [];
	if (!isRecord(value)) {
		return {
			ok: false,
			reason: "structured_output_schema_invalid",
			issues: ["$ must be an object"],
		};
	}

	validateEnvelopeFields(value, issues);
	validateEnvelopeState(value, issues);

	if (issues.length > 0) {
		return { ok: false, reason: "structured_output_schema_invalid", issues };
	}
	return { ok: true, envelope: value as unknown as ObserverEnvelopeV1 };
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
