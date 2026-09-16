import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("runtime import boundaries", () => {
	it("keeps recipient policy onboarding independent of share operations", () => {
		const source = readFileSync(new URL("recipient-policy-onboarding.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/from ["']\.\/share-operation\.js["']/);
	});

	it("keeps legacy project identity rules below inventory and projection", () => {
		const inventorySource = readFileSync(
			new URL("local-project-inventory.ts", import.meta.url),
			"utf8",
		);
		const projectionSource = readFileSync(
			new URL("legacy-recipient-policy-projection.ts", import.meta.url),
			"utf8",
		);
		expect(inventorySource).not.toMatch(/from ["']\.\/legacy-recipient-policy-projection\.js["']/);
		expect(projectionSource).not.toMatch(/from ["']\.\/legacy-team-project-policy\.js["']/);
	});

	it("keeps coordinator config and peer storage below their consumers", () => {
		const actionSource = readFileSync(new URL("coordinator-actions.ts", import.meta.url), "utf8");
		const discoverySource = readFileSync(new URL("sync-discovery.ts", import.meta.url), "utf8");
		const cacheSource = readFileSync(new URL("scope-membership-cache.ts", import.meta.url), "utf8");
		const runtimeSource = readFileSync(new URL("coordinator-runtime.ts", import.meta.url), "utf8");
		expect(actionSource).not.toMatch(/from ["']\.\/sync-discovery\.js["']/);
		expect(discoverySource).not.toMatch(/from ["']\.\/coordinator-runtime\.js["']/);
		expect(cacheSource).not.toMatch(/from ["']\.\/coordinator-runtime\.js["']/);
		expect(runtimeSource).not.toMatch(/from ["']\.\/sync-discovery\.js["']/);
	});
});
