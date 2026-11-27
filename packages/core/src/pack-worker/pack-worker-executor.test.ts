import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../coordinator-ed25519-key-id-test-fixtures.js";
import { assemblePackArtifacts, type PackArtifacts, type PackAssemblyRequest } from "../pack.js";
import { refreshTestScopeRows } from "../scope-membership-cache-test-fixtures.js";
import { isSemanticIdentityChangedError } from "../semantic/semantic-executor-seam.js";
import { MemoryStore } from "../store.js";
import { type MixedScopeFixture, seedMixedScopeFixture } from "../test-utils.js";
import {
	createPackWorkerExecutor,
	type PackWorkerEvents,
	type PackWorkerExecutor,
	type PackWorkerTransport,
	packMemoryIds,
} from "./pack-worker-executor.js";
import type { PackWorkerRequest } from "./pack-worker-protocol.js";

let dir: string;
let store: MemoryStore;
let fixture: MixedScopeFixture;
let previousConfig: string | undefined;
let executor: PackWorkerExecutor | undefined;

function request(overrides: Partial<PackAssemblyRequest> = {}): PackAssemblyRequest {
	return {
		context: fixture.query,
		limit: 10,
		tokenBudget: 2000,
		filters: { project: "mixed-domain-fixture" },
		semanticResults: [],
		compact: undefined,
		compactDetailCount: undefined,
		compressionMode: "compact",
		automaticContext: undefined,
		...overrides,
	};
}

function usageRows(): number {
	const row = store.db.prepare("SELECT count(*) AS n FROM usage_events WHERE event = 'pack'").get();
	return (row as { n: number }).n;
}

/** A worker that answers each request with what `reply` returns, on the next turn. */
function fakeWorker(reply: (message: PackWorkerRequest & { type: "assemble" }) => unknown) {
	const posted: PackWorkerRequest[] = [];
	const createWorker = (events: PackWorkerEvents): PackWorkerTransport => {
		queueMicrotask(() => events.message({ type: "ready" }));
		return {
			postMessage(message) {
				posted.push(message);
				if (message.type !== "assemble") return;
				const answer = reply(message);
				if (answer) queueMicrotask(() => events.message(answer as never));
			},
			terminate: async () => 0,
		};
	};
	return { posted, createWorker };
}

beforeEach(async () => {
	previousConfig = process.env.CODEMEM_CONFIG;
	dir = mkdtempSync(join(tmpdir(), "codemem-pack-worker-"));
	process.env.CODEMEM_CONFIG = join(dir, "config.json");
	store = new MemoryStore(join(dir, "mem.sqlite"), { keysDir: join(dir, "keys") });
	fixture = seedMixedScopeFixture(store.db, store.deviceId);
	await refreshTestScopeRows(store.db, { [store.deviceId]: CANONICAL_PUBLIC_KEY });
	vi.spyOn(store, "scopeResolutionDeviceContext").mockReturnValue({
		expectedPublicKey: CANONICAL_PUBLIC_KEY,
	});
});

afterEach(async () => {
	await executor?.close();
	executor = undefined;
	vi.restoreAllMocks();
	await store.closeAsync();
	if (previousConfig === undefined) delete process.env.CODEMEM_CONFIG;
	else process.env.CODEMEM_CONFIG = previousConfig;
	rmSync(dir, { recursive: true, force: true });
});

describe("a pack assembled in the worker thread", () => {
	it("equals the pack this thread assembles, and names only visible memories", async () => {
		executor = createPackWorkerExecutor({ store });

		const fromWorker = await executor.assemble(request());
		const fromThisThread = assemblePackArtifacts(store, request());

		expect(fromWorker).toEqual(fromThisThread);
		expect(fromWorker?.response.item_ids.toSorted()).toEqual(fixture.visibleIds.toSorted());
		expect(fromWorker?.response.pack_text).not.toContain(fixture.unauthorizedTitle);
		expect(packMemoryIds(fromWorker as PackArtifacts)).not.toContain(fixture.unauthorizedId);
	}, 30_000);

	it("reads as the Identity in the request, without the device key when none is given", async () => {
		vi.mocked(store.scopeResolutionDeviceContext).mockReturnValue({ expectedPublicKey: undefined });
		executor = createPackWorkerExecutor({ store });

		const fromWorker = await executor.assemble(request());

		// Without the key the coordinator scope is closed to the worker as it is to the store.
		expect(fromWorker?.response.item_ids).toEqual([fixture.personalId]);
		expect(fromWorker).toEqual(assemblePackArtifacts(store, request()));
	}, 30_000);

	it("records no usage itself: the store's async build records it once", async () => {
		store.enablePackWorker();
		const offThread = vi.spyOn(store, "assemblePackOffThread");

		const artifacts = await store.buildMemoryPackWithTraceAsync(fixture.query, 10, 2000, {
			project: "mixed-domain-fixture",
		});

		expect(await offThread.mock.results[0]?.value).toEqual(artifacts);
		expect(artifacts.response.item_ids.toSorted()).toEqual(fixture.visibleIds.toSorted());
		expect(usageRows()).toBe(1);
	}, 30_000);
});

describe("delivery checks on this thread", () => {
	it("refuses a pack when the Identity changed while the worker assembled it", async () => {
		const real = assemblePackArtifacts(store, request());
		const worker = fakeWorker((message) => {
			store.actorId = "local:someone-else";
			return { type: "result", id: message.id, artifacts: real };
		});
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		const outcome = await executor.assemble(request()).then(
			() => "delivered",
			(error: unknown) => error,
		);

		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
	});

	it("refuses a pack when the device key changed while the worker assembled it", async () => {
		const real = assemblePackArtifacts(store, request());
		const worker = fakeWorker((message) => {
			vi.mocked(store.scopeResolutionDeviceContext).mockReturnValue({
				expectedPublicKey: "another-runtime-key",
			});
			return { type: "result", id: message.id, artifacts: real };
		});
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		const outcome = await executor.assemble(request()).then(
			() => "delivered",
			(error: unknown) => error,
		);

		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
	});

	it("refuses when the Identity changed even though the worker failed", async () => {
		const worker = fakeWorker((message) => {
			store.actorId = "local:someone-else";
			return { type: "error", id: message.id, code: "assembly_failed" };
		});
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		const outcome = await executor.assemble(request()).then(
			() => "delivered",
			(error: unknown) => error,
		);

		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
	});

	it("hands back a pack that names a memory the Identity cannot see", async () => {
		const real = assemblePackArtifacts(store, request());
		const withHidden: PackArtifacts = structuredClone(real);
		withHidden.response.item_ids.push(fixture.unauthorizedId);
		const worker = fakeWorker((message) => ({
			type: "result",
			id: message.id,
			artifacts: withHidden,
		}));
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		expect(await executor.assemble(request())).toBeNull();
	});

	it("hands back a pack whose trace names a memory the Identity cannot see", async () => {
		const real = assemblePackArtifacts(store, request());
		const withHidden: PackArtifacts = structuredClone(real);
		withHidden.trace.assembly.trimmed_ids.push(fixture.unauthorizedId);
		const worker = fakeWorker((message) => ({
			type: "result",
			id: message.id,
			artifacts: withHidden,
		}));
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		expect(await executor.assemble(request())).toBeNull();
	});

	it("hands back a pack when access to a memory ended while the worker assembled it", async () => {
		const real = assemblePackArtifacts(store, request());
		const worker = fakeWorker((message) => {
			store.db
				.prepare("DELETE FROM scope_memberships WHERE scope_id = ?")
				.run(fixture.authorizedScopeId);
			return { type: "result", id: message.id, artifacts: real };
		});
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		expect(real.response.item_ids).toContain(fixture.authorizedId);
		expect(await executor.assemble(request())).toBeNull();
	});

	it("sends the worker the Identity and nothing else about the caller", async () => {
		const real = assemblePackArtifacts(store, request());
		const worker = fakeWorker((message) => ({ type: "result", id: message.id, artifacts: real }));
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		await executor.assemble(request());

		expect(worker.posted).toHaveLength(1);
		expect(worker.posted[0]).toMatchObject({
			type: "assemble",
			job: {
				proof: {
					actorId: store.actorId,
					deviceId: store.deviceId,
					expectedPublicKey: CANONICAL_PUBLIC_KEY,
				},
				request: request(),
			},
		});
	});
});

describe("a worker that cannot do the work", () => {
	it("leaves the pack to the caller when no worker can be started", async () => {
		executor = createPackWorkerExecutor({ store, createWorker: () => null });

		expect(await executor.assemble(request())).toBeNull();
		expect(await executor.assemble(request())).toBeNull();
	});

	it("leaves the pack to the caller when the worker reports a failure", async () => {
		const worker = fakeWorker((message) => ({
			type: "error",
			id: message.id,
			code: "assembly_failed",
		}));
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		expect(await executor.assemble(request())).toBeNull();
	});

	it("replaces a worker that does not answer in time, then stops using it", async () => {
		const warn = vi.fn();
		const worker = fakeWorker(() => null);
		const createWorker = vi.fn(worker.createWorker);
		executor = createPackWorkerExecutor({ store, createWorker, requestMs: 20, warn });

		const outcomes = [];
		for (let attempt = 0; attempt < 5; attempt++) outcomes.push(await executor.assemble(request()));

		expect(outcomes).toEqual([null, null, null, null, null]);
		expect(createWorker).toHaveBeenCalledTimes(3);
		expect(warn).toHaveBeenCalledTimes(1);
	});

	it("leaves the pack to the caller when the request is aborted", async () => {
		const worker = fakeWorker(() => null);
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });
		const abort = new AbortController();

		const pending = executor.assemble(request(), { signal: abort.signal });
		await new Promise((resolve) => setTimeout(resolve, 5));
		abort.abort();

		expect(await pending).toBeNull();
	});

	it("builds the pack on this thread through the store when the worker fails", async () => {
		store.enablePackWorker();
		vi.spyOn(store, "assemblePackOffThread").mockResolvedValue(null);

		const artifacts = await store.buildMemoryPackWithTraceAsync(fixture.query, 10, 2000, {
			project: "mixed-domain-fixture",
		});

		expect(artifacts.response.item_ids.toSorted()).toEqual(fixture.visibleIds.toSorted());
		expect(usageRows()).toBe(1);
	});
});

describe("a store that has not enabled the worker", () => {
	it("assembles packs on its own thread", async () => {
		expect(await store.assemblePackOffThread(request())).toBeNull();
	});
});
