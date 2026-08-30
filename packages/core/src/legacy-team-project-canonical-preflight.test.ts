import { describe, expect, it } from "vitest";
import {
	isLegacyTeamProjectCanonicalStateValid,
	type LegacyTeamProjectCanonicalPreflightInput,
} from "./legacy-team-project-canonical-preflight.js";

const PROJECT = "project-a";
const SOURCE = "source-a";
const TEAM = "team-a";

const BASELINE: LegacyTeamProjectCanonicalPreflightInput = {
	teamId: TEAM,
	scopeIds: ["scope-active"],
	groupScopeIds: ["scope-active", "scope-historical"],
	projects: [
		{
			sourceProjectIdentity: SOURCE,
			resolvedProjectIdentity: PROJECT,
			targetScopeId: "scope-active",
		},
	],
	mappings: [],
	recipients: [],
};

describe("legacy Team Project canonical preflight", () => {
	it.each([
		{
			name: "accepts the valid baseline",
			overrides: {},
			expected: true,
		},
		{
			name: "rejects a reviewed target that is no longer active",
			overrides: { scopeIds: [] },
			expected: false,
		},
		{
			name: "rejects an unresolved Project identity defensively",
			overrides: {
				projects: [
					{
						sourceProjectIdentity: SOURCE,
						resolvedProjectIdentity: null,
						targetScopeId: "scope-active",
					},
				],
			},
			expected: false,
		},
		{
			name: "rejects a synthetic workspace identity defensively",
			overrides: {
				projects: [
					{
						sourceProjectIdentity: SOURCE,
						resolvedProjectIdentity: "personal:actor-a",
						targetScopeId: "scope-active",
					},
				],
			},
			expected: false,
		},
		{
			name: "accepts multiple active scopes when Project evidence selects one",
			overrides: {
				scopeIds: ["scope-active", "scope-active-2"],
				groupScopeIds: ["scope-active", "scope-active-2", "scope-historical"],
			},
			expected: true,
		},
		{
			name: "rejects missing per-Project scope evidence",
			overrides: {
				scopeIds: ["scope-active", "scope-active-2"],
				groupScopeIds: ["scope-active", "scope-active-2", "scope-historical"],
				projects: [
					{
						sourceProjectIdentity: SOURCE,
						resolvedProjectIdentity: PROJECT,
						targetScopeId: null,
					},
				],
			},
			expected: false,
		},
		{
			name: "accepts multiple scopes when a current mapping selects one",
			overrides: {
				scopeIds: ["scope-active", "scope-active-2"],
				groupScopeIds: ["scope-active", "scope-active-2", "scope-historical"],
				projects: [
					{
						sourceProjectIdentity: SOURCE,
						resolvedProjectIdentity: PROJECT,
						targetScopeId: "scope-active-2",
					},
				],
				mappings: [
					{
						workspaceIdentity: PROJECT,
						projectPattern: SOURCE,
						scopeId: "scope-active-2",
						source: "user",
					},
				],
			},
			expected: true,
		},
		{
			name: "rejects a foreign mapping for the source pattern",
			overrides: {
				mappings: [
					{
						workspaceIdentity: "project-foreign",
						projectPattern: SOURCE,
						scopeId: "scope-foreign",
						source: "user",
					},
				],
			},
			expected: false,
		},
		{
			name: "accepts an own setup mapping in a historical group scope",
			overrides: {
				mappings: [
					{
						workspaceIdentity: "project-prior-resolution",
						projectPattern: SOURCE,
						scopeId: "scope-historical",
						source: "reviewed_team_setup",
					},
				],
			},
			expected: true,
		},
		{
			name: "rejects an active foreign Team recipient",
			overrides: {
				recipients: [
					{
						canonicalProjectIdentity: PROJECT,
						recipientKind: "team",
						recipientId: "team-foreign",
						status: "active",
					},
				],
			},
			expected: false,
		},
		{
			name: "accepts an active direct Identity recipient",
			overrides: {
				recipients: [
					{
						canonicalProjectIdentity: PROJECT,
						recipientKind: "identity",
						recipientId: "identity-a",
						status: "active",
					},
				],
			},
			expected: true,
		},
		{
			name: "rejects an unsupported active recipient kind",
			overrides: {
				recipients: [
					{
						canonicalProjectIdentity: PROJECT,
						recipientKind: "service",
						recipientId: "service-a",
						status: "active",
					},
				],
			},
			expected: false,
		},
		{
			name: "ignores a revoked unsupported recipient",
			overrides: {
				recipients: [
					{
						canonicalProjectIdentity: PROJECT,
						recipientKind: "service",
						recipientId: "service-a",
						status: "revoked",
					},
				],
			},
			expected: true,
		},
	] satisfies Array<{
		name: string;
		overrides: Partial<LegacyTeamProjectCanonicalPreflightInput>;
		expected: boolean;
	}>)("$name", ({ overrides, expected }) => {
		expect(isLegacyTeamProjectCanonicalStateValid({ ...BASELINE, ...overrides })).toBe(expected);
	});
});
