import { classifyMemoryWorthiness, type MemoryArtifactClass } from "../memory-quality.js";
import { projectColumnClause } from "../project.js";
import { safeParseMetadata } from "./memory-role-helpers.js";
import type {
	MemoryArtifactClassCount,
	MemoryArtifactReport,
	MemoryArtifactReportOptions,
} from "./types.js";
import { withReadOnlyDb } from "./with-db.js";

const ARTIFACTS: MemoryArtifactClass[] = [
	"session_summary",
	"derived_fact",
	"telemetry",
	"unknown",
];

/** Append structured facts (JSON array or text) to the body for classification. */
function appendFactsToBody(bodyText: string, facts: string | null): string {
	if (!facts) return bodyText;
	let factLines = "";
	try {
		const parsed = JSON.parse(facts);
		if (Array.isArray(parsed) && parsed.length > 0) {
			factLines = parsed.map((fact) => `- ${String(fact)}`).join("\n");
		}
	} catch {
		factLines = facts.trim();
	}
	if (!factLines) return bodyText;
	return bodyText ? `${bodyText}\n\n${factLines}` : factLines;
}

function emptyArtifactCounts(): MemoryArtifactClassCount {
	return {
		session_summary: 0,
		derived_fact: 0,
		telemetry: 0,
		unknown: 0,
	};
}

function incrementNestedArtifactCount(
	target: Record<string, Partial<MemoryArtifactClassCount>>,
	key: string,
	artifact: MemoryArtifactClass,
): void {
	const bucket = target[key] ?? {};
	target[key] = bucket;
	bucket[artifact] = (bucket[artifact] ?? 0) + 1;
}

export function getMemoryArtifactReport(
	dbPath?: string,
	opts: MemoryArtifactReportOptions = {},
): MemoryArtifactReport {
	return withReadOnlyDb(dbPath, (db) => {
		const projectFilter = opts.allProjects ? null : opts.project?.trim() || null;
		const activeClause = opts.includeInactive ? "" : "AND m.active = 1";
		// Basename-aware matching so a path-style filter (e.g. /Users/me/codemem)
		// matches sessions.project stored as "codemem".
		const { clause: projectMatch, params: projectParams } = projectFilter
			? projectColumnClause("s.project", projectFilter)
			: { clause: "", params: [] as string[] };
		const projectClause = projectMatch ? `AND ${projectMatch}` : "";

		const rows = db
			.prepare(
				`SELECT
					m.id,
					m.session_id,
					m.kind,
					m.title,
					m.body_text,
					m.narrative,
					m.metadata_json,
					m.facts,
					m.active,
					s.project,
					CASE
						WHEN s.ended_at IS NOT NULL THEN (julianday(s.ended_at) - julianday(s.started_at)) * 24 * 60
						ELSE NULL
					END AS session_minutes
				FROM memory_items m
				JOIN sessions s ON s.id = m.session_id
				WHERE 1 = 1 ${activeClause} ${projectClause}`,
			)
			.all(...projectParams) as Array<{
			id: number;
			session_id: number;
			kind: string;
			title: string;
			body_text: string;
			narrative: string | null;
			metadata_json: string | null;
			facts: string | null;
			active: number;
			project: string | null;
			session_minutes: number | null;
		}>;

		const countsByArtifact = emptyArtifactCounts();
		const countsByAction: MemoryArtifactReport["counts_by_action"] = {
			store: 0,
			store_demoted: 0,
			suppress: 0,
		};
		const countsByReason: Record<string, number> = {};
		const countsByKind: MemoryArtifactReport["counts_by_kind"] = {};
		const countsByProject: MemoryArtifactReport["counts_by_project"] = {};
		const highConfidenceTelemetry: MemoryArtifactReport["high_confidence_telemetry"] = {
			total: 0,
			by_reason: {},
			examples: [],
		};
		const seenSessions = new Set<number>();
		let activeCount = 0;

		for (const row of rows) {
			seenSessions.add(row.session_id);
			if (row.active === 1) activeCount += 1;
			// Fold narrative + structured facts into the classified text so durable
			// content stored only in `narrative` (structured observations) or only
			// in `facts` (e.g. after backfill/replication) is not missed by a
			// body-only classification.
			const bodyForClassification = appendFactsToBody(
				row.narrative ? `${row.narrative}\n\n${row.body_text}`.trim() : row.body_text,
				row.facts,
			);
			const result = classifyMemoryWorthiness({
				kind: row.kind,
				title: row.title,
				body_text: bodyForClassification,
				metadata: safeParseMetadata(row.metadata_json),
				project: row.project,
				session_minutes: row.session_minutes,
			});

			countsByArtifact[result.artifact] += 1;
			countsByAction[result.action] += 1;
			incrementNestedArtifactCount(countsByKind, row.kind, result.artifact);
			incrementNestedArtifactCount(countsByProject, row.project ?? "(none)", result.artifact);
			for (const reason of result.reasons) {
				countsByReason[reason] = (countsByReason[reason] ?? 0) + 1;
			}

			if (result.artifact === "telemetry" && result.action === "suppress") {
				highConfidenceTelemetry.total += 1;
				for (const reason of result.reasons) {
					highConfidenceTelemetry.by_reason[reason] =
						(highConfidenceTelemetry.by_reason[reason] ?? 0) + 1;
				}
				if (highConfidenceTelemetry.examples.length < 5) {
					highConfidenceTelemetry.examples.push({
						id: row.id,
						kind: row.kind,
						project: row.project,
						title: row.title,
						reasons: [...result.reasons],
					});
				}
			}
		}

		for (const artifact of ARTIFACTS) {
			countsByArtifact[artifact] ??= 0;
		}

		return {
			totals: { memories: rows.length, active: activeCount, sessions: seenSessions.size },
			counts_by_artifact: countsByArtifact,
			counts_by_action: countsByAction,
			counts_by_reason: countsByReason,
			counts_by_kind: countsByKind,
			counts_by_project: countsByProject,
			high_confidence_telemetry: highConfidenceTelemetry,
		};
	});
}
