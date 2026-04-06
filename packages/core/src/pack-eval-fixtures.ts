import type { MemoryStore } from "./store.js";
import { insertTestSession } from "./test-utils.js";

export type PackEvalCorpus = {
	currentSessionId: number;
	olderSessionId: number;
	ids: {
		oauthDecisionId: number;
		authTaskDecisionId: number;
		viewerTaskFeatureId: number;
		viewerHealthFeatureId: number;
		workingSetPrimaryId: number;
		workingSetDistractorId: number;
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

	return {
		currentSessionId,
		olderSessionId,
		ids: {
			oauthDecisionId,
			authTaskDecisionId,
			viewerTaskFeatureId,
			viewerHealthFeatureId,
			workingSetPrimaryId,
			workingSetDistractorId,
		},
	};
}
