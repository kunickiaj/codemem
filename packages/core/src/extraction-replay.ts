import { connect, resolveDbPath } from "./db.js";
import {
	evaluateSessionExtractionItems,
	getSessionExtractionEvalScenario,
} from "./extraction-eval.js";
import { decideExtractionReplayTier } from "./extraction-tier-routing.js";
import {
	budgetToolEvents,
	eventToToolEvent,
	extractAdapterEvent,
	extractToolEvents,
	projectAdapterToolEvent,
} from "./ingest-events.js";
import { isLowSignalObservation } from "./ingest-filters.js";
import { buildObserverPrompt, truncateObserverTranscript } from "./ingest-prompts.js";
import {
	buildTranscript,
	deriveRequest,
	extractAssistantMessages,
	extractPrompts,
	firstSentence,
	isTrivialRequest,
	normalizeAdapterEvents,
} from "./ingest-transcript.js";
import type {
	ObserverContext,
	ParsedOutput,
	ParsedSummary,
	SessionContext,
	ToolEvent,
} from "./ingest-types.js";
import { parseObserverResponse } from "./ingest-xml-parser.js";
import {
	type ObserverClient,
	ObserverClient as ObserverClientImpl,
	type ObserverConfig,
} from "./observer-client.js";
import { resolveProject } from "./project.js";
import { buildSessionContext } from "./raw-event-flush.js";

const ALLOWED_KINDS = new Set([
	"bugfix",
	"feature",
	"refactor",
	"change",
	"discovery",
	"decision",
	"exploration",
]);

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

function normalizeEventsForToolExtraction(
	events: Record<string, unknown>[],
	maxChars: number,
): ToolEvent[] {
	const toolEvents: ToolEvent[] = [];
	for (const event of events) {
		const adapter = extractAdapterEvent(event);
		if (adapter) {
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
		toolEvents.push(...extractToolEvents([event], maxChars));
	}
	return toolEvents;
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
	if (
		!first.raw ||
		firstParsed.observations.length > 0 ||
		firstParsed.summary !== null ||
		firstParsed.skipSummaryReason !== null
	) {
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

export interface ExtractionReplayResult {
	scenario: { id: string; title: string; description: string };
	target: { batchId: number; sessionId: number };
	analysis: ReplayBatchAnalysis;
	classification: {
		status: "pass" | "shape_fail" | "observer_no_output";
		reason: string;
	};
	session: {
		id: number;
		project: string | null;
		cwd: string;
		startedAt: string;
		endedAt: string | null;
		sessionClass: string;
		summaryDisposition: string;
	};
	observer: {
		provider: string;
		model: string;
		tier: "simple" | "rich" | null;
		tierReasons: string[];
		openaiUseResponses: boolean;
		reasoningEffort: string | null;
		reasoningSummary: string | null;
		maxOutputTokens: number;
		temperature: number | null;
		repairApplied: boolean;
		initialRaw: string | null;
		raw: string | null;
		parsed: ParsedOutput;
	};
	observerContext: ObserverContext;
	evaluation: ReturnType<typeof evaluateSessionExtractionItems>;
}

export interface ReplayBatchAnalysis {
	batchId: number;
	sessionId: number;
	eventSpan: number;
	promptCount: number;
	toolCount: number;
	transcriptLength: number;
}

interface PreparedReplayBatch {
	scenario: ReturnType<typeof getSessionExtractionEvalScenario> extends infer T
		? Exclude<T, null>
		: never;
	batch: {
		id: number;
		source: string;
		stream_id: string;
		opencode_session_id: string;
		start_event_seq: number;
		end_event_seq: number;
		updated_at: string;
		session_id: number;
		cwd: string | null;
		project: string | null;
		started_at: string | null;
		ended_at: string | null;
		metadata_json: string | null;
	};
	sessionContext: SessionContext;
	observerContext: ObserverContext;
	system: string;
	user: string;
	sessionPost: Record<string, unknown>;
	analysis: ReplayBatchAnalysis;
}

function classifyReplayResult(input: {
	raw: string | null;
	evaluation: ReturnType<typeof evaluateSessionExtractionItems>;
}): ExtractionReplayResult["classification"] {
	if (!input.raw) {
		return {
			status: "observer_no_output",
			reason: "observer returned no raw output",
		};
	}
	if (input.evaluation.pass) {
		return {
			status: "pass",
			reason: "fresh replay output satisfies the extraction rubric",
		};
	}
	return {
		status: "shape_fail",
		reason:
			input.evaluation.failureReasons[0] ?? "fresh replay output failed the extraction rubric",
	};
}

function isRichReplayCandidate(
	observerContext: ObserverContext,
	sessionContext: SessionContext,
	scenarioThreadCount: number,
): boolean {
	const transcriptLength = observerContext.transcript.trim().length;
	return (
		(sessionContext.promptCount ?? 0) >= 2 ||
		(sessionContext.toolCount ?? 0) >= 3 ||
		transcriptLength >= 1500 ||
		scenarioThreadCount >= 3
	);
}

function buildReplayItems(
	parsed: ParsedOutput,
	batch: {
		cwd: string | null;
		updated_at: string;
		started_at: string | null;
	},
	sessionContext: SessionContext,
): Array<{
	id: number;
	kind: string;
	title: string;
	bodyText: string;
	active: boolean;
	createdAt: string;
	metadata: unknown;
}> {
	const replayItems = [] as Array<{
		id: number;
		kind: string;
		title: string;
		bodyText: string;
		active: boolean;
		createdAt: string;
		metadata: unknown;
	}>;
	let syntheticId = 1;
	for (const obs of parsed.observations) {
		const kind = obs.kind.trim().toLowerCase();
		if (!kind || (!obs.title && !obs.narrative)) continue;
		if (!ALLOWED_KINDS.has(kind)) continue;
		if (isLowSignalObservation(obs.title) || isLowSignalObservation(obs.narrative)) continue;
		const bodyParts: string[] = [];
		if (obs.narrative) bodyParts.push(obs.narrative);
		if (obs.facts.length > 0) bodyParts.push(obs.facts.map((f) => `- ${f}`).join("\n"));
		replayItems.push({
			id: syntheticId++,
			kind,
			title: obs.title || obs.narrative,
			bodyText: bodyParts.join("\n\n"),
			active: true,
			createdAt: batch.updated_at ?? batch.started_at ?? new Date().toISOString(),
			metadata: {
				source: "observer",
				files_read: normalizePaths(obs.filesRead, batch.cwd),
				files_modified: normalizePaths(obs.filesModified, batch.cwd),
				flush_batch: sessionContext.flushBatch,
			},
		});
	}
	if (parsed.summary && !parsed.skipSummaryReason) {
		const summary = parsed.summary;
		summary.filesRead = normalizePaths(summary.filesRead, batch.cwd);
		summary.filesModified = normalizePaths(summary.filesModified, batch.cwd);
		let request = summary.request;
		if (isTrivialRequest(request)) {
			const derived = deriveRequest(summary);
			if (derived) request = derived;
		}
		const body = summaryBody(summary);
		if (body && !isLowSignalObservation(firstSentence(body))) {
			replayItems.push({
				id: syntheticId++,
				kind: "session_summary",
				title: request || "Session summary",
				bodyText: body,
				active: true,
				createdAt: batch.updated_at ?? batch.started_at ?? new Date().toISOString(),
				metadata: {
					is_summary: true,
					source: "observer_summary",
					flush_batch: sessionContext.flushBatch,
				},
			});
		}
	}
	return replayItems;
}

function needsRichSessionRepair(
	evaluation: ReturnType<typeof evaluateSessionExtractionItems>,
	observerContext: ObserverContext,
	sessionContext: SessionContext,
): boolean {
	if (!isRichReplayCandidate(observerContext, sessionContext, evaluation.threads.length))
		return false;
	if (evaluation.counts.observations === 0 && evaluation.counts.summaries >= 1) return true;
	return evaluation.counts.observations < 2;
}

async function observeRichSessionRepair(
	observer: ObserverClient,
	baseSystem: string,
	baseUser: string,
	initialRaw: string,
	evaluation: ReturnType<typeof evaluateSessionExtractionItems>,
): Promise<{ raw: string | null; parsed: ParsedOutput; provider: string; model: string }> {
	const missingThreads = evaluation.threads
		.filter((thread) => !thread.observationMatch)
		.map((thread) => thread.title);
	const repairSystem = `${baseSystem}

RICH-SESSION REPAIR REQUIREMENT:
- The previous output under-extracted a rich batch.
- For a rich session, summary-only output is not acceptable when multiple durable subthreads are present.
- Return valid XML with one broad <summary> plus at least 2 durable <observation> blocks covering DISTINCT subthreads.
- Do not repeat the same dominant thread in multiple observations.
- Choose observations for reusable decisions, learnings, troubleshooting outcomes, or future-facing exploration that would reduce rediscovery in later sessions.`;
	const repairUser = `${baseUser}

Previous under-extracted XML to repair:
${initialRaw}

The previous output failed because:
- observations returned: ${evaluation.counts.observations}
- total thread coverage: ${evaluation.coverage.totalThreadCoverage}
- missing observation coverage for: ${missingThreads.length > 0 ? missingThreads.join(", ") : "none recorded"}

Rewrite the analysis as valid XML only.
Keep the broad summary, but add 2-4 durable observations for distinct subthreads if the transcript supports them.`;
	return observeStructuredOutput(observer, repairSystem, repairUser);
}

async function prepareReplayBatch(
	dbPath: string | undefined,
	opts: {
		batchId: number;
		scenarioId: string;
		maxChars?: number;
		observerMaxChars?: number;
		transcriptBudget?: number;
	},
): Promise<PreparedReplayBatch> {
	const scenario = getSessionExtractionEvalScenario(opts.scenarioId);
	if (!scenario) throw new Error(`Unknown extraction eval scenario: ${opts.scenarioId}`);

	const db = connect(resolveDbPath(dbPath));
	try {
		const batch = db
			.prepare(
				`SELECT
					b.id,
					b.source,
					b.stream_id,
					b.opencode_session_id,
					b.start_event_seq,
					b.end_event_seq,
					b.updated_at,
					os.session_id,
					s.cwd,
					s.project,
					s.started_at,
					s.ended_at,
					s.metadata_json
				 FROM raw_event_flush_batches b
				 LEFT JOIN opencode_sessions os
				   ON os.source = b.source AND os.stream_id = b.stream_id
				 LEFT JOIN sessions s ON s.id = os.session_id
				 WHERE b.id = ?`,
			)
			.get(opts.batchId) as
			| {
					id: number;
					source: string;
					stream_id: string;
					opencode_session_id: string;
					start_event_seq: number;
					end_event_seq: number;
					updated_at: string;
					session_id: number | null;
					cwd: string | null;
					project: string | null;
					started_at: string | null;
					ended_at: string | null;
					metadata_json: string | null;
			  }
			| undefined;
		if (!batch) throw new Error(`Flush batch ${opts.batchId} not found`);
		if (batch.session_id == null) {
			throw new Error(`Flush batch ${opts.batchId} is not linked to a local session`);
		}

		const rawRows = db
			.prepare(
				`SELECT event_seq, event_type, ts_wall_ms, ts_mono_ms, payload_json, event_id
				 FROM raw_events
				 WHERE source = ?
				   AND stream_id = ?
				   AND event_seq >= ?
				   AND event_seq <= ?
				 ORDER BY event_seq ASC`,
			)
			.all(batch.source, batch.stream_id, batch.start_event_seq, batch.end_event_seq) as Array<{
			event_seq: number;
			event_type: string;
			ts_wall_ms: number | null;
			ts_mono_ms: number | null;
			payload_json: string;
			event_id: string | null;
		}>;
		const events = rawRows.map<Record<string, unknown>>((row) => {
			const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
			payload.type = payload.type || row.event_type;
			payload.timestamp_wall_ms = row.ts_wall_ms;
			payload.timestamp_mono_ms = row.ts_mono_ms;
			payload.event_seq = row.event_seq;
			payload.event_id = row.event_id;
			return payload;
		});
		if (events.length === 0) {
			throw new Error(`Flush batch ${opts.batchId} has no raw events in range`);
		}

		const sessionContext: SessionContext = buildSessionContext(events);
		sessionContext.opencodeSessionId = batch.opencode_session_id;
		sessionContext.source = batch.source;
		sessionContext.streamId = batch.stream_id;
		sessionContext.flusher = "raw_events";
		sessionContext.flushBatch = {
			batch_id: batch.id,
			start_event_seq: batch.start_event_seq,
			end_event_seq: batch.end_event_seq,
		};

		const maxChars = opts.maxChars ?? 12_000;
		const observerMaxChars = opts.observerMaxChars ?? 12_000;
		const normalizedEvents = normalizeAdapterEvents(events);
		const prompts = extractPrompts(normalizedEvents);
		const promptNumber =
			prompts.length > 0 ? (prompts[prompts.length - 1]?.promptNumber ?? prompts.length) : null;
		let toolEvents = normalizeEventsForToolExtraction(events, maxChars);
		const toolBudget = Math.max(2000, Math.min(8000, observerMaxChars - 5000));
		toolEvents = budgetToolEvents(toolEvents, toolBudget, 30);
		const assistantMessages = extractAssistantMessages(normalizedEvents);
		const lastAssistantMessage = assistantMessages.at(-1) ?? null;
		const latestPrompt =
			sessionContext.firstPrompt ??
			(prompts.length > 0 ? prompts[prompts.length - 1]?.promptText : null) ??
			null;

		let shouldProcess =
			toolEvents.length > 0 || Boolean(latestPrompt) || Boolean(lastAssistantMessage);
		if (
			latestPrompt &&
			isTrivialRequest(latestPrompt) &&
			toolEvents.length === 0 &&
			!lastAssistantMessage
		) {
			shouldProcess = false;
		}
		if (!shouldProcess) {
			throw new Error(`Flush batch ${opts.batchId} has no meaningful observer input to replay`);
		}

		const transcript = buildTranscript(normalizedEvents);
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
		const transcriptBudget =
			opts.transcriptBudget ?? Math.max(1500, Math.min(5000, Math.floor(observerMaxChars * 0.4)));
		const observerContext: ObserverContext = {
			project: batch.project ?? resolveProject(batch.cwd ?? process.cwd()) ?? null,
			userPrompt: observerPrompt,
			promptNumber,
			transcript: truncateObserverTranscript(transcript, transcriptBudget),
			toolEvents,
			lastAssistantMessage,
			includeSummary: true,
			diffSummary: "",
			recentFiles: "",
		};
		const { system, user } = buildObserverPrompt(observerContext);
		const sessionMeta = (() => {
			try {
				return batch.metadata_json
					? (JSON.parse(batch.metadata_json) as Record<string, unknown>)
					: {};
			} catch {
				return {};
			}
		})();
		const post =
			sessionMeta.post && typeof sessionMeta.post === "object" && !Array.isArray(sessionMeta.post)
				? (sessionMeta.post as Record<string, unknown>)
				: {};
		return {
			scenario,
			batch: {
				...batch,
				session_id: batch.session_id,
			},
			sessionContext,
			observerContext,
			system,
			user,
			sessionPost: post,
			analysis: {
				batchId: batch.id,
				sessionId: batch.session_id,
				eventSpan: batch.end_event_seq - batch.start_event_seq + 1,
				promptCount: sessionContext.promptCount ?? 0,
				toolCount: sessionContext.toolCount ?? 0,
				transcriptLength: transcript.length,
			},
		};
	} finally {
		db.close();
	}
}

async function replayPreparedBatch(
	prepared: PreparedReplayBatch,
	observer: ObserverClient,
	tier: "simple" | "rich" | null,
	tierReasons: string[],
): Promise<ExtractionReplayResult> {
	const initialResponse = await observeStructuredOutput(observer, prepared.system, prepared.user);
	let finalResponse = initialResponse;
	let replayItems = buildReplayItems(finalResponse.parsed, prepared.batch, prepared.sessionContext);
	let evaluation = evaluateSessionExtractionItems(
		{ type: "batch", sessionId: prepared.batch.session_id, batchId: prepared.batch.id },
		{
			id: prepared.batch.session_id,
			project: prepared.batch.project,
			cwd: prepared.batch.cwd ?? process.cwd(),
			startedAt: prepared.batch.started_at ?? "",
			endedAt: prepared.batch.ended_at,
			sessionClass: String(prepared.sessionPost.session_class ?? "unknown"),
			summaryDisposition: String(prepared.sessionPost.summary_disposition ?? "unknown"),
		},
		replayItems,
		prepared.scenario,
	);
	let repairApplied = false;
	if (
		initialResponse.raw &&
		needsRichSessionRepair(evaluation, prepared.observerContext, prepared.sessionContext)
	) {
		repairApplied = true;
		finalResponse = await observeRichSessionRepair(
			observer,
			prepared.system,
			prepared.user,
			initialResponse.raw,
			evaluation,
		);
		replayItems = buildReplayItems(finalResponse.parsed, prepared.batch, prepared.sessionContext);
		evaluation = evaluateSessionExtractionItems(
			{ type: "batch", sessionId: prepared.batch.session_id, batchId: prepared.batch.id },
			{
				id: prepared.batch.session_id,
				project: prepared.batch.project,
				cwd: prepared.batch.cwd ?? process.cwd(),
				startedAt: prepared.batch.started_at ?? "",
				endedAt: prepared.batch.ended_at,
				sessionClass: String(prepared.sessionPost.session_class ?? "unknown"),
				summaryDisposition: String(prepared.sessionPost.summary_disposition ?? "unknown"),
			},
			replayItems,
			prepared.scenario,
		);
	}

	return {
		scenario: {
			id: prepared.scenario.id,
			title: prepared.scenario.title,
			description: prepared.scenario.description,
		},
		target: { batchId: prepared.batch.id, sessionId: prepared.batch.session_id },
		analysis: prepared.analysis,
		classification: classifyReplayResult({
			raw: finalResponse.raw,
			evaluation,
		}),
		session: evaluation.session,
		observer: {
			provider: finalResponse.provider,
			model: finalResponse.model,
			tier,
			tierReasons,
			openaiUseResponses: observer.openaiUseResponses,
			reasoningEffort: observer.reasoningEffort,
			reasoningSummary: observer.reasoningSummary,
			maxOutputTokens: observer.maxOutputTokens,
			temperature: observer.temperature,
			repairApplied,
			initialRaw: initialResponse.raw,
			raw: finalResponse.raw,
			parsed: finalResponse.parsed,
		},
		observerContext: prepared.observerContext,
		evaluation,
	};
}

export async function replayBatchExtraction(
	dbPath: string | undefined,
	observer: ObserverClient,
	opts: {
		batchId: number;
		scenarioId: string;
		maxChars?: number;
		observerMaxChars?: number;
		transcriptBudget?: number;
	},
): Promise<ExtractionReplayResult> {
	const prepared = await prepareReplayBatch(dbPath, {
		...opts,
		observerMaxChars: opts.observerMaxChars ?? observer.maxChars,
	});
	return replayPreparedBatch(prepared, observer, null, []);
}

export async function replayBatchExtractionWithTierRouting(
	dbPath: string | undefined,
	baseConfig: ObserverConfig,
	opts: {
		batchId: number;
		scenarioId: string;
		maxChars?: number;
		observerMaxChars?: number;
		transcriptBudget?: number;
	},
): Promise<ExtractionReplayResult> {
	const baseObserver = new ObserverClientImpl(baseConfig);
	const prepared = await prepareReplayBatch(dbPath, {
		...opts,
		observerMaxChars: opts.observerMaxChars ?? baseObserver.maxChars,
	});
	const decision = decideExtractionReplayTier(prepared.analysis);
	const observer = new ObserverClientImpl({
		...baseConfig,
		...decision.observer,
	});
	return replayPreparedBatch(prepared, observer, decision.tier, decision.reasons);
}
