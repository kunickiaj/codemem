import { describe, expect, it } from "vitest";

import { teamCardOverview } from "./team-card";

describe("coordinator admin Team card helpers", () => {
	it("summarizes a newly created default Space without exposing raw IDs", () => {
		expect(
			teamCardOverview({
				groupId: "team-alpha",
				setupGuide: {
					groupId: "team-alpha",
					displayName: "Team Alpha",
					defaultSpaceScopeId: "team:team-alpha:default",
					defaultSpaceLabel: "Team Alpha",
					autoGrantDefaultSpaceOnJoin: true,
					setupWarning: null,
				},
			}),
		).toMatchObject({
			autoGrant: "On for the default Space",
			defaultSpace: "Team Alpha",
		});
	});

	it("ignores setup guide state for a different Team", () => {
		expect(
			teamCardOverview({
				groupId: "team-beta",
				setupGuide: {
					groupId: "team-alpha",
					displayName: "Team Alpha",
					defaultSpaceScopeId: "team:team-alpha:default",
					defaultSpaceLabel: "Team Alpha",
					autoGrantDefaultSpaceOnJoin: true,
					setupWarning: null,
				},
			}),
		).toMatchObject({
			autoGrant: "Open Team defaults to inspect",
			defaultSpace: "Open Team defaults to inspect",
		});
	});

	it("shows conservative migrated Team defaults when preferences are loaded", () => {
		expect(
			teamCardOverview({
				groupId: "team-beta",
				preferences: {
					projects_include: [],
					projects_exclude: [],
					auto_seed_scope: true,
					default_space_scope_id: "",
					auto_grant_default_space_on_join: false,
					loaded: true,
					saving: false,
					error: "",
				},
			}),
		).toMatchObject({
			autoGrant: "Off — Space access stays explicit",
			defaultSpace: "Not configured",
		});
	});

	it("trusts loaded preferences over stale setup guide state", () => {
		expect(
			teamCardOverview({
				groupId: "team-alpha",
				preferences: {
					projects_include: [],
					projects_exclude: [],
					auto_seed_scope: true,
					default_space_scope_id: "",
					auto_grant_default_space_on_join: false,
					loaded: true,
					saving: false,
					error: "",
				},
				setupGuide: {
					groupId: "team-alpha",
					displayName: "Team Alpha",
					defaultSpaceScopeId: "team:team-alpha:default",
					defaultSpaceLabel: "Team Alpha",
					autoGrantDefaultSpaceOnJoin: true,
					setupWarning: null,
				},
			}),
		).toMatchObject({
			autoGrant: "Off — Space access stays explicit",
			defaultSpace: "Not configured",
		});
	});

	it("counts active Spaces when the Spaces drawer has loaded", () => {
		expect(
			teamCardOverview({
				groupId: "team-gamma",
				scopeManagement: {
					loaded: true,
					loading: false,
					error: "",
					includeInactive: false,
					devicesLoaded: false,
					scopes: [{ status: "active" }, { status: "archived" }, {}],
					membersByScope: new Map(),
					devices: [],
					createScopeId: "",
					createLabel: "",
					createKind: "",
					actionPendingKey: "",
					actionPendingKind: "",
				},
			}),
		).toMatchObject({ spaces: "2 active Spaces" });
	});
});
