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

import { toJson } from "./db.js";
import {
	budgetToolEvents,
	eventToToolEvent,
	extractAdapterEvent,
	extractToolEvents,
	projectAdapterToolEvent,
} from "./ingest-events.js";
import { isLowSignalObservation } from "./ingest-filters.js";
import { buildObserverPrompt } from "./ingest-prompts.js";
import {
	buildTranscript,
	deriveRequest,
	extractAssistantMessages,
	extractAssistantUsage,
	extractPrompts,
	firstSentence,
	isTrivialRequest,
	normalizeAdapterEvents,
} from "./ingest-transcript.js";
import type {
	IngestPayload,
	ObserverContext,
	ParsedSummary,
	SessionContext,
	ToolEvent,
} from "./ingest-types.js";
import { hasMeaningfulObservation, parseObserverResponse } from "./ingest-xml-parser.js";
import type { ObserverClient } from "./observer-client.js";
import type { MemoryStore } from "./store.js";

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

	// ------------------------------------------------------------------
	// Session creation — use store.db directly (matching MCP server pattern)
	// ------------------------------------------------------------------
	const now = new Date().toISOString();
	const project = payload.project ?? null;

	const sessionInfo = store.db
		.prepare(
			`INSERT INTO sessions (started_at, cwd, project, user, tool_version, metadata_json)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.run(
			now,
			cwd,
			project,
			process.env.USER ?? "unknown",
			"plugin-ts",
			toJson({
				source: "plugin",
				event_count: events.length,
				started_at: payload.startedAt,
				session_context: sessionContext,
			}),
		);
	const sessionId = Number(sessionInfo.lastInsertRowid);

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
		const response = await options.observer.observe(system, user);

		if (!response.raw) {
			// Surface the failure — silent memory loss is unacceptable
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
		const parsed = parseObserverResponse(response.raw);

		// ------------------------------------------------------------------
		// Filter and persist observations
		// ------------------------------------------------------------------
		if (storeTyped && hasMeaningfulObservation(parsed.observations)) {
			for (const obs of parsed.observations) {
				const kind = obs.kind.trim().toLowerCase();
				if (!ALLOWED_KINDS.has(kind)) continue;
				if (!obs.title && !obs.narrative) continue;
				if (isLowSignalObservation(obs.title) || isLowSignalObservation(obs.narrative)) {
					continue;
				}

				const filesRead = normalizePaths(obs.filesRead, cwd);
				const filesModified = normalizePaths(obs.filesModified, cwd);

				// Build body text from narrative
				const bodyParts: string[] = [];
				if (obs.narrative) bodyParts.push(obs.narrative);
				if (obs.facts.length > 0) {
					bodyParts.push(obs.facts.map((f) => `- ${f}`).join("\n"));
				}
				const bodyText = bodyParts.join("\n\n");

				store.remember(sessionId, kind, obs.title || obs.narrative, bodyText, 0.5, undefined, {
					subtitle: obs.subtitle,
					facts: obs.facts,
					concepts: obs.concepts,
					files_read: filesRead,
					files_modified: filesModified,
					prompt_number: promptNumber,
					source: "observer",
				});
			}
		}

		// ------------------------------------------------------------------
		// Persist session summary
		// ------------------------------------------------------------------
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

				// Derive meaningful request if trivial
				let request = summary.request;
				if (isTrivialRequest(request)) {
					const derived = deriveRequest(summary);
					if (derived) request = derived;
				}

				const body = summaryBody(summary);
				if (body && !isLowSignalObservation(firstSentence(body))) {
					store.remember(sessionId, "change", request || "Session summary", body, 0.3, undefined, {
						is_summary: true,
						prompt_number: promptNumber,
						files_read: summary.filesRead,
						files_modified: summary.filesModified,
						source: "observer_summary",
					});
				}
			}
		}

		// ------------------------------------------------------------------
		// Record observer usage
		// ------------------------------------------------------------------
		const usageTokenTotal = assistantUsageEvents.reduce((sum, e) => sum + (e.total_tokens ?? 0), 0);
		store.db
			.prepare(
				`INSERT INTO usage_events (session_id, event, tokens_read, tokens_written, created_at, metadata_json)
				 VALUES (?, ?, ?, ?, ?, ?)`,
			)
			.run(
				sessionId,
				"observer_call",
				response.raw.length,
				transcript.length,
				new Date().toISOString(),
				toJson({
					project,
					observation_count: parsed.observations.length,
					has_summary: parsed.summary != null,
					provider: response.provider,
					model: response.model,
					session_usage_tokens: usageTokenTotal,
				}),
			);

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
	store.db.prepare("UPDATE sessions SET ended_at = ?, metadata_json = ? WHERE id = ?").run(
		new Date().toISOString(),
		toJson({
			post: {},
			source: "plugin",
			event_count: eventCount,
			session_context: sessionContext,
		}),
		sessionId,
	);
}

// ---------------------------------------------------------------------------
// Orphan session cleanup
// ---------------------------------------------------------------------------

/**
 * Close orphan sessions (started but never ended) older than maxAgeHours.
 * Returns the number of sessions closed.
 */
export function cleanOrphanSessions(store: MemoryStore, maxAgeHours = 24): number {
	const cutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
	const result = store.db
		.prepare("UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL AND started_at < ?")
		.run(cutoff, cutoff);
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
