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
import { buildObserverPrompt, truncateObserverTranscript } from "./ingest-prompts.js";
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
import { SUPPORTED_OBSERVATION_KINDS } from "./ingest-xml-parser.js";
import {
	type ObserverClient,
	ObserverClient as ObserverClientImpl,
	type ObserverConfig,
	type ObserverTokenUsage,
} from "./observer-client.js";
import {
	type ObserverOutputCapabilityReason,
	type ObserverOutputMode,
	type ObserverOutputValidation,
	observeAndNormalizeObserverOutput,
	resolveObserverOutputCapability,
} from "./observer-output.js";
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

function validatedEnvelopeDiagnostics(
	parsed: ParsedOutput,
): ReturnType<typeof evaluateExtractionStructure> {
	const observationCount = parsed.observations.length;
	const summaryCount = parsed.summary ? 1 : 0;
	return {
		recognizedOutput: true,
		observationBlocks: observationCount,
		retainedObservations: observationCount,
		summaryBlocks: summaryCount,
		retainedSummaries: summaryCount,
		illegalObservationNestingInSummary: 0,
		unknownSummaryFields: [],
		unsupportedObservationKinds: [],
		missingObservationKinds: 0,
		discardedObservationBlocks: 0,
		discardedSummaryBlocks: 0,
		dataLoss: false,
	};
}

function failedStructuredAttemptDiagnostics(options: {
	dataLoss: boolean;
}): ReturnType<typeof evaluateExtractionStructure> {
	return {
		recognizedOutput: false,
		observationBlocks: 0,
		retainedObservations: 0,
		summaryBlocks: 0,
		retainedSummaries: 0,
		illegalObservationNestingInSummary: 0,
		unknownSummaryFields: [],
		unsupportedObservationKinds: [],
		missingObservationKinds: 0,
		discardedObservationBlocks: 0,
		discardedSummaryBlocks: 0,
		dataLoss: options.dataLoss,
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
		requestedOutputMode: ObserverOutputMode;
		actualOutputMode: Exclude<ObserverOutputMode, "forced_tool">;
		outputSchemaVersion: number | null;
		outputCapabilityReason: ObserverOutputCapabilityReason;
		outputFallbackApplied: boolean;
		outputFallbackReason: ObserverOutputCapabilityReason | null;
		outputValidation: ObserverOutputValidation;
		outputFailureReason: string | null;
		repairAttempted: boolean;
		retryAttempted: boolean;
		retryReason: string | null;
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
	const outputCapability = resolveObserverOutputCapability(observer);
	const prompt = buildObserverPrompt(prepared.observerContext, {
		outputMode: outputCapability.actualMode,
	});
	const response = await observeAndNormalizeObserverOutput(
		observer,
		prompt.system,
		prompt.user,
		outputCapability,
	);
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
	const preferRepaired = response.repairApplied || response.retryApplied;
	const finalResponse = response.final;
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
	let initialDiagnostics: ReturnType<typeof evaluateExtractionStructure>;
	if (response.diagnostics.actualMode === "legacy_xml") {
		initialDiagnostics = evaluateExtractionStructure(
			response.initial.raw ?? "",
			response.initial.parsed,
		);
	} else if (response.retryApplied) {
		initialDiagnostics = failedStructuredAttemptDiagnostics({
			dataLoss: response.initial.raw != null,
		});
	} else {
		initialDiagnostics = validatedEnvelopeDiagnostics(response.initial.parsed);
	}
	let repairedDiagnostics: ReturnType<typeof evaluateExtractionStructure> | null = null;
	if (response.repaired) {
		repairedDiagnostics =
			response.diagnostics.actualMode === "legacy_xml"
				? evaluateExtractionStructure(response.repaired.raw ?? "", response.repaired.parsed)
				: validatedEnvelopeDiagnostics(response.repaired.parsed);
	}
	const repairAttempted = response.diagnostics.repairAttempted;
	const secondAttempted = repairAttempted || response.diagnostics.retryAttempted;
	const totalElapsedMs =
		response.initial.elapsedMs != null && (!secondAttempted || response.repaired?.elapsedMs != null)
			? response.initial.elapsedMs + (response.repaired?.elapsedMs ?? 0)
			: null;
	const totalUsage = sumObserverUsage(
		response.initial.usage,
		response.repaired?.usage ?? null,
		secondAttempted,
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
			repairApplied: response.repairApplied,
			requestedOutputMode: response.diagnostics.requestedMode,
			actualOutputMode: response.diagnostics.actualMode,
			outputSchemaVersion: response.diagnostics.schemaVersion,
			outputCapabilityReason: response.diagnostics.capabilityReason,
			outputFallbackApplied: response.diagnostics.fallbackApplied,
			outputFallbackReason: response.diagnostics.fallbackReason,
			outputValidation: response.diagnostics.validation,
			outputFailureReason: response.diagnostics.failureReason,
			repairAttempted,
			retryAttempted: response.diagnostics.retryAttempted,
			retryReason: response.diagnostics.retryReason,
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
			diagnostics: preferRepaired ? repairedDiagnostics : initialDiagnostics,
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
