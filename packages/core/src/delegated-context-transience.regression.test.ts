import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DELEGATED_BRIEF_LABEL } from "./capture-context.js";
import { type IngestOptions, ingest } from "./ingest-pipeline.js";
import { MemoryStore } from "./store.js";

describe("delegated observer context lifetime", () => {
	it("passes prior briefs to the observer without persisting them in session metadata", async () => {
		// Arrange
		const directory = mkdtempSync(join(tmpdir(), "codemem-delegated-transience-"));
		const store = new MemoryStore(join(directory, "test.sqlite"));
		const brief = "Inspect retry ownership; report only observed findings.";
		const observe = vi.fn(async () => ({
			raw: `<observation><type>discovery</type><title>Queue ownership is explicit</title><narrative>The pending queue retains retry entries after invalidation.</narrative><facts><fact>Retry entries remain in the pending queue.</fact></facts><concepts><concept>how-it-works</concept></concepts></observation>`,
			parsed: null,
			provider: "test",
			model: "fixture",
		}));
		const options = {
			observer: {
				observe,
				getStatus: () => ({
					provider: "test",
					model: "fixture",
					runtime: "test",
					auth: { source: "none", type: "none", hasToken: false },
				}),
			},
		} as unknown as IngestOptions;

		try {
			// Act
			await ingest(
				{
					cwd: "/fixture",
					project: "fixture",
					events: [
						{
							type: "tool.execute.after",
							tool: "read",
							args: { filePath: "/fixture/src/queue.ts" },
							result: "The pending queue retains retry entries after invalidation.",
						},
					],
					sessionContext: {
						flusher: "raw_events",
						source: "opencode",
						streamId: "child",
						opencodeSessionId: "child",
						firstPrompt: "Report the queue finding.",
						promptCount: 1,
						toolCount: 1,
						delegatedBriefs: [brief],
					},
				},
				store,
				options,
			);

			// Assert
			const observerInput = observe.mock.calls[0]?.[1] ?? "";
			const row = store.db.prepare("SELECT metadata_json FROM sessions LIMIT 1").get() as {
				metadata_json: string;
			};
			const metadata = JSON.parse(row.metadata_json) as {
				session_context?: Record<string, unknown>;
			};
			expect({
				observerHasBrief: observerInput.includes(brief),
				observerHasLabel: observerInput.includes(DELEGATED_BRIEF_LABEL),
				durableBriefs: metadata.session_context?.delegatedBriefs,
			}).toEqual({
				observerHasBrief: true,
				observerHasLabel: true,
				durableBriefs: undefined,
			});
		} finally {
			store.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
