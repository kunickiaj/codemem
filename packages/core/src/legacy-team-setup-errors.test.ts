import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGACY_TEAM_SETUP_ERROR_REASONS } from "./legacy-team-setup-errors.js";

describe("legacy Team setup diagnostic reasons", () => {
	it("keeps the exported reason vocabulary stable", () => {
		expect(LEGACY_TEAM_SETUP_ERROR_REASONS).toEqual([
			"coordinator_route_missing",
			"coordinator_rejected_manifest",
			"coordinator_unreachable",
			"local_candidate_scan_budget_exceeded",
			"coordinator_roster_unavailable",
		]);
	});

	it("matches the UI client's hand-maintained copy of the vocabulary", () => {
		// packages/ui cannot import @codemem/core, so it restates this set. Read
		// the UI source here (Node side) so adding a reason in core without
		// mirroring it in the client fails the build instead of degrading the
		// client's parse to `undefined`.
		const uiSource = readFileSync(new URL("../../ui/src/lib/api/sync.ts", import.meta.url), "utf8");
		const setLiteral =
			/export const LEGACY_TEAM_SETUP_ERROR_REASONS = new Set<LegacyTeamSetupErrorReason>\(\[([\s\S]*?)\]\);/u.exec(
				uiSource,
			)?.[1];
		if (!setLiteral) throw new Error("UI Team setup reason vocabulary missing");
		const uiReasons = [...setLiteral.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);

		expect(uiReasons).toEqual([...LEGACY_TEAM_SETUP_ERROR_REASONS]);
	});
});
