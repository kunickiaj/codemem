import { describe, expect, it } from "vitest";
import type { CoordinatorLegacyTeamCompletionManifestV1 } from "./coordinator-legacy-team-completion.js";
import {
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BATCH_BYTES,
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BATCH_RESPONSE_BYTES,
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES,
	COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_RECORDS,
	canonicalCoordinatorLegacyTeamCompletionManifestJson,
	normalizeCoordinatorLegacyTeamCompletionGroupIds,
	normalizeCoordinatorLegacyTeamCompletionManifest,
	requireCoordinatorLegacyTeamCompletionScopeBindings,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamResolvedProjectRef } from "./legacy-team-setup-draft.js";
import { legacyTeamCandidateId, legacyTeamProjectRef } from "./recipient-policy-identifiers.js";

function manifest(): CoordinatorLegacyTeamCompletionManifestV1 {
	return {
		version: 1,
		coordinator_id: "coord-a",
		candidate_ref: "legacy-team-candidate:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		candidate_digest: "a".repeat(64),
		team_id: "team-a",
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Core Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: "identity-b", role: "member" }],
		device_decisions: [
			{
				device_id: "device-b",
				key_fingerprint: "2".repeat(64),
				enabled: true,
				identity_id: "identity-b",
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-09-01T00:00:00.000Z",
	};
}

describe("coordinator legacy Team completion contract", () => {
	it("reserves response-envelope bytes for every maximum-sized batch record", () => {
		expect(COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BATCH_RESPONSE_BYTES).toBeGreaterThanOrEqual(
			COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BATCH_BYTES +
				320 * COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_RECORDS,
		);
	});

	it("canonicalizes collection order for semantic replay", () => {
		const value = manifest();
		value.memberships.unshift({ identity_id: "identity-a", role: "member" });
		value.device_decisions.unshift({
			device_id: "device-a",
			key_fingerprint: "1".repeat(64),
			enabled: true,
			identity_id: "identity-a",
			decision: "included",
		});
		const reversed = { ...value, memberships: value.memberships.toReversed() };

		expect(canonicalCoordinatorLegacyTeamCompletionManifestJson(reversed)).toBe(
			canonicalCoordinatorLegacyTeamCompletionManifestJson(value),
		);
	});

	it("canonicalizes collation-equivalent identifiers without locale-dependent ties", () => {
		const value = {
			...manifest(),
			memberships: [
				{ identity_id: "é", role: "member" as const },
				{ identity_id: "e\u0301", role: "member" as const },
			],
			device_decisions: [
				{
					device_id: "device-composed",
					key_fingerprint: "1".repeat(64),
					enabled: true,
					identity_id: "é",
					decision: "included" as const,
				},
				{
					device_id: "device-decomposed",
					key_fingerprint: "2".repeat(64),
					enabled: true,
					identity_id: "e\u0301",
					decision: "included" as const,
				},
			],
		};

		expect(canonicalCoordinatorLegacyTeamCompletionManifestJson(value)).toBe(
			canonicalCoordinatorLegacyTeamCompletionManifestJson({
				...value,
				memberships: value.memberships.toReversed(),
			}),
		);
	});

	it("rejects a manifest without device decisions", () => {
		expect(() =>
			normalizeCoordinatorLegacyTeamCompletionManifest({
				...manifest(),
				memberships: [],
				device_decisions: [],
			}),
		).toThrow("completion_manifest_invalid");
	});

	it("rejects unknown fields and local artifact paths", () => {
		expect(() =>
			normalizeCoordinatorLegacyTeamCompletionManifest({ ...manifest(), raw_secret: "nope" }),
		).toThrow("completion_manifest_invalid");
		expect(() =>
			normalizeCoordinatorLegacyTeamCompletionManifest({
				...manifest(),
				candidate_ref: "/Users/person/workspace/local.sqlite",
			}),
		).toThrow("completion_manifest_invalid");
	});

	it.each(["../private/team.sqlite", "./.tmp/state", String.raw`\\server\share\state`])(
		"rejects relative and UNC artifact path %s",
		(value) => {
			expect(() =>
				normalizeCoordinatorLegacyTeamCompletionManifest({
					...manifest(),
					coordinator_id: value,
				}),
			).toThrow("completion_manifest_invalid");
		},
	);

	it("requires the viewer legacy Team candidate reference format", () => {
		expect(normalizeCoordinatorLegacyTeamCompletionManifest(manifest()).candidate_ref).toBe(
			"legacy-team-candidate:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		);
		expect(() =>
			normalizeCoordinatorLegacyTeamCompletionManifest({
				...manifest(),
				candidate_ref: "legacy-team:candidate-a",
			}),
		).toThrow("completion_manifest_invalid");
	});

	it("binds zero-Project completions to the coordinator and group", () => {
		const value = {
			...manifest(),
			coordinator_id: "coord-a",
			candidate_ref: legacyTeamCandidateId("coord-a", "group-a"),
		};
		expect(requireCoordinatorLegacyTeamCompletionScopeBindings(value, "group-a", [])).toBe(
			"coord-a",
		);
		expect(() => requireCoordinatorLegacyTeamCompletionScopeBindings(value, "group-b", [])).toThrow(
			"completion_manifest_invalid",
		);
	});

	it("requires canonical opaque Project reference formats", () => {
		expect(() =>
			normalizeCoordinatorLegacyTeamCompletionManifest({
				...manifest(),
				project_mappings: [
					{
						project_ref: "project-a",
						resolved_project_ref: "resolved-a",
						scope_id: "scope-a",
					},
				],
			}),
		).toThrow("completion_manifest_invalid");
	});

	it("rejects included devices outside the reviewed membership set", () => {
		expect(() =>
			normalizeCoordinatorLegacyTeamCompletionManifest({
				...manifest(),
				device_decisions: [
					{
						device_id: "device-x",
						key_fingerprint: "3".repeat(64),
						enabled: true,
						identity_id: "identity-x",
						decision: "included",
					},
				],
			}),
		).toThrow("completion_manifest_invalid");
	});

	it("rejects reviewed memberships without an included device", () => {
		expect(() =>
			normalizeCoordinatorLegacyTeamCompletionManifest({
				...manifest(),
				memberships: [...manifest().memberships, { identity_id: "identity-x", role: "member" }],
			}),
		).toThrow("completion_manifest_invalid");
	});

	it("allows multiple included devices to share one reviewed membership", () => {
		const value = manifest();
		value.device_decisions.push(
			{
				device_id: "device-c",
				key_fingerprint: "3".repeat(64),
				enabled: true,
				identity_id: "identity-b",
				decision: "included",
			},
			{
				device_id: "device-d",
				key_fingerprint: "4".repeat(64),
				enabled: false,
				identity_id: null,
				decision: "excluded",
			},
		);

		expect(normalizeCoordinatorLegacyTeamCompletionManifest(value).memberships).toEqual(
			value.memberships,
		);
	});

	it("requires valid device key and enabled-state evidence", () => {
		const [decision] = manifest().device_decisions;
		if (!decision) throw new Error("test device decision missing");
		const missingFingerprint = {
			device_id: decision.device_id,
			enabled: decision.enabled,
			identity_id: decision.identity_id,
			decision: decision.decision,
		};
		const missingEnabled = {
			device_id: decision.device_id,
			key_fingerprint: decision.key_fingerprint,
			identity_id: decision.identity_id,
			decision: decision.decision,
		};

		for (const invalidDecision of [
			missingFingerprint,
			missingEnabled,
			{ ...decision, key_fingerprint: "" },
			{ ...decision, key_fingerprint: "1".repeat(63) },
			{ ...decision, key_fingerprint: "1".repeat(65) },
			{ ...decision, key_fingerprint: "G".repeat(64) },
			{ ...decision, enabled: 1 },
			{ ...decision, enabled: false },
			{ ...decision, raw_public_key: "test-public-key" },
		]) {
			expect(() =>
				normalizeCoordinatorLegacyTeamCompletionManifest({
					...manifest(),
					device_decisions: [invalidDecision],
				}),
			).toThrow("completion_manifest_invalid");
		}
	});

	it("preserves device key and enabled-state evidence in canonical output", () => {
		const normalized = normalizeCoordinatorLegacyTeamCompletionManifest(manifest());

		expect(normalized.device_decisions[0]).toEqual({
			device_id: "device-b",
			key_fingerprint: "2".repeat(64),
			enabled: true,
			identity_id: "identity-b",
			decision: "included",
		});
	});

	it("allows disabled evidence for an excluded device", () => {
		const value = manifest();
		const [decision] = value.device_decisions;
		if (!decision) throw new Error("test device decision missing");
		value.device_decisions = [
			{
				...decision,
				enabled: false,
				identity_id: null,
				decision: "excluded",
			},
		];
		value.memberships = [];

		expect(normalizeCoordinatorLegacyTeamCompletionManifest(value).device_decisions[0]).toEqual(
			value.device_decisions[0],
		);
	});

	it("requires one Team recipient edge for every mapped Project", () => {
		const projectRefA = legacyTeamProjectRef(manifest().candidate_ref, "project-a");
		const projectRefB = legacyTeamProjectRef(manifest().candidate_ref, "project-b");
		const resolvedProjectRef = legacyTeamResolvedProjectRef(projectRefA, "resolved-a");
		const value = {
			...manifest(),
			project_mappings: [
				{ project_ref: projectRefA, resolved_project_ref: resolvedProjectRef, scope_id: "scope-a" },
			],
		};
		expect(() => normalizeCoordinatorLegacyTeamCompletionManifest(value)).toThrow(
			"completion_manifest_invalid",
		);
		const normalized = normalizeCoordinatorLegacyTeamCompletionManifest({
			...value,
			project_mappings: [
				...value.project_mappings,
				{ project_ref: projectRefB, resolved_project_ref: resolvedProjectRef, scope_id: "scope-a" },
			],
			project_recipients: [{ resolved_project_ref: resolvedProjectRef, team_id: value.team_id }],
		});
		expect(normalized.project_mappings).toHaveLength(2);
		expect(normalized.project_recipients).toHaveLength(1);
		expect(() =>
			normalizeCoordinatorLegacyTeamCompletionManifest({
				...value,
				project_mappings: [
					...value.project_mappings,
					{
						project_ref: projectRefB,
						resolved_project_ref: resolvedProjectRef,
						scope_id: "scope-b",
					},
				],
				project_recipients: [{ resolved_project_ref: resolvedProjectRef, team_id: value.team_id }],
			}),
		).toThrow("completion_manifest_invalid");
	});

	it("bounds and deduplicates configured group reads", () => {
		expect(normalizeCoordinatorLegacyTeamCompletionGroupIds(["group-b", "group-a"])).toEqual([
			"group-a",
			"group-b",
		]);
		expect(() => normalizeCoordinatorLegacyTeamCompletionGroupIds(["group-a", "group-a"])).toThrow(
			"completion_manifest_invalid",
		);
		expect(() =>
			normalizeCoordinatorLegacyTeamCompletionGroupIds(
				Array.from({ length: 51 }, (_, index) => `group-${index}`),
			),
		).toThrow("completion_manifest_invalid");
	});

	it("accepts a maximum-size setup manifest with bounded identifiers", () => {
		const boundedId = (prefix: string, index: number) =>
			`${prefix}-${String(index).padStart(3, "0")}`.padEnd(256, "x");
		const teamId = "team".padEnd(256, "x");
		const memberships = Array.from({ length: 500 }, (_, index) => ({
			identity_id: boundedId("identity", index),
			role: "member" as const,
		}));
		const deviceDecisions = memberships.map((membership, index) => ({
			device_id: boundedId("device", index),
			key_fingerprint: index.toString(16).padStart(64, "0"),
			enabled: true,
			identity_id: membership.identity_id,
			decision: "included" as const,
		}));
		const projectMappings = Array.from({ length: 500 }, (_, index) => {
			const projectRef = legacyTeamProjectRef(
				manifest().candidate_ref,
				boundedId("project", index),
			);
			return {
				project_ref: projectRef,
				resolved_project_ref: legacyTeamResolvedProjectRef(
					projectRef,
					boundedId("resolved", index),
				),
				scope_id: boundedId("scope", index),
			};
		});
		const projectRecipients = projectMappings.map((mapping) => ({
			resolved_project_ref: mapping.resolved_project_ref,
			team_id: teamId,
		}));
		const value = normalizeCoordinatorLegacyTeamCompletionManifest({
			...manifest(),
			team_id: teamId,
			memberships,
			device_decisions: deviceDecisions,
			project_mappings: projectMappings,
			project_recipients: projectRecipients,
		});

		expect(new TextEncoder().encode(JSON.stringify(value)).byteLength).toBeLessThanOrEqual(
			COORDINATOR_LEGACY_TEAM_COMPLETION_MAX_BYTES,
		);
	});
});
