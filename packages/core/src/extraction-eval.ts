import { connect, resolveDbPath } from "./db.js";
import { getSummaryMetadata, isSummaryLikeMemory } from "./summary-memory.js";

export interface SessionExtractionEvalThread {
	id: string;
	title: string;
	keywords: string[];
}

export interface SessionExtractionEvalScenario {
	id: string;
	title: string;
	description: string;
	summaryCountRange: { min: number; max: number };
	observationCountRange: { min: number; max: number };
	minSummaryThreadCoverage: number;
	minObservationThreadCoverage: number;
	minTotalThreadCoverage: number;
	threads: SessionExtractionEvalThread[];
}

export interface SessionExtractionEvalItem {
	id: number;
	kind: string;
	title: string;
	bodyText: string;
	active: boolean;
	createdAt: string;
	metadata: unknown;
}

export interface SessionExtractionEvalThreadResult {
	id: string;
	title: string;
	summaryMatch: boolean;
	observationMatch: boolean;
	matchedSummaryIds: number[];
	matchedObservationIds: number[];
}

export interface SessionExtractionEvalResult {
	scenario: {
		id: string;
		title: string;
		description: string;
	};
	target: {
		type: "session" | "batch";
		sessionId: number;
		batchId: number | null;
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
	counts: {
		total: number;
		summaries: number;
		observations: number;
	};
	coverage: {
		summaryThreadCoverage: number;
		observationThreadCoverage: number;
		totalThreadCoverage: number;
		duplicateObservationThreads: number;
	};
	rangeChecks: {
		summaryCountInRange: boolean;
		observationCountInRange: boolean;
	};
	pass: boolean;
	failureReasons: string[];
	threads: SessionExtractionEvalThreadResult[];
	items: Array<SessionExtractionEvalItem & { summaryLike: boolean }>;
}

type SessionExtractionEvalTarget =
	| { type: "session"; sessionId: number }
	| { type: "batch"; sessionId: number; batchId: number };

const EXTRACTION_EVAL_SCENARIOS: SessionExtractionEvalScenario[] = [
	{
		id: "rich-batch-shape",
		title: "Rich batch output shape",
		description:
			"Evaluates whether a rich batch yields one broad summary plus a small capped set of durable observations, without enforcing scenario-specific thread topics.",
		summaryCountRange: { min: 1, max: 1 },
		observationCountRange: { min: 2, max: 4 },
		minSummaryThreadCoverage: 0,
		minObservationThreadCoverage: 0,
		minTotalThreadCoverage: 0,
		threads: [],
	},
	{
		id: "rich-session-under-extraction",
		title: "Rich multi-thread session extraction coverage",
		description:
			"Evaluates whether a rich session yields one broad summary plus a small set of durable observations covering the major reusable subthreads.",
		summaryCountRange: { min: 1, max: 1 },
		observationCountRange: { min: 2, max: 4 },
		minSummaryThreadCoverage: 2,
		minObservationThreadCoverage: 2,
		minTotalThreadCoverage: 3,
		threads: [
			{
				id: "regression-closure",
				title: "Regression investigation closure",
				keywords: ["qd7h", "micro-session regression", "regression timeline", "root cause"],
			},
			{
				id: "release-readiness",
				title: "Release readiness for 0.23.0",
				keywords: ["0.23.0", "release readiness", "release candidate", "prepare release"],
			},
			{
				id: "track3-reframing",
				title: "Track 3 reframing toward injection-first quality",
				keywords: ["track 3", "injection-first", "rediscovery", "scouting effort"],
			},
			{
				id: "graph-direction",
				title: "Graph / progressive disclosure future direction",
				keywords: ["graph", "progressive disclosure", "relationship layer", "silk-graph"],
			},
		],
	},
];

function normalizeText(value: string): string {
	return value.trim().toLowerCase();
}

function itemText(item: Pick<SessionExtractionEvalItem, "title" | "bodyText">): string {
	return normalizeText(`${item.title}\n${item.bodyText}`);
}

function matchesThread(
	item: Pick<SessionExtractionEvalItem, "title" | "bodyText">,
	thread: SessionExtractionEvalThread,
): boolean {
	const text = itemText(item);
	return thread.keywords.some((keyword) => text.includes(normalizeText(keyword)));
}

function buildFailureReasons(
	scenario: SessionExtractionEvalScenario,
	counts: SessionExtractionEvalResult["counts"],
	coverage: SessionExtractionEvalResult["coverage"],
	rangeChecks: SessionExtractionEvalResult["rangeChecks"],
): string[] {
	const failures: string[] = [];
	if (!rangeChecks.summaryCountInRange) {
		failures.push(
			`summary count ${counts.summaries} outside expected range ${scenario.summaryCountRange.min}-${scenario.summaryCountRange.max}`,
		);
	}
	if (!rangeChecks.observationCountInRange) {
		failures.push(
			`observation count ${counts.observations} outside expected range ${scenario.observationCountRange.min}-${scenario.observationCountRange.max}`,
		);
	}
	if (coverage.summaryThreadCoverage < scenario.minSummaryThreadCoverage) {
		failures.push(
			`summary thread coverage ${coverage.summaryThreadCoverage} below required minimum ${scenario.minSummaryThreadCoverage}`,
		);
	}
	if (coverage.observationThreadCoverage < scenario.minObservationThreadCoverage) {
		failures.push(
			`observation thread coverage ${coverage.observationThreadCoverage} below required minimum ${scenario.minObservationThreadCoverage}`,
		);
	}
	if (coverage.totalThreadCoverage < scenario.minTotalThreadCoverage) {
		failures.push(
			`total thread coverage ${coverage.totalThreadCoverage} below required minimum ${scenario.minTotalThreadCoverage}`,
		);
	}
	if (coverage.duplicateObservationThreads > 1) {
		failures.push(
			`duplicate observation thread matches ${coverage.duplicateObservationThreads} exceed tolerated maximum 1`,
		);
	}
	return failures;
}

export function getSessionExtractionEvalScenario(id: string): SessionExtractionEvalScenario | null {
	const normalized = normalizeText(id);
	return EXTRACTION_EVAL_SCENARIOS.find((scenario) => scenario.id === normalized) ?? null;
}

export function evaluateSessionExtractionItems(
	target: SessionExtractionEvalTarget,
	session: SessionExtractionEvalResult["session"],
	items: SessionExtractionEvalItem[],
	scenario: SessionExtractionEvalScenario,
): SessionExtractionEvalResult {
	const decoratedItems = items.map((item) => ({
		...item,
		summaryLike: isSummaryLikeMemory({ kind: item.kind, metadata: item.metadata }),
	}));
	const summaryItems = decoratedItems.filter((item) => item.summaryLike);
	const observationItems = decoratedItems.filter((item) => !item.summaryLike);
	const threads = scenario.threads.map<SessionExtractionEvalThreadResult>((thread) => {
		const matchedSummaryIds = summaryItems
			.filter((item) => matchesThread(item, thread))
			.map((item) => item.id);
		const matchedObservationIds = observationItems
			.filter((item) => matchesThread(item, thread))
			.map((item) => item.id);
		return {
			id: thread.id,
			title: thread.title,
			summaryMatch: matchedSummaryIds.length > 0,
			observationMatch: matchedObservationIds.length > 0,
			matchedSummaryIds,
			matchedObservationIds,
		};
	});
	const counts = {
		total: decoratedItems.length,
		summaries: summaryItems.length,
		observations: observationItems.length,
	};
	const coverage = {
		summaryThreadCoverage: threads.filter((thread) => thread.summaryMatch).length,
		observationThreadCoverage: threads.filter((thread) => thread.observationMatch).length,
		totalThreadCoverage: threads.filter((thread) => thread.summaryMatch || thread.observationMatch)
			.length,
		duplicateObservationThreads: threads.reduce(
			(sum, thread) => sum + Math.max(0, thread.matchedObservationIds.length - 1),
			0,
		),
	};
	const rangeChecks = {
		summaryCountInRange:
			counts.summaries >= scenario.summaryCountRange.min &&
			counts.summaries <= scenario.summaryCountRange.max,
		observationCountInRange:
			counts.observations >= scenario.observationCountRange.min &&
			counts.observations <= scenario.observationCountRange.max,
	};
	const failureReasons = buildFailureReasons(scenario, counts, coverage, rangeChecks);
	return {
		scenario: {
			id: scenario.id,
			title: scenario.title,
			description: scenario.description,
		},
		target: {
			type: target.type,
			sessionId: target.sessionId,
			batchId: target.type === "batch" ? target.batchId : null,
		},
		session,
		counts,
		coverage,
		rangeChecks,
		pass: failureReasons.length === 0,
		failureReasons,
		threads,
		items: decoratedItems,
	};
}

export function getSessionExtractionEval(
	dbPath: string | undefined,
	opts:
		| { sessionId: number; scenarioId: string; includeInactive?: boolean; batchId?: never }
		| { sessionId?: never; scenarioId: string; includeInactive?: boolean; batchId: number },
): SessionExtractionEvalResult {
	const scenario = getSessionExtractionEvalScenario(opts.scenarioId);
	if (!scenario) {
		throw new Error(`Unknown session extraction eval scenario: ${opts.scenarioId}`);
	}
	const db = connect(resolveDbPath(dbPath));
	try {
		const batchRow =
			"batchId" in opts
				? (db
						.prepare(
							`SELECT
								b.id,
								b.opencode_session_id,
								b.created_at,
								b.updated_at,
								os.session_id
							 FROM raw_event_flush_batches b
							 LEFT JOIN opencode_sessions os
							   ON os.source = b.source
							  AND os.stream_id = b.stream_id
							 WHERE b.id = ?`,
						)
						.get(opts.batchId) as
						| {
								id: number;
								opencode_session_id: string;
								created_at: string;
								updated_at: string;
								session_id: number | null;
						  }
						| undefined)
				: undefined;
		if ("batchId" in opts && !batchRow) {
			throw new Error(`Flush batch ${opts.batchId} not found`);
		}
		const sessionId = "batchId" in opts ? batchRow?.session_id : opts.sessionId;
		if (sessionId == null) {
			throw new Error(
				`Flush batch ${opts.batchId} is not linked to a local session and cannot be evaluated yet`,
			);
		}
		const sessionRow = db
			.prepare(
				`SELECT id, project, cwd, started_at, ended_at, metadata_json
				 FROM sessions
				 WHERE id = ?`,
			)
			.get(sessionId) as
			| {
					id: number;
					project: string | null;
					cwd: string;
					started_at: string;
					ended_at: string | null;
					metadata_json: string | null;
			  }
			| undefined;
		if (!sessionRow) {
			throw new Error(`Session ${sessionId} not found`);
		}
		const rows = (
			"batchId" in opts
				? db
						.prepare(
							`SELECT id, kind, title, body_text, active, created_at, metadata_json
							 FROM memory_items
							 WHERE session_id = ?
							   AND (? = 1 OR active = 1)
							   AND (
							     json_extract(metadata_json, '$.flush_batch.batch_id') = ?
							     OR created_at BETWEEN ? AND ?
							   )
							 ORDER BY created_at ASC, id ASC`,
						)
						.all(
							sessionId,
							opts.includeInactive === true ? 1 : 0,
							opts.batchId,
							batchRow?.created_at,
							batchRow?.updated_at,
						)
				: db
						.prepare(
							`SELECT id, kind, title, body_text, active, created_at, metadata_json
							 FROM memory_items
							 WHERE session_id = ? AND (? = 1 OR active = 1)
							 ORDER BY created_at ASC, id ASC`,
						)
						.all(sessionId, opts.includeInactive === true ? 1 : 0)
		) as Array<{
			id: number;
			kind: string;
			title: string;
			body_text: string;
			active: number;
			created_at: string;
			metadata_json: string | null;
		}>;
		const sessionMetadata = getSummaryMetadata(sessionRow.metadata_json);
		const post =
			sessionMetadata.post &&
			typeof sessionMetadata.post === "object" &&
			!Array.isArray(sessionMetadata.post)
				? (sessionMetadata.post as Record<string, unknown>)
				: {};
		const session = {
			id: sessionRow.id,
			project: sessionRow.project,
			cwd: sessionRow.cwd,
			startedAt: sessionRow.started_at,
			endedAt: sessionRow.ended_at,
			sessionClass: String(post.session_class ?? "unknown"),
			summaryDisposition: String(post.summary_disposition ?? "unknown"),
		};
		const items = rows.map<SessionExtractionEvalItem>((row) => ({
			id: row.id,
			kind: row.kind,
			title: row.title,
			bodyText: row.body_text,
			active: row.active === 1,
			createdAt: row.created_at,
			metadata: row.metadata_json,
		}));
		const target: SessionExtractionEvalTarget =
			"batchId" in opts && typeof opts.batchId === "number"
				? { type: "batch", sessionId, batchId: opts.batchId }
				: { type: "session", sessionId };
		return evaluateSessionExtractionItems(target, session, items, scenario);
	} finally {
		db.close();
	}
}
