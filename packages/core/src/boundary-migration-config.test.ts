import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBoundaryMigrationMode } from "./coordinator-sync-config.js";
import { getCodememEnvOverrides } from "./observer-config.js";
import { LOCAL_SYNC_FEATURES } from "./sync-capability.js";

beforeEach(() => vi.stubEnv("CODEMEM_SYNC_BOUNDARY_MIGRATION", undefined));
afterEach(() => vi.unstubAllEnvs());

describe("the boundary migration rollout mode", () => {
	it.each(["off", "report", "on"] as const)("reads the saved mode %s", (mode) => {
		expect(readBoundaryMigrationMode({ sync_boundary_migration: mode })).toBe(mode);
	});

	it.each([undefined, null, "", "unknown", true, false, 1, [], {}].map((value) => [value]))(
		"defaults to off for %j",
		(value) => {
			expect(readBoundaryMigrationMode({ sync_boundary_migration: value })).toBe("off");
		},
	);

	it("normalizes case and surrounding spaces", () => {
		expect(readBoundaryMigrationMode({ sync_boundary_migration: " Report " })).toBe("report");
	});

	it.each(["off", "report", "on"] as const)("lets the environment select %s", (mode) => {
		vi.stubEnv("CODEMEM_SYNC_BOUNDARY_MIGRATION", mode);

		expect(readBoundaryMigrationMode({ sync_boundary_migration: "on" })).toBe(mode);
		expect(getCodememEnvOverrides().sync_boundary_migration).toBe(
			"CODEMEM_SYNC_BOUNDARY_MIGRATION",
		);
	});

	it("disables migration for an invalid nonempty environment value", () => {
		vi.stubEnv("CODEMEM_SYNC_BOUNDARY_MIGRATION", "not-a-mode");

		expect(readBoundaryMigrationMode({ sync_boundary_migration: "on" })).toBe("off");
	});

	it("retains the saved mode when the environment value is empty", () => {
		vi.stubEnv("CODEMEM_SYNC_BOUNDARY_MIGRATION", "");

		expect(readBoundaryMigrationMode({ sync_boundary_migration: "report" })).toBe("report");
		expect(getCodememEnvOverrides().sync_boundary_migration).toBeUndefined();
	});

	it("does not advertise migration readiness before the adoption code exists", () => {
		vi.stubEnv("CODEMEM_SYNC_BOUNDARY_MIGRATION", "on");

		expect(readBoundaryMigrationMode({})).toBe("on");
		expect(LOCAL_SYNC_FEATURES).not.toContain("project_boundary_migration_v1");
	});
});
