import { describe, expect, it } from "vitest";
import { isMigratableLegacyTeamProjectIdentity } from "./legacy-team-project-policy.js";

describe("isMigratableLegacyTeamProjectIdentity", () => {
	it.each([
		"shared",
		"shared:default",
		"shared:legacy",
		"personal:actor-1",
	])("rejects synthetic workspace identity %s", (identity) => {
		expect(isMigratableLegacyTeamProjectIdentity(identity)).toBe(false);
	});

	it.each([
		"shared:team",
		"shared:workspace-only",
		"https://example.invalid/project.git",
	])("accepts canonical Project identity %s", (identity) => {
		expect(isMigratableLegacyTeamProjectIdentity(identity)).toBe(true);
	});
});
