/**
 * Role-based retrieval eval — scoring library.
 *
 * Pure functions over @codemem/core's already-exported primitives. No new core
 * behavior, no CLI commands. Under the refocused dual-artifact model there is no
 * `prefer_derived_facts` boost to toggle, so this harness is a SINGLE-SNAPSHOT
 * corpus-quality measurement: it runs a probe battery through the pack trace
 * path once on a real DB and reports the artifact-bucket shares per retrieval
 * mode. A committed baseline lets future ranking changes (e.g. relevance-first
 * ordering) be gated on real-corpus drift instead of unit tests alone.
 */

import {
	buildMemoryPackTrace,
	classifyMemoryWorthiness,
	isSummaryLikeMemory,
	type MemoryItemResponse,
	type MemoryStore,
	readArtifactClass,
} from "@codemem/core";
import type { Probe, ProbeMode } from "./scenarios.js";

export type ArtifactBucket = "session_summary" | "derived_fact" | "telemetry" | "durable_other";
export type StoredArtifactMarker = "session_summary" | "derived_fact" | "telemetry" | "unknown";

/**
 * Bucket a top result using the in-place artifact marker first, then the
 * worthiness classifier as a fallback for legacy rows without a marker. This is
 * deliberately stricter than the report's text heuristic so bucket shares
 * reflect real artifact roles, not wording look-alikes.
 */
export function bucketItem(item: {
	kind: string;
	title: string;
	body_text: string;
	metadata: Record<string, unknown>;
}): ArtifactBucket {
	const marker = readArtifactClass(item.metadata);
	if (marker !== "unknown") return marker;
	if (isSummaryLikeMemory({ kind: item.kind, metadata: item.metadata })) return "session_summary";
	const decision = classifyMemoryWorthiness({
		kind: item.kind,
		title: item.title,
		body_text: item.body_text,
		metadata: item.metadata,
	});
	if (decision.artifact === "telemetry") return "telemetry";
	if (decision.artifact === "derived_fact") return "derived_fact";
	if (decision.artifact === "session_summary") return "session_summary";
	return "durable_other";
}

function normalizeMemoryItem(item: MemoryItemResponse): {
	kind: string;
	title: string;
	body_text: string;
	metadata: Record<string, unknown>;
} {
	return {
		kind: item.kind,
		title: item.title,
		body_text: item.body_text,
		metadata: item.metadata_json,
	};
}

export interface ProbeMetrics {
	query: string;
	mode: ProbeMode;
	packMode: "default" | "task" | "recall";
	topN: number;
	/** Buckets after in-place markers plus classifier fallback for legacy rows. */
	shares: Record<ArtifactBucket, number>;
	/** In-place stored metadata.derivation.artifact_class markers only (diagnostic). */
	markerShares: Record<StoredArtifactMarker, number>;
	/** Bucket of the #1 result (the most load-bearing position). */
	top1: ArtifactBucket | null;
}

const EMPTY_SHARES: Record<ArtifactBucket, number> = {
	session_summary: 0,
	derived_fact: 0,
	telemetry: 0,
	durable_other: 0,
};

const EMPTY_MARKER_SHARES: Record<StoredArtifactMarker, number> = {
	session_summary: 0,
	derived_fact: 0,
	telemetry: 0,
	unknown: 0,
};

/**
 * Reconstruct the FINAL user-visible pack order from the trace.
 *
 * IMPORTANT: `trace.retrieval.candidates[].rank` is assigned from the raw
 * retrieval order, BEFORE prioritizeDefaultResults reorders the pack. Sorting by
 * that rank measures pre-reorder ranking and hides the effect of relevance-first
 * ordering. `trace.assembly.sections` holds the final ordered item IDs per
 * section (summary -> timeline -> observations) after prioritization, dedupe,
 * and trimming — i.e. the order the user actually sees — so we read from there.
 */
function finalPackOrder(trace: ReturnType<typeof buildMemoryPackTrace>): number[] {
	const { summary, timeline, observations } = trace.assembly.sections;
	const ordered: number[] = [];
	const seen = new Set<number>();
	for (const id of [...summary, ...timeline, ...observations]) {
		if (seen.has(id)) continue;
		seen.add(id);
		ordered.push(id);
	}
	return ordered;
}

/** Run one probe through the pack trace path (no usage-row writes). */
export function runProbe(store: MemoryStore, probe: Probe, topN = 5): ProbeMetrics {
	const trace = buildMemoryPackTrace(store, probe.query, Math.max(topN, 10));
	const top = finalPackOrder(trace)
		.slice(0, topN)
		.flatMap((id) => {
			const item = store.get(id);
			return item ? [normalizeMemoryItem(item)] : [];
		});
	const counts: Record<ArtifactBucket, number> = { ...EMPTY_SHARES };
	const markerCounts: Record<StoredArtifactMarker, number> = { ...EMPTY_MARKER_SHARES };
	for (const item of top) {
		counts[bucketItem(item)] += 1;
		markerCounts[readArtifactClass(item.metadata)] += 1;
	}
	const denom = top.length || 1;
	const shares = Object.fromEntries(
		Object.entries(counts).map(([k, v]) => [k, v / denom]),
	) as Record<ArtifactBucket, number>;
	const markerShares = Object.fromEntries(
		Object.entries(markerCounts).map(([k, v]) => [k, v / denom]),
	) as Record<StoredArtifactMarker, number>;
	const first = top[0];
	return {
		query: probe.query,
		mode: probe.mode,
		packMode: trace.mode.selected,
		topN: top.length,
		shares,
		markerShares,
		top1: first ? bucketItem(first) : null,
	};
}

export function runAll(store: MemoryStore, probes: Probe[], topN = 5): ProbeMetrics[] {
	return probes.map((p) => runProbe(store, p, topN));
}

/** Average a share across a subset of probe metrics. */
function avgShare(metrics: ProbeMetrics[], bucket: ArtifactBucket): number {
	if (metrics.length === 0) return 0;
	return metrics.reduce((sum, m) => sum + m.shares[bucket], 0) / metrics.length;
}

function avgMarkerShare(metrics: ProbeMetrics[], marker: StoredArtifactMarker): number {
	if (metrics.length === 0) return 0;
	return metrics.reduce((sum, m) => sum + m.markerShares[marker], 0) / metrics.length;
}

function byMode(metrics: ProbeMetrics[], modes: ProbeMode[]): ProbeMetrics[] {
	return metrics.filter((m) => modes.includes(m.mode));
}

export interface Snapshot {
	probes: number;
	// Non-recap retrieval (default/task/debug) — durable content should lead.
	nonRecap: {
		summary_share: number;
		telemetry_share: number;
		/** derived_fact + durable_other buckets; the durable working memory. */
		durable_share: number;
		/** In-place derived_fact marker share (diagnostic, not a ranking input). */
		stored_derived_fact_share: number;
	};
	// Explicit recap — summaries should lead.
	recap: {
		summary_share: number;
		/** Fraction of recap probes whose #1 result is a summary. */
		summary_top1_rate: number;
		/** Recap probes that did not actually route through the recall pack mode. */
		route_mismatch_count: number;
	};
}

export function snapshot(metrics: ProbeMetrics[]): Snapshot {
	const nonRecap = byMode(metrics, ["default", "task", "debug"]);
	const recap = byMode(metrics, ["recap"]);
	const recapTop1Summary = recap.filter((m) => m.top1 === "session_summary").length;
	const recapRouteMismatches = recap.filter((m) => m.packMode !== "recall").length;
	return {
		probes: metrics.length,
		nonRecap: {
			summary_share: avgShare(nonRecap, "session_summary"),
			telemetry_share: avgShare(nonRecap, "telemetry"),
			durable_share: avgShare(nonRecap, "derived_fact") + avgShare(nonRecap, "durable_other"),
			stored_derived_fact_share: avgMarkerShare(nonRecap, "derived_fact"),
		},
		recap: {
			summary_share: avgShare(recap, "session_summary"),
			summary_top1_rate: recap.length > 0 ? recapTop1Summary / recap.length : 0,
			route_mismatch_count: recapRouteMismatches,
		},
	};
}

export interface GateResult {
	passed: boolean;
	failures: string[];
}

/**
 * Absolute sanity gate on a single snapshot. These are invariants that should
 * hold for any healthy corpus regardless of the committed baseline: explicit
 * recap must route through recall mode. Quality drift (summary/telemetry share
 * rising, durable share falling) is enforced by the baseline comparison in
 * pack-eval.ts, where we have real-corpus numbers to compare against.
 */
export function evaluateGate(snap: Snapshot): GateResult {
	const failures: string[] = [];
	if (snap.recap.route_mismatch_count > 0) {
		failures.push(
			`${snap.recap.route_mismatch_count} recap probe(s) did not route through recall mode`,
		);
	}
	return { passed: failures.length === 0, failures };
}

export interface BaselineDrift {
	ok: boolean;
	notes: string[];
}

/**
 * Compare a fresh snapshot against a committed baseline snapshot. Worse =
 * summary/telemetry share rose in non-recap, durable share fell in non-recap,
 * recap summary-first rate fell, or recap route mismatches rose.
 */
export function compareToBaseline(prior: Snapshot, now: Snapshot, eps = 1e-6): BaselineDrift {
	const notes: string[] = [];
	// A baseline frozen against a different probe suite is not comparable: the
	// averages mix different queries, so drift would be apples-to-oranges. Fail
	// loudly and require rewriting the baseline instead of silently passing.
	if (prior.probes !== now.probes) {
		return {
			ok: false,
			notes: [
				`WORSE probe count changed: baseline has ${prior.probes} probe(s), current run has ${now.probes}. ` +
					"Rewrite the baseline (--write-baseline) for the new probe suite before comparing.",
			],
		};
	}
	const cmp = (label: string, was: number, val: number, lowerBetter: boolean) => {
		const d = val - was;
		if (Math.abs(d) < eps) return;
		const worse = lowerBetter ? d > 0 : d < 0;
		notes.push(`${worse ? "WORSE" : "better"} ${label}: ${was.toFixed(3)} -> ${val.toFixed(3)}`);
	};
	cmp("non-recap summary share", prior.nonRecap.summary_share, now.nonRecap.summary_share, true);
	cmp("non-recap telemetry share", prior.nonRecap.telemetry_share, now.nonRecap.telemetry_share, true);
	cmp("non-recap durable share", prior.nonRecap.durable_share, now.nonRecap.durable_share, false);
	cmp("recap summary-first rate", prior.recap.summary_top1_rate, now.recap.summary_top1_rate, false);
	cmp(
		"recap route mismatches",
		prior.recap.route_mismatch_count,
		now.recap.route_mismatch_count,
		true,
	);
	return { ok: !notes.some((n) => n.startsWith("WORSE")), notes };
}

export function isSnapshot(value: unknown): value is Snapshot {
	if (!value || typeof value !== "object") return false;
	const s = value as Partial<Snapshot>;
	return (
		typeof s.nonRecap?.summary_share === "number" &&
		typeof s.nonRecap.telemetry_share === "number" &&
		typeof s.nonRecap.durable_share === "number" &&
		typeof s.nonRecap.stored_derived_fact_share === "number" &&
		typeof s.recap?.summary_top1_rate === "number" &&
		typeof s.recap.route_mismatch_count === "number"
	);
}
