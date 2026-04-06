/**
 * Main ingest pipeline — processes raw coding session events, calls the
 * observer LLM, and stores extracted memories.
 *
 * Ports the `ingest()` function from codemem/plugin_ingest.py.
 *
 * Pipeline stages:
 * 1. Extract session context, events, cwd
 * 2. Create/find session in store
 * 3. Extract prompts, tool events, assistant messages
 * 4. Build transcript
 * 5. Budget tool events
 * 6. Build observer context + prompt
 * 7. Call observer LLM via ObserverClient.observe()
 * 8. Parse XML response
 * 9. Filter low-signal observations
 * 10. Persist observations as memories
 * 11. Persist session summary
 * 12. End session
 */

import { and, isNull, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { normalizeProjectLabel } from "./claude-hooks.js";
import { toJson } from "./db.js";
import {
	budgetToolEvents,
	eventToToolEvent,
	extractAdapterEvent,
	extractToolEvents,
	projectAdapterToolEvent,
} from "./ingest-events.js";
import { isLowSignalObservation, isLowSignalSummary } from "./ingest-filters.js";
import { buildObserverPrompt } from "./ingest-prompts.js";
import {
	buildTranscript,
	deriveRequest,
	extractAssistantMessages,
	extractAssistantUsage,
	extractPrompts,
	isTrivialRequest,
	normalizeAdapterEvents,
} from "./ingest-transcript.js";
import type {
	IngestPayload,
	ObserverContext,
	ParsedOutput,
	ParsedSummary,
	SessionContext,
	ToolEvent,
} from "./ingest-types.js";
import { hasMeaningfulObservation, parseObserverResponse } from "./ingest-xml-parser.js";
import type { ObserverClient } from "./observer-client.js";
import { resolveProject } from "./project.js";
import * as schema from "./schema.js";
import type { MemoryStore } from "./store.js";
import { deriveTags } from "./tags.js";
import { storeVectors } from "./vectors.js";

// ---------------------------------------------------------------------------
// Allowed memory kinds (matches Python)
// ---------------------------------------------------------------------------

const ALLOWED_KINDS = new Set([
	"bugfix",
	"feature",
	"refactor",
	"change",
	"discovery",
	"decision",
	"exploration",
]);

// ---------------------------------------------------------------------------
// Path normalization
// ---------------------------------------------------------------------------

function normalizePath(path: string, repoRoot: string | null): string {
	if (!path) return "";
	const cleaned = path.trim();
	if (!repoRoot) return cleaned;
	const root = repoRoot.replace(/\/+$/, "");
	if (cleaned === root) return ".";
	if (cleaned.startsWith(`${root}/`)) return cleaned.slice(root.length + 1);
	return cleaned;
}

function normalizePaths(paths: string[], repoRoot: string | null): string[] {
	return paths.map((p) => normalizePath(p, repoRoot)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Summary body formatting
// ---------------------------------------------------------------------------

function summaryBody(summary: ParsedSummary): string {
	const sections: [string, string][] = [
		["Request", summary.request],
		["Completed", summary.completed],
		["Learned", summary.learned],
		["Investigated", summary.investigated],
		["Next steps", summary.nextSteps],
		["Notes", summary.notes],
	];
	return sections
		.filter(([, value]) => value)
		.map(([label, value]) => `## ${label}\n${value}`)
		.join("\n\n");
}

function summaryHasMeaningfulSignal(args: {
	summary: ParsedSummary;
	body: string;
	observationsCount: number;
	sessionContext: SessionContext | null;
}): boolean {
	const { summary, body, observationsCount, sessionContext } = args;
	if (!body) {
		return false;
	}
	if (observationsCount > 0) return true;
	if ((summary.filesModified?.length ?? 0) > 0) return true;
	if ((summary.filesRead?.length ?? 0) > 0) return true;

	const substantiveSections = [
		summary.completed,
		summary.learned,
		summary.investigated,
		summary.nextSteps,
		summary.notes,
	].filter((value) => value && value.trim().length >= 40);
	if (substantiveSections.length >= 2) return true;

	const promptCount = sessionContext?.promptCount ?? 0;
	const toolCount = sessionContext?.toolCount ?? 0;
	const durationMs = sessionContext?.durationMs ?? 0;
	if (promptCount <= 1 && toolCount <= 1 && durationMs < 2 * 60_000) {
		return !isLowSignalSummary(body) && substantiveSections.length >= 1;
	}

	return !isLowSignalSummary(body) && substantiveSections.length >= 1;
}

// ---------------------------------------------------------------------------
// Event normalization (adapter projection)
// ---------------------------------------------------------------------------

/**
 * Convert raw events with adapter envelopes into normalized flat events.
 * Handles both tool events (via adapter projection) and transcript events
 * (via normalizeAdapterEvents).
 */
function normalizeEventsForToolExtraction(
	events: Record<string, unknown>[],
	maxChars: number,
): ToolEvent[] {
	const toolEvents: ToolEvent[] = [];
	for (const event of events) {
		const adapter = extractAdapterEvent(event);
		if (adapter) {
			// Skip tool_call events (only tool_result matters)
			if (adapter.event_type === "tool_call") continue;
			const projected = projectAdapterToolEvent(adapter, event);
			if (projected) {
				const te = eventToToolEvent(projected, maxChars);
				if (te) {
					toolEvents.push(te);
					continue;
				}
			}
		}
		// Direct (non-adapter) events
		const directEvents = extractToolEvents([event], maxChars);
		toolEvents.push(...directEvents);
	}
	return toolEvents;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export interface IngestOptions {
	/** Observer LLM client. */
	observer: ObserverClient;
	/** Maximum chars per tool event payload (from config). Default 12000. */
	maxChars?: number;
	/** Maximum chars for observer total budget. Default 12000. */
	observerMaxChars?: number;
	/** Whether to store summaries. Default true. */
	storeSummary?: boolean;
	/** Whether to store typed observations. Default true. */
	storeTyped?: boolean;
}

function hasStructuredObserverOutput(parsed: ParsedOutput): boolean {
	return (
		parsed.observations.length > 0 || parsed.summary !== null || parsed.skipSummaryReason !== null
	);
}

async function observeStructuredOutput(
	observer: ObserverClient,
	system: string,
	user: string,
): Promise<{ raw: string | null; parsed: ParsedOutput; provider: string; model: string }> {
	const first = await observer.observe(system, user);
	const firstParsed = first.raw
		? parseObserverResponse(first.raw)
		: { observations: [], summary: null, skipSummaryReason: null };
	if (!first.raw || hasStructuredObserverOutput(firstParsed)) {
		return {
			raw: first.raw,
			parsed: firstParsed,
			provider: first.provider,
			model: first.model,
		};
	}

	const repairSystem = `${system}\n\nYour previous reply was invalid because it did not follow the required XML-only schema. Rewrite the same analysis as valid XML only. Do not include prose outside XML.`;
	const repairUser = `${user}\n\nPrevious invalid response to rewrite as valid XML:\n${first.raw}`;
	const repaired = await observer.observe(repairSystem, repairUser);
	const repairedParsed = repaired.raw
		? parseObserverResponse(repaired.raw)
		: { observations: [], summary: null, skipSummaryReason: null };
	return {
		raw: repaired.raw,
		parsed: repairedParsed,
		provider: repaired.provider,
		model: repaired.model,
	};
}

/**
 * Process a batch of raw coding session events through the full ingest pipeline.
 *
 * Extracts prompts, tool events, and assistant messages from the payload,
 * builds a transcript, calls the observer LLM, parses the response,
 * filters low-signal content, and persists observations + summary.
 */
export async function ingest(
	payload: IngestPayload,
	store: MemoryStore,
	options: IngestOptions,
): Promise<void> {
	const cwd = payload.cwd ?? process.cwd();
	const events = payload.events ?? [];
	if (!Array.isArray(events) || events.length === 0) return;

	const sessionContext = payload.sessionContext ?? {};
	const storeSummary = options.storeSummary ?? true;
	const storeTyped = options.storeTyped ?? true;
	const maxChars = options.maxChars ?? 12_000;
	const observerMaxChars = options.observerMaxChars ?? 12_000;

	const d = drizzle(store.db, { schema });
	const now = new Date().toISOString();
	const project = normalizeProjectLabel(payload.project) ?? resolveProject(cwd) ?? null;

	const sessionMetadata = {
		source: "plugin",
		event_count: events.length,
		started_at: payload.startedAt,
		session_context: sessionContext,
	};
	const sessionId =
		sessionContext.flusher === "raw_events" && sessionContext.opencodeSessionId
			? store.getOrCreateSessionForOpencodeSession({
					opencodeSessionId: sessionContext.opencodeSessionId,
					source: sessionContext.source,
					cwd,
					project,
					metadata: sessionMetadata,
					startedAt: payload.startedAt ?? now,
					toolVersion: "raw_events",
				})
			: (() => {
					const rows = d
						.insert(schema.sessions)
						.values({
							started_at: now,
							cwd,
							project,
							user: process.env.USER ?? "unknown",
							tool_version: "plugin-ts",
							metadata_json: toJson(sessionMetadata),
						})
						.returning({ id: schema.sessions.id })
						.all();
					const id = rows[0]?.id;
					if (id == null) throw new Error("session insert returned no id");
					return id;
				})();

	try {
		// ------------------------------------------------------------------
		// Extract data from events
		// ------------------------------------------------------------------
		const normalizedEvents = normalizeAdapterEvents(events);
		const prompts = extractPrompts(normalizedEvents);
		const promptNumber =
			prompts.length > 0 ? (prompts[prompts.length - 1]?.promptNumber ?? prompts.length) : null;

		// Tool events — handle adapter projection
		let toolEvents = normalizeEventsForToolExtraction(events, maxChars);

		// Budget tool events
		const toolBudget = Math.max(2000, Math.min(8000, observerMaxChars - 5000));
		toolEvents = budgetToolEvents(toolEvents, toolBudget, 30);

		// Assistant messages
		const assistantMessages = extractAssistantMessages(normalizedEvents);
		const assistantUsageEvents = extractAssistantUsage(normalizedEvents);
		const lastAssistantMessage = assistantMessages.at(-1) ?? null;

		// Latest prompt
		const latestPrompt =
			sessionContext.firstPrompt ??
			(prompts.length > 0 ? prompts[prompts.length - 1]?.promptText : null) ??
			null;

		// ------------------------------------------------------------------
		// Should we process?
		// ------------------------------------------------------------------
		let shouldProcess =
			toolEvents.length > 0 ||
			Boolean(latestPrompt) ||
			(storeSummary && Boolean(lastAssistantMessage));

		if (
			latestPrompt &&
			isTrivialRequest(latestPrompt) &&
			toolEvents.length === 0 &&
			!lastAssistantMessage
		) {
			shouldProcess = false;
		}

		if (!shouldProcess) {
			endSession(store, sessionId, events.length, sessionContext);
			return;
		}

		// ------------------------------------------------------------------
		// Build transcript
		// ------------------------------------------------------------------
		const transcript = buildTranscript(normalizedEvents);

		// ------------------------------------------------------------------
		// Build observer prompt
		// ------------------------------------------------------------------
		const sessionSummaryParts: string[] = [];
		if ((sessionContext.promptCount ?? 0) > 1) {
			sessionSummaryParts.push(`Session had ${sessionContext.promptCount} prompts`);
		}
		if ((sessionContext.toolCount ?? 0) > 0) {
			sessionSummaryParts.push(`${sessionContext.toolCount} tool executions`);
		}
		if ((sessionContext.durationMs ?? 0) > 0) {
			const durationMin = (sessionContext.durationMs ?? 0) / 60000;
			sessionSummaryParts.push(`~${durationMin.toFixed(1)} minutes of work`);
		}
		if (sessionContext.filesModified?.length) {
			sessionSummaryParts.push(`Modified: ${sessionContext.filesModified.slice(0, 5).join(", ")}`);
		}
		if (sessionContext.filesRead?.length) {
			sessionSummaryParts.push(`Read: ${sessionContext.filesRead.slice(0, 5).join(", ")}`);
		}
		const sessionInfoText = sessionSummaryParts.join("; ");

		let observerPrompt = latestPrompt ?? "";
		if (sessionInfoText) {
			observerPrompt = observerPrompt
				? `${observerPrompt}\n\n[Session context: ${sessionInfoText}]`
				: `[Session context: ${sessionInfoText}]`;
		}

		const observerContext: ObserverContext = {
			project,
			userPrompt: observerPrompt,
			promptNumber,
			toolEvents,
			lastAssistantMessage: storeSummary ? lastAssistantMessage : null,
			includeSummary: storeSummary,
			diffSummary: "",
			recentFiles: "",
		};

		const { system, user } = buildObserverPrompt(observerContext);

		// ------------------------------------------------------------------
		// Call observer LLM
		// ------------------------------------------------------------------
		const response = await observeStructuredOutput(options.observer, system, user);

		if (!response.raw) {
			// Raw-event flushes must be lossless: if the observer returns no output,
			// fail the flush so we do NOT advance last_flushed_event_seq.
			if (sessionContext?.flusher === "raw_events") {
				throw new Error("observer failed during raw-event flush");
			}

			// Surface the failure for normal ingest paths.
			const status = options.observer.getStatus();
			console.warn(
				`[codemem] Observer returned no output (provider=${response.provider}, model=${response.model}` +
					`${status.lastError ? `, error=${status.lastError}` : ""}). No memories will be created for this session.`,
			);
			endSession(store, sessionId, events.length, sessionContext);
			return;
		}

		// ------------------------------------------------------------------
		// Parse response
		// ------------------------------------------------------------------
		const rawText = response.raw;
		const parsed = response.parsed;

		const observationsToStore: typeof parsed.observations = [];
		if (storeTyped && hasMeaningfulObservation(parsed.observations)) {
			for (const obs of parsed.observations) {
				const kind = obs.kind.trim().toLowerCase();
				if (!ALLOWED_KINDS.has(kind)) continue;
				if (!obs.title && !obs.narrative) continue;
				if (isLowSignalObservation(obs.title) || isLowSignalObservation(obs.narrative)) {
					continue;
				}

				obs.filesRead = normalizePaths(obs.filesRead, cwd);
				obs.filesModified = normalizePaths(obs.filesModified, cwd);
				observationsToStore.push(obs);
			}
		}

		let summaryToStore: { summary: ParsedSummary; request: string; body: string } | null = null;
		if (storeSummary && parsed.summary && !parsed.skipSummaryReason) {
			const summary = parsed.summary;
			if (
				summary.request ||
				summary.investigated ||
				summary.learned ||
				summary.completed ||
				summary.nextSteps ||
				summary.notes
			) {
				summary.filesRead = normalizePaths(summary.filesRead, cwd);
				summary.filesModified = normalizePaths(summary.filesModified, cwd);

				let request = summary.request;
				if (isTrivialRequest(request)) {
					const derived = deriveRequest(summary);
					if (derived) request = derived;
				}

				const body = summaryBody(summary);
				if (
					summaryHasMeaningfulSignal({
						summary,
						body,
						observationsCount: observationsToStore.length,
						sessionContext,
					})
				) {
					summaryToStore = { summary, request, body };
				}
			}
		}

		if (sessionContext?.flusher === "raw_events") {
			const storableCount = observationsToStore.length + (summaryToStore ? 1 : 0);
			if (storableCount === 0) {
				const pureLowSignalSkip =
					parsed.skipSummaryReason?.trim().toLowerCase() === "low-signal" &&
					parsed.observations.length === 0 &&
					parsed.summary === null;
				if (pureLowSignalSkip) {
					endSession(store, sessionId, events.length, sessionContext);
					return;
				}
				throw new Error("observer produced no storable output for raw-event flush");
			}
		}

		const vectorWriteInputs: Array<{ memoryId: number; title: string; bodyText: string }> = [];

		// Persist all observations, summary, and usage atomically
		store.db.transaction(() => {
			// ------------------------------------------------------------------
			// Filter and persist observations
			// ------------------------------------------------------------------
			for (const obs of observationsToStore) {
				const kind = obs.kind.trim().toLowerCase();

				const bodyParts: string[] = [];
				if (obs.narrative) bodyParts.push(obs.narrative);
				if (obs.facts.length > 0) {
					bodyParts.push(obs.facts.map((f) => `- ${f}`).join("\n"));
				}
				const bodyText = bodyParts.join("\n\n");

				const memoryTitle = obs.title || obs.narrative;
				const tags = deriveTags({
					kind,
					title: memoryTitle,
					concepts: obs.concepts,
					filesRead: obs.filesRead,
					filesModified: obs.filesModified,
				});
				const memoryId = store.remember(sessionId, kind, memoryTitle, bodyText, 0.5, tags, {
					subtitle: obs.subtitle,
					facts: obs.facts,
					concepts: obs.concepts,
					files_read: obs.filesRead,
					files_modified: obs.filesModified,
					prompt_number: promptNumber,
					source: "observer",
				});
				vectorWriteInputs.push({ memoryId, title: memoryTitle, bodyText });
			}

			// ------------------------------------------------------------------
			// Persist session summary
			// ------------------------------------------------------------------
			if (summaryToStore) {
				const { summary, request, body } = summaryToStore;
				const summaryTitle = request || "Session summary";
				const summaryTags = deriveTags({
					kind: "session_summary",
					title: summaryTitle,
					filesRead: summary.filesRead,
					filesModified: summary.filesModified,
				});
				const memoryId = store.remember(
					sessionId,
					"session_summary",
					summaryTitle,
					body,
					0.3,
					summaryTags,
					{
						is_summary: true,
						request,
						investigated: summary.investigated,
						learned: summary.learned,
						completed: summary.completed,
						next_steps: summary.nextSteps,
						notes: summary.notes,
						prompt_number: promptNumber,
						files_read: summary.filesRead,
						files_modified: summary.filesModified,
						source: "observer_summary",
					},
				);
				vectorWriteInputs.push({ memoryId, title: summaryTitle, bodyText: body });
			}

			// ------------------------------------------------------------------
			// Record observer usage
			// ------------------------------------------------------------------
			const usageTokenTotal = assistantUsageEvents.reduce(
				(sum, e) => sum + (e.total_tokens ?? 0),
				0,
			);
			d.insert(schema.usageEvents)
				.values({
					session_id: sessionId,
					event: "observer_call",
					tokens_read: rawText.length,
					tokens_written: transcript.length,
					created_at: new Date().toISOString(),
					metadata_json: toJson({
						project,
						observation_count: observationsToStore.length,
						has_summary: summaryToStore != null,
						provider: response.provider,
						model: response.model,
						session_usage_tokens: usageTokenTotal,
					}),
				})
				.run();
		})();

		for (const input of vectorWriteInputs) {
			try {
				await storeVectors(store.db, input.memoryId, input.title, input.bodyText);
			} catch {
				// Non-fatal — ingestion should not fail when embeddings are unavailable
			}
		}

		// ------------------------------------------------------------------
		// End session
		// ------------------------------------------------------------------
		endSession(store, sessionId, events.length, sessionContext);
	} catch (err) {
		// End session even on error
		try {
			endSession(store, sessionId, events.length, sessionContext);
		} catch {
			// ignore cleanup errors
		}
		throw err;
	}
}

// ---------------------------------------------------------------------------
// Session lifecycle helpers
// ---------------------------------------------------------------------------

function endSession(
	store: MemoryStore,
	sessionId: number,
	eventCount: number,
	sessionContext: SessionContext,
): void {
	// Use store.endSession() which merges metadata instead of replacing it,
	// preserving fields set during session creation (startedAt, session_context, etc.)
	store.endSession(sessionId, {
		post: {},
		source: "plugin",
		event_count: eventCount,
		session_context: sessionContext,
	});
}

// ---------------------------------------------------------------------------
// Orphan session cleanup
// ---------------------------------------------------------------------------

/**
 * Close orphan sessions (started but never ended) older than maxAgeHours.
 * Returns the number of sessions closed.
 */
export function cleanOrphanSessions(store: MemoryStore, maxAgeHours = 24): number {
	const d = drizzle(store.db, { schema });
	const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
	const result = d
		.update(schema.sessions)
		.set({ ended_at: cutoff })
		.where(and(isNull(schema.sessions.ended_at), lt(schema.sessions.started_at, cutoff)))
		.run();
	return result.changes;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * Read a JSON payload from stdin and run the ingest pipeline.
 *
 * This is the TypeScript equivalent of `codemem ingest` — receives events
 * from the plugin and processes them through the observer LLM.
 */
export async function main(store: MemoryStore, observer: ObserverClient): Promise<void> {
	const chunks: string[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(String(chunk));
	}
	const raw = chunks.join("");
	if (!raw.trim()) return;

	let payload: IngestPayload;
	try {
		payload = JSON.parse(raw) as IngestPayload;
	} catch (err) {
		throw new Error(`codemem: invalid payload: ${err}`);
	}

	await ingest(payload, store, { observer });
}
