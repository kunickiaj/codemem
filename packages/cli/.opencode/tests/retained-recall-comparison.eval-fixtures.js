import { createHash } from "node:crypto";

const fingerprint = (body) => createHash("sha256").update(body).digest("hex");

const makePack = (...items) => {
	let packText = "## Summary\n";
	const renderedItems = items.map(({ id, body }) => {
		const start = packText.length;
		packText += `[${id}] ${body}`;
		const end = packText.length;
		packText += "\n";
		return {
			id,
			fingerprint: fingerprint(body),
			spans: [{ start, end }],
		};
	});
	return {
		pack_text: packText,
		rendered_items: renderedItems,
		metrics: {
			total_items: renderedItems.length,
			pack_tokens: Math.ceil(packText.length / 4),
		},
	};
};

const repeatedFact = "REPETITIVE_FACT: use a single writer for the recall ledger.";
const oldFact = "CHANGED_FACT_OLD: retry failed writes twice.";
const updatedFact = "CHANGED_FACT_NEW: retry failed writes three times with jitter.";
const compactionFact = "COMPACTION_FACT: the retained message still consumes allowance.";
const reclaimedFact = "RECLAIMED_FACT: capacity returns only after the host removes the old block.";
const restartFact = "RESTART_FACT: missing recall metadata keeps this candidate eligible.";

const packs = {
	repeated: makePack({ id: 101, body: repeatedFact }),
	changedOld: makePack({ id: 201, body: oldFact }),
	changedNew: makePack({ id: 201, body: updatedFact }),
	compactionInitial: makePack({ id: 301, body: compactionFact }),
	compactionReclaimed: makePack({ id: 302, body: reclaimedFact }),
	restart: makePack({ id: 401, body: restartFact }),
};

const ceilingMarkers = Array.from(
	{ length: 12 },
	(_, index) => `CEILING_FACT_${String(index + 1).padStart(2, "0")}`,
);

for (const [index, marker] of ceilingMarkers.entries()) {
	const filler = `${marker}: distinct retained memory. ${"x".repeat(2680)}`;
	packs[`ceiling${index + 1}`] = makePack({ id: 500 + index, body: filler });
}

const prompt = (id, text, pack, options = {}) => ({
	type: "prompt",
	id,
	text,
	pack,
	...options,
});

export const RETAINED_RECALL_EVAL_FIXTURES = {
	label: "constructed-retained-recall-v1",
	workload_kind: "constructed",
	packs,
	scenarios: [
		{
			id: "repetitive-followups",
			steps: [
				prompt("repeat-1", "Review the recall ledger writer", "repeated"),
				prompt("repeat-2", "continue", "repeated"),
				prompt("repeat-3", "Proceed.", "repeated"),
			],
			expectedFinalMarkers: [repeatedFact],
			expectedNewMarkers: [],
		},
		{
			id: "changed-fact-and-explicit-recall",
			steps: [
				prompt("change-1", "Review retry policy", "changedOld"),
				prompt("change-2", "continue", "changedNew", {
					requiresNewMarkers: [updatedFact],
				}),
				prompt("change-3", "Recall the retry policy explicitly", "changedNew"),
			],
			expectedFinalMarkers: [oldFact, updatedFact],
			expectedNewMarkers: [updatedFact],
		},
		{
			id: "ceiling-pressure",
			steps: ceilingMarkers.map((marker, index) =>
				prompt(
					`ceiling-${index + 1}`,
					`Load distinct retained memory ${index + 1}`,
					`ceiling${index + 1}`,
					{ requiresNewMarkers: [marker] },
				),
			),
			expectedFinalMarkers: ceilingMarkers,
			expectedNewMarkers: ceilingMarkers,
		},
		{
			id: "compaction-evidence",
			retainedBudgetFromPack: "compactionReclaimed",
			steps: [
				prompt("compact-1", "Load compaction policy", "compactionInitial"),
				prompt("compact-2", "Summarize before compaction", "compactionReclaimed", {
					compactionTransform: true,
				}),
				prompt("compact-3", "Load post-compaction policy", "compactionReclaimed", {
					requiresNewMarkers: [reclaimedFact],
				}),
				prompt("compact-4", "Retry post-compaction policy", "compactionReclaimed", {
					retain: ["compact-2", "compact-3"],
					requiresNewMarkers: [reclaimedFact],
				}),
			],
			expectedFinalMarkers: [reclaimedFact],
			expectedNewMarkers: [reclaimedFact],
		},
		{
			id: "restart-missing-metadata",
			steps: [
				prompt("restart-1", "Load restart policy", "restart"),
				{ type: "restart", stripRecallMetadata: true },
				prompt("restart-2", "Recall restart policy again", "restart"),
			],
			expectedFinalMarkers: [restartFact],
			expectedNewMarkers: [],
		},
	],
};
