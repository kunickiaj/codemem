import { describe, expect, it } from "vitest";
import {
	canonicalRecipientReviewedIntentJson,
	normalizeRecipientReviewedIntent,
	parseStoredRecipientReviewedIntent,
	recipientReviewedIntentDigest,
	verifyRecipientReviewedIntent,
} from "./recipient-reviewed-intent.js";

const PROJECT_A = "git:https://example.test/acme/alpha";
const PROJECT_B = "git:https://example.test/acme/beta";

function teamIntent() {
	return {
		version: 1,
		journey: "team",
		team: { teamId: "team-core", displayName: "Core Team", futureProjectsInherit: true },
		projects: [
			{
				canonicalProjectIdentity: PROJECT_B,
				displayName: "Beta",
				existingMemoryCount: 2,
				futureMemoriesShared: true,
				sources: [{ kind: "team", teamId: "team-core", displayName: "Core Team" }],
			},
			{
				canonicalProjectIdentity: PROJECT_A,
				displayName: "Alpha",
				existingMemoryCount: 3,
				futureMemoriesShared: true,
				sources: [
					{ kind: "team", teamId: "team-z", displayName: "Zeta" },
					{ kind: "team", teamId: "team-core", displayName: "Core Team" },
				],
			},
		],
		excludedProjects: [
			{
				canonicalProjectIdentity: "git:https://example.test/acme/excluded",
				displayName: "Excluded",
				existingMemoryCount: 1,
			},
		],
	};
}

function addDeviceIntent() {
	return {
		version: 1,
		journey: "add_device",
		targetIdentity: { identityId: "identity-ada", displayName: "Ada" },
		projects: [
			{
				canonicalProjectIdentity: PROJECT_A,
				displayName: "Alpha",
				existingMemoryCount: 3,
				futureMemoriesShared: true,
				sources: [{ kind: "direct" }],
			},
		],
		excludedProjects: [],
	};
}

describe("recipient reviewed intent", () => {
	it("normalizes valid Team and add-device reviewed intents", () => {
		const team = normalizeRecipientReviewedIntent(teamIntent());
		const addDevice = normalizeRecipientReviewedIntent(addDeviceIntent());

		expect(team).toMatchObject({ version: 1, journey: "team", team: { teamId: "team-core" } });
		expect(addDevice).toMatchObject({
			version: 1,
			journey: "add_device",
			targetIdentity: { identityId: "identity-ada" },
		});
	});

	it("canonicalizes project and source ordering before digesting", async () => {
		const reversed = teamIntent();
		reversed.projects.reverse();
		reversed.projects[1]?.sources.reverse();

		expect(canonicalRecipientReviewedIntentJson(reversed)).toBe(
			canonicalRecipientReviewedIntentJson(teamIntent()),
		);
		expect(await recipientReviewedIntentDigest(reversed)).toBe(
			await recipientReviewedIntentDigest(teamIntent()),
		);
	});

	it("accepts more than 100 presentation-only excluded Projects within the byte limit", () => {
		const input = {
			...teamIntent(),
			excludedProjects: Array.from({ length: 101 }, (_, index) => ({
				canonicalProjectIdentity: `git:excluded-${index}`,
				displayName: `Excluded ${index}`,
				existingMemoryCount: index,
			})),
		};

		expect(normalizeRecipientReviewedIntent(input).excludedProjects).toHaveLength(101);
	});

	it.each([
		["unknown version", { ...teamIntent(), version: 2 }],
		["missing Team", { ...teamIntent(), team: undefined }],
		[
			"negative memory count",
			{ ...teamIntent(), projects: [{ ...teamIntent().projects[0], existingMemoryCount: -1 }] },
		],
		[
			"overlong target Identity display name",
			{
				...addDeviceIntent(),
				targetIdentity: { identityId: "identity-ada", displayName: "a".repeat(121) },
			},
		],
		[
			"duplicate included Project",
			{ ...teamIntent(), projects: [teamIntent().projects[0], teamIntent().projects[0]] },
		],
		[
			"included and excluded Project overlap",
			{ ...teamIntent(), excludedProjects: [{ ...teamIntent().projects[0] }] },
		],
		[
			"duplicate source",
			{
				...teamIntent(),
				projects: [
					{
						...teamIntent().projects[0],
						sources: [teamIntent().projects[0]?.sources[0], teamIntent().projects[0]?.sources[0]],
					},
				],
			},
		],
	])("rejects malformed or duplicate input: %s", (_label, input) => {
		expect(() => normalizeRecipientReviewedIntent(input)).toThrow(
			"recipient_reviewed_intent_invalid",
		);
	});

	it("rejects invitation target mismatches", () => {
		expect(() =>
			normalizeRecipientReviewedIntent(teamIntent(), {
				kind: "team_member",
				policyTeamId: "team-other",
			}),
		).toThrow("recipient_invite_intent_mismatch");
		expect(() =>
			normalizeRecipientReviewedIntent(addDeviceIntent(), {
				kind: "add_device",
				targetIdentityId: "identity-other",
			}),
		).toThrow("recipient_invite_intent_mismatch");
	});

	it("rejects digest mismatches", async () => {
		await expect(
			verifyRecipientReviewedIntent(teamIntent(), {
				target: { kind: "team_member", policyTeamId: "team-core" },
				digest: "0".repeat(64),
			}),
		).rejects.toThrow("recipient_invite_intent_mismatch");
	});

	it("fails closed for missing or malformed stored snapshots", async () => {
		const options = {
			target: { kind: "team_member" as const, policyTeamId: "team-core" },
			digest: await recipientReviewedIntentDigest(teamIntent()),
		};

		await expect(parseStoredRecipientReviewedIntent(null, options)).rejects.toThrow(
			"recipient_invite_review_unavailable",
		);
		await expect(parseStoredRecipientReviewedIntent("{", options)).rejects.toThrow(
			"recipient_invite_review_unavailable",
		);
		await expect(
			parseStoredRecipientReviewedIntent(JSON.stringify(teamIntent(), null, 2), options),
		).rejects.toThrow("recipient_invite_review_unavailable");
	});
});
