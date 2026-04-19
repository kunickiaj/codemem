/* AI-powered structured-content backfill for older memories.
 *
 * Extracted verbatim from packages/core/src/maintenance.ts as part of
 * the maintenance/ split (tracked under codemem-ug38).
 */

import type { Database } from "../db.js";
import {
	completeMaintenanceJob,
	failMaintenanceJob,
	startMaintenanceJob,
	updateMaintenanceJob,
} from "../maintenance-jobs.js";
import { loadObserverConfig, ObserverClient } from "../observer-client.js";
import { isSummaryLikeMemory } from "../summary-memory.js";

const AI_BACKFILL_KINDS = [
	"change",
	"discovery",
	"bugfix",
	"feature",
	"decision",
	"exploration",
	"refactor",
] as const;

const AI_BACKFILL_CONCEPTS = [
	"how-it-works",
	"why-it-exists",
	"what-changed",
	"problem-solution",
	"gotcha",
	"pattern",
	"trade-off",
] as const;
const AI_BACKFILL_CONCEPT_SET = new Set<string>(AI_BACKFILL_CONCEPTS);

const AI_BACKFILL_JOB_KIND = "ai_structured_backfill";
const AI_BACKFILL_SCHEMA_NAME = "codemem_structured_memory_backfill";
const AI_BACKFILL_SCHEMA: Record<string, unknown> = {
	type: "object",
	additionalProperties: false,
	properties: {
		narrative: { type: ["string", "null"] },
		facts: { type: "array", items: { type: "string" } },
		concepts: { type: "array", items: { type: "string", enum: [...AI_BACKFILL_CONCEPTS] } },
	},
	required: ["narrative", "facts", "concepts"],
};

type StructuredBackfillObserver = Pick<
	ObserverClient,
	"observe" | "observeStructuredJson" | "getStatus"
>;

export interface AIBackfillStructuredContentResult {
	checked: number;
	updated: number;
	skipped: number;
	failed: number;
	samples?: Array<{
		id: number;
		kind: string;
		title: string;
		narrative: string | null;
		facts: string[];
		concepts: string[];
	}>;
}

export interface AIBackfillStructuredContentOptions {
	limit?: number | null;
	kinds?: string[] | null;
	dryRun?: boolean;
	overwrite?: boolean;
	observer?: StructuredBackfillObserver;
}

interface ParsedStructuredBackfill {
	narrative: string | null;
	facts: string[];
	concepts: string[];
}

type StructuredBackfillRow = {
	id: number;
	kind: string;
	title: string;
	body_text: string;
	metadata_json: string | null;
	narrative: string | null;
	facts: string | null;
	concepts: string | null;
};

function createStructuredBackfillObserver(): StructuredBackfillObserver {
	const base = loadObserverConfig();
	return new ObserverClient({
		...base,
		observerProvider: "openai",
		observerModel: "gpt-5.4",
		observerTemperature: 0.2,
		observerOpenAIUseResponses: true,
		observerReasoningEffort: null,
		observerReasoningSummary: null,
		observerMaxOutputTokens: 4000,
	});
}

function parseJsonArrayOfStrings(value: string | null): string[] {
	if (!value) return [];
	try {
		const parsed = JSON.parse(value) as unknown;
		if (Array.isArray(parsed)) {
			return parsed.filter((item): item is string => typeof item === "string");
		}
	} catch {
		return [];
	}
	return [];
}

function hasCompleteStructuredContent(row: {
	narrative: string | null;
	facts: string | null;
	concepts: string | null;
}): boolean {
	return (
		!!row.narrative?.trim() &&
		parseJsonArrayOfStrings(row.facts).length > 0 &&
		parseJsonArrayOfStrings(row.concepts).length > 0
	);
}

function buildStructuredBackfillPrompt(row: {
	id: number;
	kind: string;
	title: string;
	body_text: string;
}): { system: string; user: string } {
	const system = `You are converting older codemem memories into structured fields.

<output_contract>
- Output only valid JSON with exactly this shape:
  {"narrative": string|null, "facts": string[], "concepts": string[]}
- Do not add markdown fences or prose.
- Use null / [] when evidence is missing.
</output_contract>

<field_rules>
- narrative: 2-6 complete sentences, or 1-2 short paragraphs made of complete sentences.
- narrative must end cleanly on a full sentence. Do not output a truncated clause.
- facts: 2-8 source-grounded, self-contained statements. Prefer concrete details over generic purpose statements.
- concepts: 2-5 values from this exact list only:
  ["how-it-works", "why-it-exists", "what-changed", "problem-solution", "gotcha", "pattern", "trade-off"]
</field_rules>

<grounding_rules>
- Use ONLY the evidence in the provided title, kind, and body_text.
- Do not invent files, APIs, behavior, users, dates, or outcomes.
- If the source is vague, be specific only where the text is specific.
- If evidence is insufficient for a field, return null or [].
</grounding_rules>

<concept_rules>
- Use "gotcha" only when the source clearly describes a pitfall, surprise, failure mode, or caveat.
- Use "trade-off" only when the source clearly describes a comparison, compromise, or explicit design tension.
- Prefer fewer concepts over weak concepts.
</concept_rules>

<verbosity_controls>
- Keep the narrative concise and information-dense.
- Avoid repetition between narrative and facts.
</verbosity_controls>

<verification_loop>
- Before finalizing, verify: valid JSON, complete sentences in narrative, concepts only from the allowed list, and every claim grounded in the source.
</verification_loop>`;

	const user = `Memory ID: ${row.id}
Kind: ${row.kind}
Title: ${row.title}

Body text:
${row.body_text}`;

	return { system, user };
}

function sanitizeNarrative(value: string | null): string | null {
	if (!value) return null;
	let text = value.trim();
	text = text.replace(/^\[+/, "").replace(/\]+$/, "").trim();
	if (!text) return null;

	// If the model trails off without sentence punctuation, trim to the last
	// complete sentence if possible. Otherwise reject it as likely truncated.
	if (!/[.!?]["')\]]?\s*$/.test(text)) {
		const lastSentenceEnd = Math.max(
			text.lastIndexOf("."),
			text.lastIndexOf("!"),
			text.lastIndexOf("?"),
		);
		if (lastSentenceEnd >= 20) {
			const before = text;
			text = text.slice(0, lastSentenceEnd + 1).trim();
			console.warn(
				`[codemem] sanitizeNarrative trimmed: "${before.slice(-30)}" → "${text.slice(-30)}"`,
			);
		} else {
			console.warn(`[codemem] sanitizeNarrative rejected: "${text.slice(0, 50)}"`);
			return null;
		}
	}

	return text.length > 0 ? text : null;
}

function parseStructuredBackfillResponse(raw: string | null): ParsedStructuredBackfill {
	if (!raw) throw new Error("observer returned empty response");
	const trimmed = raw.trim();
	const cleaned = trimmed.startsWith("```")
		? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
		: trimmed;
	const parsed = JSON.parse(cleaned) as Record<string, unknown>;
	if (
		!Object.hasOwn(parsed, "narrative") ||
		!Object.hasOwn(parsed, "facts") ||
		!Object.hasOwn(parsed, "concepts")
	) {
		throw new Error("observer returned schema-invalid object");
	}
	if (
		!(typeof parsed.narrative === "string" || parsed.narrative === null) ||
		!Array.isArray(parsed.facts) ||
		!Array.isArray(parsed.concepts)
	) {
		throw new Error("observer returned schema-invalid field types");
	}
	const narrative =
		typeof parsed.narrative === "string" && parsed.narrative.trim()
			? sanitizeNarrative(parsed.narrative)
			: null;
	const facts = Array.isArray(parsed.facts)
		? parsed.facts.filter(
				(item): item is string => typeof item === "string" && item.trim().length > 0,
			)
		: [];
	const concepts = Array.isArray(parsed.concepts)
		? parsed.concepts
				.filter(
					(item): item is string =>
						typeof item === "string" &&
						item.trim().length > 0 &&
						AI_BACKFILL_CONCEPT_SET.has(item.trim().toLowerCase()),
				)
				.map((item) => item.trim().toLowerCase())
		: [];
	return { narrative, facts, concepts };
}

/**
 * AI-powered backfill for older non-session-summary memories that still lack
 * structured content (`narrative`, `facts`, `concepts`). Uses GPT-5.4 via the
 * existing ObserverClient/OpenAI integration.
 */
export async function aiBackfillStructuredContent(
	db: Database,
	opts: AIBackfillStructuredContentOptions = {},
): Promise<AIBackfillStructuredContentResult> {
	const kinds = opts.kinds?.length ? opts.kinds : [...AI_BACKFILL_KINDS];
	const placeholders = kinds.map(() => "?").join(",");
	const limitClause = opts.limit != null && opts.limit > 0 ? `LIMIT ${Number(opts.limit)}` : "";
	const structuredFilter = opts.overwrite
		? "1=1"
		: `(narrative IS NULL OR LENGTH(narrative) = 0 OR facts IS NULL OR LENGTH(facts) <= 2 OR concepts IS NULL OR LENGTH(concepts) <= 2)`;
	const rows = db
		.prepare(
			`SELECT id, kind, title, body_text, metadata_json, narrative, facts, concepts
			 FROM memory_items
			 WHERE active = 1
			   AND kind IN (${placeholders})
			   AND body_text IS NOT NULL
			   AND LENGTH(body_text) > 0
			   AND ${structuredFilter}
			 ORDER BY created_at ASC
			 ${limitClause}`,
		)
		.all(...kinds) as StructuredBackfillRow[];
	const eligibleRows = rows.filter(
		(row) => !isSummaryLikeMemory({ kind: row.kind, metadata: row.metadata_json }),
	);

	const observer = opts.observer ?? createStructuredBackfillObserver();
	const total = eligibleRows.length;
	startMaintenanceJob(db, {
		kind: AI_BACKFILL_JOB_KIND,
		title: "Backfilling structured content",
		message: `Preparing GPT-5.4 extraction for ${total} memories`,
		progressTotal: total,
		metadata: {
			model: observer.getStatus().model,
			provider: observer.getStatus().provider,
			kinds,
			overwrite: opts.overwrite === true,
		},
	});

	let checked = 0;
	let updated = 0;
	let skipped = 0;
	let failed = 0;
	const samples: NonNullable<AIBackfillStructuredContentResult["samples"]> = [];
	const updateStmt = db.prepare(
		"UPDATE memory_items SET narrative = ?, facts = ?, concepts = ?, updated_at = ? WHERE id = ?",
	);

	try {
		for (const row of eligibleRows) {
			checked++;
			if (!opts.overwrite && hasCompleteStructuredContent(row)) {
				skipped++;
				updateMaintenanceJob(db, AI_BACKFILL_JOB_KIND, {
					message: `Skipped ${skipped} already-structured memories`,
					progressCurrent: checked,
					progressTotal: total,
				});
				continue;
			}

			try {
				const prompt = buildStructuredBackfillPrompt(row);
				const response = await observer.observeStructuredJson(
					prompt.system,
					prompt.user,
					AI_BACKFILL_SCHEMA_NAME,
					AI_BACKFILL_SCHEMA,
				);
				const parsed =
					response.usedStructuredOutputs && response.parsed
						? parseStructuredBackfillResponse(JSON.stringify(response.parsed))
						: parseStructuredBackfillResponse(response.raw);

				const nextNarrative =
					row.narrative?.trim() && !opts.overwrite ? row.narrative : parsed.narrative;
				const existingFacts = parseJsonArrayOfStrings(row.facts);
				const nextFacts =
					existingFacts.length > 0 && !opts.overwrite ? existingFacts : parsed.facts;
				const existingConcepts = parseJsonArrayOfStrings(row.concepts);
				const nextConcepts =
					existingConcepts.length > 0 && !opts.overwrite ? existingConcepts : parsed.concepts;

				const changed =
					(nextNarrative ?? null) !== (row.narrative ?? null) ||
					JSON.stringify(nextFacts) !== JSON.stringify(existingFacts) ||
					JSON.stringify(nextConcepts) !== JSON.stringify(existingConcepts);

				if (!changed) {
					skipped++;
				} else {
					if (opts.dryRun && samples.length < 10) {
						samples.push({
							id: row.id,
							kind: row.kind,
							title: row.title,
							narrative: nextNarrative,
							facts: nextFacts,
							concepts: nextConcepts,
						});
					}
					if (!opts.dryRun) {
						updateStmt.run(
							nextNarrative,
							JSON.stringify(nextFacts),
							JSON.stringify(nextConcepts),
							new Date().toISOString(),
							row.id,
						);
					}
					updated++;
				}
			} catch {
				failed++;
			}

			updateMaintenanceJob(db, AI_BACKFILL_JOB_KIND, {
				message: `Processed ${checked} of ${total} memories`,
				progressCurrent: checked,
				progressTotal: total,
				metadata: {
					model: observer.getStatus().model,
					provider: observer.getStatus().provider,
					kinds,
					overwrite: opts.overwrite === true,
					updated,
					skipped,
					failed,
				},
			});
		}

		completeMaintenanceJob(db, AI_BACKFILL_JOB_KIND, {
			message: `Processed ${checked} memories: ${updated} updated, ${skipped} skipped, ${failed} failed`,
			progressCurrent: checked,
			progressTotal: total,
			metadata: {
				model: observer.getStatus().model,
				provider: observer.getStatus().provider,
				kinds,
				overwrite: opts.overwrite === true,
				updated,
				skipped,
				failed,
			},
		});
	} catch (error) {
		failMaintenanceJob(
			db,
			AI_BACKFILL_JOB_KIND,
			error instanceof Error ? error.message : String(error),
			{
				message: `Failed after ${checked} memories`,
				progressCurrent: checked,
				progressTotal: total,
			},
		);
		throw error;
	}

	return { checked, updated, skipped, failed, ...(opts.dryRun ? { samples } : {}) };
}
