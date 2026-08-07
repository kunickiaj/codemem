import { connect, resolveDbPath } from "./db.js";
import {
	evaluateExtractionStructure,
	evaluateSessionExtractionItems,
	getSessionExtractionEvalScenario,
} from "./extraction-eval.js";
import {
	buildTieredObserverConfig,
	decideExtractionReplayTier,
	type ExtractionReplayTierRoutingInput,
} from "./extraction-tier-routing.js";
import {
	budgetToolEvents,
	eventToToolEvent,
	extractAdapterEvent,
	extractToolEvents,
	projectAdapterToolEvent,
} from "./ingest-events.js";
import { isLowSignalObservation } from "./ingest-filters.js";
import {
	buildObserverPrompt,
	buildObserverRepairPrompt,
	truncateObserverTranscript,
} from "./ingest-prompts.js";
import {
	buildTranscript,
	deriveRequest,
	extractAssistantMessages,
	extractPrompts,
	firstSentence,
	isTrivialRequest,
	normalizeAdapterEvents,
	normalizeEventsForSessionContext,
} from "./ingest-transcript.js";
import type {
	ObserverContext,
	ParsedOutput,
	ParsedSummary,
	SessionContext,
	ToolEvent,
} from "./ingest-types.js";
import {
	parseObserverResponse,
	SUPPORTED_OBSERVATION_KINDS,
	shouldPreferRepairedObserverResponse,
	shouldRepairObserverResponse,
} from "./ingest-xml-parser.js";
import {
	type ObserverClient,
	ObserverClient as ObserverClientImpl,
	type ObserverConfig,
	type ObserverStatus,
	type ObserverTokenUsage,
} from "./observer-client.js";
import { resolveProject } from "./project.js";
import { buildSessionContext } from "./raw-event-flush.js";

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

function snapshotObserverStatus(observer: ObserverClient): ObserverStatus {
	const status = observer.getStatus();
	return {
		...status,
		auth: { ...status.auth },
		...(status.lastError ? { lastError: { ...status.lastError } } : {}),
	};
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
): Promise<{
	initial: {
		raw: string | null;
		parsed: ParsedOutput;
		provider: string;
		model: string;
		elapsedMs: number | null;
		usage: ObserverTokenUsage | null;
		status: ObserverStatus;
	};
	repaired: {
		raw: string | null;
		parsed: ParsedOutput;
		provider: string;
		model: string;
		elapsedMs: number | null;
		usage: ObserverTokenUsage | null;
		status: ObserverStatus;
	} | null;
}> {
	const first = await observer.observe(system, user);
	const firstParsed = first.raw
		? parseObserverResponse(first.raw)
		: { observations: [], summary: null, skipSummaryReason: null };
	const initial = {
		raw: first.raw,
		parsed: firstParsed,
		provider: first.provider,
		model: first.model,
		elapsedMs: first.elapsedMs ?? null,
		usage: first.usage ?? null,
		status: snapshotObserverStatus(observer),
	};
	if (!shouldRepairObserverResponse(first.raw, firstParsed)) {
		return { initial, repaired: null };
	}

	const repairPrompt = buildObserverRepairPrompt(
		system,
		user,
		first.raw as string,
		observer.maxChars,
	);
	let repaired: Awaited<ReturnType<ObserverClient["observe"]>>;
	try {
		repaired = await observer.observe(repairPrompt.system, repairPrompt.user);
	} catch {
		return { initial, repaired: null };
	}
	const repairedParsed = repaired.raw
		? parseObserverResponse(repaired.raw)
		: { observations: [], summary: null, skipSummaryReason: null };
	return {
		initial,
		repaired: {
			raw: repaired.raw,
			parsed: repairedParsed,
			provider: repaired.provider,
			model: repaired.model,
			elapsedMs: repaired.elapsedMs ?? null,
			usage: repaired.usage ?? null,
			status: snapshotObserverStatus(observer),
		},
	};
}

function sumObserverUsage(
	initial: ObserverTokenUsage | null,
	repaired: ObserverTokenUsage | null,
	repairApplied: boolean,
): ObserverTokenUsage | null {
	if (!initial || (repairApplied && !repaired)) return null;
	if (!repairApplied) return { ...initial };
	if (!repaired) return null;
	const totalTokens =
		initial.totalTokens != null && repaired.totalTokens != null
			? initial.totalTokens + repaired.totalTokens
			: undefined;
	const cacheReadInputTokens =
		initial.cacheReadInputTokens != null || repaired.cacheReadInputTokens != null
			? (initial.cacheReadInputTokens ?? 0) + (repaired.cacheReadInputTokens ?? 0)
			: undefined;
	const cacheCreationInputTokens =
		initial.cacheCreationInputTokens != null || repaired.cacheCreationInputTokens != null
			? (initial.cacheCreationInputTokens ?? 0) + (repaired.cacheCreationInputTokens ?? 0)
			: undefined;
	return {
		inputTokens: initial.inputTokens + repaired.inputTokens,
		outputTokens: initial.outputTokens + repaired.outputTokens,
		...(totalTokens != null ? { totalTokens } : {}),
		...(cacheReadInputTokens != null ? { cacheReadInputTokens } : {}),
		...(cacheCreationInputTokens != null ? { cacheCreationInputTokens } : {}),
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
		transport: string;
		requestedModel: string;
		resolvedModel: string | null;
		modelFallbackApplied: boolean;
		modelFallbackReason: string | null;
		tier: "simple" | "rich" | null;
		tierReasons: string[];
		openaiUseResponses: boolean;
		reasoningEffort: string | null;
		reasoningSummary: string | null;
		maxOutputTokens: number | null;
		temperature: number | null;
		repairApplied: boolean;
		initialRaw: string | null;
		initialElapsedMs: number | null;
		initialUsage: ObserverTokenUsage | null;
		initialParsed: ParsedOutput;
		initialDiagnostics: ReturnType<typeof evaluateExtractionStructure> | null;
		repairedRaw: string | null;
		repairedElapsedMs: number | null;
		repairedUsage: ObserverTokenUsage | null;
		repairedParsed: ParsedOutput | null;
		repairedDiagnostics: ReturnType<typeof evaluateExtractionStructure> | null;
		raw: string | null;
		totalElapsedMs: number | null;
		totalUsage: ObserverTokenUsage | null;
		parsed: ParsedOutput;
		diagnostics: ReturnType<typeof evaluateExtractionStructure> | null;
	};
	observerContext: ObserverContext;
	initialClassification: ExtractionReplayResult["classification"];
	repairedClassification: ExtractionReplayResult["classification"] | null;
	initialEvaluation: ReturnType<typeof evaluateSessionExtractionItems>;
	repairedEvaluation: ReturnType<typeof evaluateSessionExtractionItems> | null;
	evaluation: ReturnType<typeof evaluateSessionExtractionItems>;
}

export interface ReplayBatchAnalysis {
	batchId: number;
	sessionId: number;
	eventSpan: number;
	promptCount: number;
	toolCount: number;
	transcriptLength: number;
	firstPrompt: string | undefined;
	filesRead: string[];
	filesModified: string[];
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
		if (!SUPPORTED_OBSERVATION_KINDS.has(kind)) continue;
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
		const summary = {
			...parsed.summary,
			filesRead: normalizePaths(parsed.summary.filesRead, batch.cwd),
			filesModified: normalizePaths(parsed.summary.filesModified, batch.cwd),
		};
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

		// Claude Code raw events arrive as `claude.hook` with an adapter envelope;
		// normalize them to the flat user_prompt / tool.execute.after shapes before
		// scanning so promptCount, toolCount, firstPrompt, filesRead, and
		// filesModified are populated correctly during replay.
		const normalizedForContext = normalizeEventsForSessionContext(events);
		const sessionContext: SessionContext = buildSessionContext(normalizedForContext);
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
				firstPrompt: sessionContext.firstPrompt,
				filesRead: sessionContext.filesRead ?? [],
				filesModified: sessionContext.filesModified ?? [],
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
	const configuredModel = observer.requestedModel ?? observer.model;
	const response = await observeStructuredOutput(observer, prepared.system, prepared.user);
	const requestedModel = configuredModel || response.initial.model;
	const session = {
		id: prepared.batch.session_id,
		project: prepared.batch.project,
		cwd: prepared.batch.cwd ?? process.cwd(),
		startedAt: prepared.batch.started_at ?? "",
		endedAt: prepared.batch.ended_at,
		sessionClass: String(prepared.sessionPost.session_class ?? "unknown"),
		summaryDisposition: String(prepared.sessionPost.summary_disposition ?? "unknown"),
	};
	const target = {
		type: "batch" as const,
		sessionId: prepared.batch.session_id,
		batchId: prepared.batch.id,
	};
	const initialEvaluation = evaluateSessionExtractionItems(
		target,
		session,
		buildReplayItems(response.initial.parsed, prepared.batch, prepared.sessionContext),
		prepared.scenario,
	);
	const repairedEvaluation = response.repaired
		? evaluateSessionExtractionItems(
				target,
				session,
				buildReplayItems(response.repaired.parsed, prepared.batch, prepared.sessionContext),
				prepared.scenario,
			)
		: null;
	const preferRepaired = response.repaired
		? shouldPreferRepairedObserverResponse(
				response.initial.parsed,
				response.repaired.raw,
				response.repaired.parsed,
				response.initial.raw,
			)
		: false;
	const finalResponse = preferRepaired
		? (response.repaired as NonNullable<typeof response.repaired>)
		: response.initial;
	const observerStatus = finalResponse.status;
	const modelFallbackApplied = observerStatus.modelFallbackApplied === true;
	const resolvedModel = modelFallbackApplied
		? (observerStatus.actualModel ?? null)
		: (observerStatus.actualModel ?? finalResponse.model);
	const evaluation = preferRepaired
		? (repairedEvaluation as NonNullable<typeof repairedEvaluation>)
		: initialEvaluation;
	const initialClassification = classifyReplayResult({
		raw: response.initial.raw,
		evaluation: initialEvaluation,
	});
	const repairedClassification = response.repaired
		? classifyReplayResult({
				raw: response.repaired.raw,
				evaluation: repairedEvaluation ?? initialEvaluation,
			})
		: null;
	const initialDiagnostics = evaluateExtractionStructure(
		response.initial.raw ?? "",
		response.initial.parsed,
	);
	const repairedDiagnostics = response.repaired
		? evaluateExtractionStructure(response.repaired.raw ?? "", response.repaired.parsed)
		: null;
	const repairAttempted = response.repaired !== null;
	const totalElapsedMs =
		response.initial.elapsedMs != null && (!repairAttempted || response.repaired?.elapsedMs != null)
			? response.initial.elapsedMs + (response.repaired?.elapsedMs ?? 0)
			: null;
	const totalUsage = sumObserverUsage(
		response.initial.usage,
		response.repaired?.usage ?? null,
		repairAttempted,
	);
	const transport =
		observerStatus.auth.type === "codex_consumer" ||
		observerStatus.auth.type === "anthropic_consumer"
			? observerStatus.auth.type
			: observerStatus.runtime;
	const reportsRequestLimits = transport !== "codex_consumer";
	const reportsReasoning = observer.openaiUseResponses || transport === "codex_consumer";

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
			transport,
			requestedModel,
			resolvedModel,
			modelFallbackApplied,
			modelFallbackReason: observerStatus.modelFallbackReason ?? null,
			tier,
			tierReasons,
			openaiUseResponses: observer.openaiUseResponses,
			reasoningEffort: reportsReasoning ? observer.reasoningEffort : null,
			reasoningSummary: reportsReasoning ? observer.reasoningSummary : null,
			maxOutputTokens: reportsRequestLimits ? observer.maxOutputTokens : null,
			temperature: reportsRequestLimits ? observer.temperature : null,
			repairApplied: preferRepaired,
			initialRaw: response.initial.raw,
			initialElapsedMs: response.initial.elapsedMs,
			initialUsage: response.initial.usage,
			initialParsed: response.initial.parsed,
			initialDiagnostics,
			repairedRaw: response.repaired?.raw ?? null,
			repairedElapsedMs: response.repaired?.elapsedMs ?? null,
			repairedUsage: response.repaired?.usage ?? null,
			repairedParsed: response.repaired?.parsed ?? null,
			repairedDiagnostics,
			raw: finalResponse.raw,
			totalElapsedMs,
			totalUsage,
			parsed: finalResponse.parsed,
			diagnostics: preferRepaired
				? (repairedDiagnostics as NonNullable<typeof repairedDiagnostics>)
				: initialDiagnostics,
		},
		observerContext: prepared.observerContext,
		initialClassification,
		repairedClassification,
		initialEvaluation,
		repairedEvaluation,
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

export function buildTierRoutedReplayObserverConfig(
	baseObserver: Pick<ObserverClient, "toConfig">,
	analysis: ExtractionReplayTierRoutingInput,
): {
	observer: ObserverConfig;
	tier: "simple" | "rich";
	reasons: string[];
} {
	const baseConfig = baseObserver.toConfig();
	const decision = decideExtractionReplayTier(analysis);
	return {
		observer: buildTieredObserverConfig(baseConfig, decision),
		tier: decision.tier,
		reasons: decision.reasons,
	};
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
	const routed = buildTierRoutedReplayObserverConfig(baseObserver, prepared.analysis);
	const observer = new ObserverClientImpl(routed.observer);
	return replayPreparedBatch(prepared, observer, routed.tier, routed.reasons);
}
