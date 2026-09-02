import { describe, expect, it, vi } from "vitest";
import { coordinatorListLegacyTeamCompletionsAction } from "./coordinator-actions.js";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import {
	deterministicPolicyTeamId,
	legacyTeamCandidateId,
} from "./recipient-policy-identifiers.js";

function manifest(groupId = "group-a"): CoordinatorLegacyTeamCompletionManifestV1 {
	const candidateRef = legacyTeamCandidateId("coord-a", groupId);
	return {
		version: 1,
		coordinator_id: "coord-a",
		candidate_ref: candidateRef,
		candidate_digest: "a".repeat(64),
		team_id: deterministicPolicyTeamId(candidateRef),
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Core Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: "identity-a", role: "member" }],
		device_decisions: [
			{
				device_id: "device-a",
				key_fingerprint: "1".repeat(64),
				enabled: true,
				identity_id: "identity-a",
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-09-01T00:00:00.000Z",
	};
}

describe("coordinator completion actions", () => {
	it("classifies an invalid remote batch manifest as a malformed response", async () => {
		const winner = manifest();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					items: [{ group_id: "group-a", manifest: { ...winner, team_digest: "invalid" } }],
				}),
			),
		);

		await expect(
			coordinatorListLegacyTeamCompletionsAction({
				groupIds: ["group-a"],
				remoteUrl: "https://coordinator.example.test",
				adminSecret: "test-secret",
			}),
		).rejects.toThrow("coordinator_completion_response_malformed");
	});

	it("rejects duplicate winners in a remote completion batch", async () => {
		const winner = manifest();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							items: [
								{ group_id: "group-a", manifest: winner },
								{ group_id: "group-a", manifest: winner },
							],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		await expect(
			coordinatorListLegacyTeamCompletionsAction({
				groupIds: ["group-a"],
				remoteUrl: "https://coordinator.example.test",
				adminSecret: "test-secret",
			}),
		).rejects.toThrow("coordinator_completion_response_malformed");
	});

	it("rejects a remote completion batch whose Team is not derived from its candidate", async () => {
		const winner = manifest();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							items: [{ group_id: "group-a", manifest: { ...winner, team_id: "team-other" } }],
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					),
			),
		);

		await expect(
			coordinatorListLegacyTeamCompletionsAction({
				groupIds: ["group-a"],
				remoteUrl: "https://coordinator.example.test",
				adminSecret: "test-secret",
			}),
		).rejects.toThrow("coordinator_completion_response_malformed");
	});

	it("rejects a remote completion batch whose candidate belongs to another group", async () => {
		const winner = manifest("group-b");
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify({ items: [{ group_id: "group-a", manifest: winner }] }), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					}),
			),
		);

		await expect(
			coordinatorListLegacyTeamCompletionsAction({
				groupIds: ["group-a"],
				remoteUrl: "https://coordinator.example.test",
				adminSecret: "test-secret",
			}),
		).rejects.toThrow("coordinator_completion_response_malformed");
	});
});
