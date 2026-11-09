import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const coordinatorImports = vi.hoisted(() => ({
	store: vi.fn(() => {
		throw new Error("semantic worker must not load coordinator storage");
	}),
	implementation: vi.fn(() => {
		throw new Error("semantic worker must not load the coordinator implementation");
	}),
}));

vi.mock("./coordinator-store.js", coordinatorImports.store);
vi.mock("./better-sqlite-coordinator-store.js", coordinatorImports.implementation);
vi.mock("node:worker_threads", () => ({ parentPort: null, workerData: undefined }));

describe("runtime import boundaries", () => {
	it("loads semantic worker ranking without coordinator storage", async () => {
		// Arrange: forbidden runtime imports throw, including transitive imports.
		// Act
		const ranking = await import("./semantic/semantic-worker-ranking.js");
		// Assert: type-only coordinator contracts may remain in the read path.
		expect(ranking.rankWorkerInput).toBeTypeOf("function");
		expect(coordinatorImports.store).not.toHaveBeenCalled();
		expect(coordinatorImports.implementation).not.toHaveBeenCalled();
	});

	it("reaches the semantic worker parent-port check without loading coordinator storage", async () => {
		// Arrange: the mocked worker environment has no parent port, regardless of Vitest's pool.
		// Act
		const startup = import("./semantic/semantic-worker-job.js");
		// Assert: the real job's imports must finish before its expected startup failure.
		await expect(startup).rejects.toThrow("semantic_worker_parent_required");
		expect(coordinatorImports.store).not.toHaveBeenCalled();
		expect(coordinatorImports.implementation).not.toHaveBeenCalled();
	});

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

	it("keeps schema bootstrap independent of database connection orchestration", () => {
		const source = readFileSync(new URL("schema-bootstrap.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/from ["']\.\/db\.js["']/);
	});
});
