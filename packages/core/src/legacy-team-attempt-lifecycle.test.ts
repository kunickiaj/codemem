import { describe, expect, it } from "vitest";
import { planLegacyTeamAttempt } from "./legacy-team-attempt-lifecycle.js";

describe("planLegacyTeamAttempt", () => {
	it.each([
		[{ state: null, evidenceMatches: false, completionReady: false }, "create"],
		[{ state: null, evidenceMatches: true, completionReady: true }, "create"],
		[{ state: "needs_setup", evidenceMatches: true, completionReady: false }, "reuse"],
		[{ state: "needs_setup", evidenceMatches: false, completionReady: false }, "replace"],
		[{ state: "needs_setup", evidenceMatches: true, completionReady: true }, "reuse"],
		[{ state: "needs_setup", evidenceMatches: false, completionReady: true }, "replace"],
		[{ state: "in_progress", evidenceMatches: true, completionReady: false }, "reuse"],
		[{ state: "in_progress", evidenceMatches: false, completionReady: false }, "replace"],
		[{ state: "in_progress", evidenceMatches: true, completionReady: true }, "reuse"],
		[{ state: "in_progress", evidenceMatches: false, completionReady: true }, "replace"],
		[{ state: "stale", evidenceMatches: true, completionReady: false }, "replace"],
		[{ state: "stale", evidenceMatches: false, completionReady: false }, "replace"],
		[{ state: "stale", evidenceMatches: true, completionReady: true }, "replace"],
		[{ state: "stale", evidenceMatches: false, completionReady: true }, "replace"],
		[{ state: "completed", evidenceMatches: true, completionReady: true }, "preserve_completion"],
		[{ state: "completed", evidenceMatches: false, completionReady: true }, "preserve_completion"],
		[{ state: "completed", evidenceMatches: true, completionReady: false }, "replace"],
		[{ state: "completed", evidenceMatches: false, completionReady: false }, "replace"],
	] as const)("plans %s as %s", (input, expected) => {
		expect(planLegacyTeamAttempt(input).kind).toBe(expected);
	});
});
