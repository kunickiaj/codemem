/**
 * Probe battery for the dual-artifact retrieval eval.
 *
 * These are intentionally NOT product config — they live in the eval harness so
 * we can grow the suite without touching the CLI or shipping new memory commands.
 * Probes are grouped by retrieval intent so the gate can assert per-mode rules
 * (e.g. summaries must lead recap, derived facts must lead default/task).
 */

export type ProbeMode = "default" | "task" | "debug" | "recap";

export interface Probe {
	query: string;
	/** Intent we expect this query to express. Used only for grouping/reporting. */
	mode: ProbeMode;
}

/**
 * Default battery. Tuned to exercise the failure modes that have historically
 * regressed packing: telemetry/recap domination in non-recap retrieval, and
 * recap quality loss in explicit catch-up.
 */
export const DEFAULT_PROBES: Probe[] = [
	// Topical / default — durable facts should lead, telemetry should not.
	{ query: "memory retrieval ranking issues", mode: "default" },
	{ query: "how does pack ranking work", mode: "default" },
	// NOTE: avoid recap-trigger phrases here ("what did we decide", "catch me
	// up", "summary of") — queryLooksLikeRecall in pack.ts would route them to
	// recall mode and skew the non-recap bucket/baseline (Codex).
	{ query: "retrieval scoring weights", mode: "default" },
	{ query: "sync replication conflict handling", mode: "default" },
	{ query: "observer ingestion pipeline", mode: "default" },

	// Task / continuation — actionable durable context should lead.
	{ query: "what should we do next about retrieval quality", mode: "task" },
	{ query: "continue the dual artifact memory work", mode: "task" },
	{ query: "next steps for sync hardening", mode: "task" },

	// Debug / troubleshooting — bugfix/gotcha/root-cause should lead.
	{ query: "why did packing get worse", mode: "debug" },
	{ query: "have we seen this sqlite migration error before", mode: "debug" },

	// Explicit recap — summaries should lead; routing must NOT displace them.
	{ query: "catch me up on memory retrieval work", mode: "recap" },
	{ query: "summary of recent sync changes", mode: "recap" },

	// Telemetry bait — these should surface as little telemetry as possible.
	{ query: "review found no blockers", mode: "default" },
	{ query: "tests passed lint passed ci green", mode: "default" },
	{ query: "context files were loaded", mode: "default" },
];
