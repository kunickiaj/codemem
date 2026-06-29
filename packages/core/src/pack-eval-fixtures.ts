import type { MemoryStore } from "./store.js";
import { insertTestSession } from "./test-utils.js";

export type PackEvalCorpus = {
	currentSessionId: number;
	olderSessionId: number;
	ids: {
		oauthDecisionId: number;
		authTaskDecisionId: number;
		memoryIssuesDurableId: number;
		memoryIssuesRecapId: number;
		dualArtifactRecapId: number;
		derivedFactContractId: number;
		telemetryValidationId: number;
		sessionizationDurableId: number;
		sessionizationSummaryId: number;
		viewerTaskFeatureId: number;
		viewerHealthFeatureId: number;
		workingSetPrimaryId: number;
		workingSetDistractorId: number;
		workingSetSharedFileStrongId: number;
		workingSetSharedFileNoiseId: number;
	};
};

export function createPackEvalCorpus(store: MemoryStore): PackEvalCorpus {
	const currentSessionId = insertTestSession(store.db);
	const olderSessionId = insertTestSession(store.db);
	const now = new Date().toISOString();

	const insertSummary = (sessionId: number, title: string, body: string) => {
		store.db
			.prepare(
				`INSERT INTO memory_items(
					session_id, kind, title, body_text, confidence, tags_text, active, created_at, updated_at, metadata_json, rev
				) VALUES (?, 'session_summary', ?, ?, 0.8, '', 1, ?, ?, '{}', 1)`,
			)
			.run(sessionId, title, body, now, now);
	};

	const oauthDecisionId = store.remember(
		olderSessionId,
		"decision",
		"OAuth callback fix",
		"Patched callback verification and state validation for login flow",
		0.9,
	);
	insertSummary(olderSessionId, "Old summary", "Earlier wrap-up without oauth keyword");

	insertSummary(
		currentSessionId,
		"Recent summary",
		"Latest generic wrap-up for unrelated viewer work",
	);
	store.remember(
		currentSessionId,
		"feature",
		"Recent unrelated",
		"Viewer spacing cleanup and card polish",
		0.7,
	);

	const authTaskDecisionId = store.remember(
		currentSessionId,
		"decision",
		"Task: auth hardening",
		"Need to add OAuth callback validation and replay protection",
		0.95,
	);
	const memoryIssuesRecapId = store.remember(
		currentSessionId,
		"change",
		"Memory retrieval issues recap",
		"## Request\ninvestigate memory retrieval issues\n\n## Completed\nreviewed recap-heavy retrieval output",
		0.85,
		undefined,
		{ is_summary: true },
	);
	const memoryIssuesDurableId = store.remember(
		currentSessionId,
		"discovery",
		"Memory retrieval issue root cause",
		"Identified ranking and summary weighting issues affecting memory retrieval quality",
		0.92,
	);
	// Dual-artifact routing rows live on their OWN topic ("widget pagination")
	// so the artifact-aware ranking under test does not perturb the unrelated
	// "memory retrieval" / working-set fixtures used by legacy eval specs.
	const dualArtifactRecapId = store.remember(
		currentSessionId,
		"change",
		"Widget pagination work recap",
		"## Request\ncatch me up on widget pagination work\n\n## Completed\nreviewed widget pagination work and summarized widget pagination progress",
		0.85,
		undefined,
		{ is_summary: true },
	);
	const derivedFactResult = store.upsertDerivedFact({
		sessionId: currentSessionId,
		kind: "discovery",
		title: "Widget pagination derived fact contract",
		bodyText:
			"Widget pagination must page items in stable sorted order so cursors stay valid across widget pages.",
		confidence: 0.96,
		facts: ["Widget pagination cursors must remain stable across widget pages."],
		concepts: ["widget-pagination", "artifact-routing"],
		derivation: {
			claim_type: "implementation_contract",
			claim_key: "pack-eval:widget-pagination-derived-fact-routing",
			extractor_version: "pack-eval-fixture-v1",
			source: {
				session_ids: [currentSessionId],
				memory_ids: [dualArtifactRecapId],
				summary_memory_id: dualArtifactRecapId,
			},
			grounding: {
				concepts: ["widget-pagination", "artifact-routing"],
				files: ["packages/core/src/search.ts", "packages/core/src/pack.ts"],
				must_appear_tokens: ["widget", "pagination", "derived", "facts"],
			},
			confidence: 0.96,
		},
		provenance: {
			scope_id: "local-default",
			visibility: "private",
			workspace_id: "personal:test",
			workspace_kind: "personal",
			trust_state: "trusted",
		},
		options: { skipVectorWrite: true },
	});
	const derivedFactContractId = derivedFactResult.id;
	const telemetryValidationId = store.remember(
		currentSessionId,
		"change",
		"Widget pagination validation passed",
		"pnpm run lint passed and CI is green for widget pagination work.",
		0.5,
		undefined,
		{ derivation: { artifact_class: "telemetry" } },
	);
	const sessionizationSummaryId = store.remember(
		currentSessionId,
		"session_summary",
		"Session summary emission recap",
		"Recent summary about short-session recap emission and follow-up notes",
		0.8,
	);
	const sessionizationDurableId = store.remember(
		currentSessionId,
		"decision",
		"Sessionization summary emission policy",
		"Define when summary emission should be suppressed or delayed for micro-sessions",
		0.94,
	);
	const viewerTaskFeatureId = store.remember(
		currentSessionId,
		"feature",
		"Task: polish viewer cards",
		"Refine spacing and color treatment in cards",
		0.8,
	);
	const viewerHealthFeatureId = store.remember(
		currentSessionId,
		"feature",
		"Viewer health improvements",
		"Continue health tab work, improve freshness and backlog diagnostics",
		0.85,
	);

	const workingSetPrimaryId = store.remember(
		currentSessionId,
		"feature",
		"Health tab file overlap",
		"Work tied directly to the health tab implementation",
		0.8,
		undefined,
		{ files_modified: ["packages/ui/src/tabs/health.ts"] },
	);
	const workingSetDistractorId = store.remember(
		currentSessionId,
		"feature",
		"Other tab work",
		"Unrelated work in another viewer tab",
		0.8,
		undefined,
		{ files_modified: ["packages/ui/src/tabs/feed.ts"] },
	);
	// Two memories touching the SAME file so retrieval must pick between them on
	// signal rather than file-overlap alone. Kept on a distinct file
	// (settings.ts) so they don't perturb the health.ts-focused tests above.
	const workingSetSharedFileStrongId = store.remember(
		currentSessionId,
		"decision",
		"Settings tab freshness rule",
		"Decision to cap settings tab freshness diagnostics at 24h and surface stale peer counts inline",
		0.92,
		undefined,
		{ files_modified: ["packages/ui/src/tabs/settings.ts"] },
	);
	const workingSetSharedFileNoiseId = store.remember(
		olderSessionId,
		"exploration",
		"Settings tab drive-by tidy",
		"Minor comment fix in the settings tab file, unrelated to any current work",
		0.3,
		undefined,
		{ files_modified: ["packages/ui/src/tabs/settings.ts"] },
	);

	return {
		currentSessionId,
		olderSessionId,
		ids: {
			oauthDecisionId,
			authTaskDecisionId,
			memoryIssuesDurableId,
			memoryIssuesRecapId,
			dualArtifactRecapId,
			derivedFactContractId,
			telemetryValidationId,
			sessionizationDurableId,
			sessionizationSummaryId,
			viewerTaskFeatureId,
			viewerHealthFeatureId,
			workingSetPrimaryId,
			workingSetDistractorId,
			workingSetSharedFileStrongId,
			workingSetSharedFileNoiseId,
		},
	};
}
