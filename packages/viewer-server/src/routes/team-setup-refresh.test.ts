import {
	getLegacyTeamSetupDraft,
	type LegacyTeamConfiguredGroupSnapshot,
	legacyTeamCandidateId,
	MemoryStore,
} from "@codemem/core";
import { describe, expect, it, vi } from "vitest";
import { teamSetupRoutes } from "./team-setup.js";

describe("Team setup refresh snapshots", () => {
	it("rejects snapshots when the attempt completes during loading", async () => {
		const store = new MemoryStore(":memory:");
		let resolveSnapshots!: (snapshots: LegacyTeamConfiguredGroupSnapshot[]) => void;
		const coordinatorId = "https://coordinator.example.test";
		const groupId = "group-alpha";
		const candidateRef = legacyTeamCandidateId(coordinatorId, groupId);
		const loadSnapshots = vi.fn(
			() =>
				new Promise<LegacyTeamConfiguredGroupSnapshot[]>((resolve) => {
					resolveSnapshots = resolve;
				}),
		);
		const app = teamSetupRoutes({
			getStore: () => store,
			loadLegacyTeamConfiguredGroupSnapshots: loadSnapshots,
		});
		try {
			store.db
				.prepare(
					`INSERT INTO legacy_team_setup_drafts(
					 attempt_id, candidate_id, coordinator_id, group_id, state, display_name,
					 roster_fingerprint, projection_fingerprint, created_at, updated_at
					 ) VALUES ('attempt-alpha', ?, ?, ?,
					 'in_progress', 'Alpha', 'roster-alpha', 'projection-alpha', ?, ?)`,
				)
				.run(
					candidateRef,
					coordinatorId,
					groupId,
					"2026-08-28T00:00:00.000Z",
					"2026-08-28T00:00:00.000Z",
				);
			const refresh = app.request(`/api/sync/team-setup/v1/${candidateRef}/refresh`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			await vi.waitFor(() => expect(loadSnapshots).toHaveBeenCalledOnce());
			store.db
				.prepare(
					`UPDATE legacy_team_setup_drafts
					 SET state = 'completed', completed_at = ?, updated_at = ?
					 WHERE attempt_id = 'attempt-alpha'`,
				)
				.run("2026-08-28T00:01:00.000Z", "2026-08-28T00:01:00.000Z");
			resolveSnapshots([
				{
					coordinatorId,
					groupId,
					displayName: "Alpha",
					devices: [],
				},
			]);

			const response = await refresh;
			expect(response.status).toBe(409);
			expect(await response.json()).toEqual({ error: "team_setup_confirmation_stale" });
			expect(getLegacyTeamSetupDraft(store.db, candidateRef)?.state).toBe("completed");
		} finally {
			store.close();
		}
	});
});
