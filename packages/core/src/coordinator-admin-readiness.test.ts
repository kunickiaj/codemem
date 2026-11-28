import { describe, expect, it } from "vitest";
import {
	type CoordinatorSyncConfig,
	coordinatorAdminReadiness,
	isCoordinatorAdminDevice,
	readCoordinatorSyncConfig,
} from "./coordinator-sync-config.js";

/** Coordinator settings that do not depend on the environment or a config file. */
function settings(
	overrides: { url?: string; groups?: string[]; adminSecret?: string } = {},
): CoordinatorSyncConfig {
	const groups = overrides.groups ?? [];
	return {
		...readCoordinatorSyncConfig({}),
		syncCoordinatorUrl: overrides.url ?? "",
		syncCoordinatorGroup: groups[0] ?? "",
		syncCoordinatorGroups: groups,
		syncCoordinatorAdminSecret: overrides.adminSecret ?? "",
	};
}

const URL = "https://coord.example.test";
const NO_COORDINATOR = settings();
const MEMBER = settings({ url: URL, groups: ["group-a"] });
const ADMIN = settings({ url: URL, groups: ["group-a"], adminSecret: "fixture-admin-secret" });

describe("coordinator admin readiness", () => {
	it.each([
		["no URL", NO_COORDINATOR, "not_configured", false],
		[
			"a secret and a group but no URL",
			settings({ groups: ["group-a"], adminSecret: "fixture-admin-secret" }),
			"not_configured",
			false,
		],
		["a URL and a group but no secret", MEMBER, "partial", false],
		[
			"a URL and a secret but no group",
			settings({ url: URL, adminSecret: "fixture-admin-secret" }),
			"partial",
			false,
		],
		["a URL, a group, and the secret", ADMIN, "ready", true],
	] as const)("%s is %s", (_name, config, readiness, adminDevice) => {
		expect(coordinatorAdminReadiness(config)).toBe(readiness);
		expect(isCoordinatorAdminDevice(config)).toBe(adminDevice);
	});
});
