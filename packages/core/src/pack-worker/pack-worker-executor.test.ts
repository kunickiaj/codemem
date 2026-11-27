import { mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_PUBLIC_KEY } from "../coordinator-ed25519-key-id-test-fixtures.js";
import { ensureLocalIdentitySwitchSchema } from "../local-identity-switch.js";
import { assemblePackArtifacts, type PackArtifacts, type PackAssemblyRequest } from "../pack.js";
import { packArtifactMemoryIds } from "../pack-memory-ids.js";
import { refreshTestScopeRows } from "../scope-membership-cache-test-fixtures.js";
import { isSemanticIdentityChangedError } from "../semantic/semantic-executor-seam.js";
import { MemoryStore } from "../store.js";
import { type MixedScopeFixture, seedMixedScopeFixture } from "../test-utils.js";
import {
	createPackWorkerExecutor,
	type PackWorkerEvents,
	type PackWorkerExecutor,
	type PackWorkerTransport,
	startPackWorkerThread,
} from "./pack-worker-executor.js";
import type { PackWorkerReply, PackWorkerRequest } from "./pack-worker-protocol.js";

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

/** A memory of this device in the default scope and its own project, found by `deltaonly`. */
function memoryInItsOwnProject(): number {
	const session = store.db
		.prepare(
			`INSERT INTO sessions(started_at, cwd, project, user, tool_version, metadata_json)
			 VALUES ('2026-04-03T00:00:00.000Z', '/tmp/delta', 'delta-project', 'test-user', 'test', '{}')`,
		)
		.run();
	const memory = store.db
		.prepare(
			`INSERT INTO memory_items(
				session_id, kind, title, body_text, confidence, tags_text, active, created_at,
				updated_at, metadata_json, rev, visibility, scope_id, import_key
			 ) VALUES (?, 'discovery', 'Delta project memory', 'deltaonly context', 0.9, '', 1,
				'2026-04-03T00:00:01.000Z', '2026-04-03T00:00:01.000Z', '{}', 1, 'shared',
				'local-default', 'fixture-memory-delta')`,
		)
		.run(session.lastInsertRowid);
	return Number(memory.lastInsertRowid);
}

/** A pack that names only the memory in its own project. */
function ownProjectRequest(): PackAssemblyRequest {
	return request({ context: "deltaonly", filters: { project: "delta-project" } });
}

/** What a local Identity switch commits in the store before the configuration follows. */
function commitSwitchInStore(actorId: string): void {
	ensureLocalIdentitySwitchSchema(store.db);
	store.db
		.prepare(
			`INSERT INTO local_identity_generation (id, generation, actor_id, updated_at)
			 VALUES (1, 1, ?, '2026-04-03T00:00:00.000Z')
			 ON CONFLICT(id) DO UPDATE SET generation = generation + 1, actor_id = excluded.actor_id`,
		)
		.run(actorId);
}

function outcomeOf(pending: Promise<unknown>): Promise<unknown> {
	return pending.then(
		(delivered) => delivered,
		(error: unknown) => error,
	);
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
		expect(packArtifactMemoryIds(fromWorker as PackArtifacts)).not.toContain(
			fixture.unauthorizedId,
		);
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
					identityGeneration: null,
				},
				request: request(),
			},
		});
	});
});

describe("a memory forgotten while the worker assembled the pack", () => {
	it("is not delivered", async () => {
		const real = assemblePackArtifacts(store, request());
		const worker = fakeWorker((message) => {
			store.forget(fixture.personalId);
			return { type: "result", id: message.id, artifacts: real };
		});
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		expect(real.response.item_ids).toContain(fixture.personalId);
		expect(await executor.assemble(request())).toBeNull();
	});

	it("is not delivered when only the trace names it", async () => {
		const ownProjectId = memoryInItsOwnProject();
		const real = assemblePackArtifacts(store, ownProjectRequest());
		const withTrimmed: PackArtifacts = structuredClone(real);
		withTrimmed.trace.assembly.trimmed_ids.push(fixture.personalId);
		const worker = fakeWorker((message) => {
			store.forget(fixture.personalId);
			return { type: "result", id: message.id, artifacts: withTrimmed };
		});
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		expect(real.response.item_ids).toEqual([ownProjectId]);
		expect(await executor.assemble(ownProjectRequest())).toBeNull();
	});

	it("is not among the memories the store calls deliverable", () => {
		store.forget(fixture.personalId);

		const deliverable = store.deliverableMemoryIds(fixture.allIds);

		expect([...deliverable]).toEqual([fixture.authorizedId]);
		// `get` still returns the forgotten memory to its owner.
		expect(store.get(fixture.personalId)?.active).toBe(0);
	});
});

describe("a memory named only in the change from the previous pack", () => {
	it("keeps the pack back when access to it ended before delivery", async () => {
		const ownProjectId = memoryInItsOwnProject();
		const real = assemblePackArtifacts(store, ownProjectRequest());
		const withRemoved: PackArtifacts = structuredClone(real);
		// The previous pack had the coordinator-scope memory; this one does not.
		withRemoved.response.metrics.removed_ids.push(fixture.authorizedId);
		const worker = fakeWorker((message) => {
			store.db
				.prepare("DELETE FROM scope_memberships WHERE scope_id = ?")
				.run(fixture.authorizedScopeId);
			return { type: "result", id: message.id, artifacts: withRemoved };
		});
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		expect(real.response.item_ids).toEqual([ownProjectId]);
		expect(await executor.assemble(ownProjectRequest())).toBeNull();
	});
});

describe("a local Identity switch that committed in the store only", () => {
	it("refuses a pack that was in flight when the switch committed", async () => {
		const real = assemblePackArtifacts(store, request());
		const worker = fakeWorker((message) => {
			// The configuration still names the old Identity, so the process looks current.
			commitSwitchInStore("local:switched-to");
			return { type: "result", id: message.id, artifacts: real };
		});
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		const outcome = await outcomeOf(executor.assemble(request()));

		expect(store.hasCurrentIdentity()).toBe(true);
		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
	});

	it("is refused by the worker too, whose connection sees another generation than the proof", async () => {
		const opened = store.databaseFile();
		if (!opened) throw new Error("the store did not identify its file");
		const replies: PackWorkerReply[] = [];
		executor = createPackWorkerExecutor({
			store,
			createWorker: (events) =>
				startPackWorkerThread(
					{ opened },
					{
						...events,
						message(reply) {
							replies.push(reply);
							events.message(reply);
						},
					},
				),
		});

		const pending = outcomeOf(executor.assemble(request()));
		// The proof is captured and the thread is still starting when the switch commits.
		commitSwitchInStore("local:switched-to");
		const outcome = await pending;

		expect(replies).toContainEqual({ type: "error", id: 1, code: "refused" });
		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
	}, 30_000);

	it("refuses a pack when the switch commits while its memories are checked for delivery", async () => {
		const real = assemblePackArtifacts(store, request());
		const worker = fakeWorker((message) => ({ type: "result", id: message.id, artifacts: real }));
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });
		const check = store.deliverableMemoryIds.bind(store);
		vi.spyOn(store, "deliverableMemoryIds").mockImplementation((ids) => {
			const deliverable = check(ids);
			commitSwitchInStore("local:switched-to");
			return deliverable;
		});

		const outcome = await outcomeOf(executor.assemble(request()));

		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
	});

	it("refuses a pack assembled on this thread after the worker was given up", async () => {
		const failing = fakeWorker((message) => ({
			type: "error",
			id: message.id,
			code: "assembly_failed",
		}));
		executor = createPackWorkerExecutor({
			store,
			createWorker: failing.createWorker,
			warn: () => {},
		});
		const worker = executor;
		store.enablePackWorker();
		vi.spyOn(store, "assemblePackOffThread").mockImplementation((packRequest, options) =>
			worker.assemble(packRequest, options),
		);
		const build = () =>
			store.buildMemoryPackWithTraceAsync(fixture.query, 10, 2000, {
				project: "mixed-domain-fixture",
			});
		// Three failures: the worker is no longer asked, and this thread assembles each pack.
		for (let attempt = 0; attempt < 4; attempt++) await build();
		const askedBeforeSwitch = failing.posted.length;

		commitSwitchInStore("local:switched-to");
		const outcome = await outcomeOf(build());

		expect(askedBeforeSwitch).toBe(3);
		expect(failing.posted).toHaveLength(3);
		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
		expect(usageRows()).toBe(4);
	});

	it("refuses a pack this thread assembles after a switch committed during the request", async () => {
		store.enablePackWorker();
		// The worker declines, and the switch commits before this thread assembles the pack.
		vi.spyOn(store, "assemblePackOffThread").mockImplementation(async () => {
			commitSwitchInStore("local:switched-to");
			return null;
		});

		const outcome = await outcomeOf(
			store.buildMemoryPackWithTraceAsync(fixture.query, 10, 2000, {
				project: "mixed-domain-fixture",
			}),
		);

		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
		expect(usageRows()).toBe(0);
	});

	it("refuses before asking the worker when the switch had already committed", async () => {
		const real = assemblePackArtifacts(store, request());
		const worker = fakeWorker((message) => ({ type: "result", id: message.id, artifacts: real }));
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });
		commitSwitchInStore("local:switched-to");

		const outcome = await outcomeOf(executor.assemble(request()));

		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
		expect(worker.posted).toEqual([]);
	});

	it("sends the worker the generation the store has persisted", async () => {
		commitSwitchInStore(store.actorId);
		const real = assemblePackArtifacts(store, request());
		const worker = fakeWorker((message) => ({ type: "result", id: message.id, artifacts: real }));
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker });

		const delivered = await executor.assemble(request());

		expect(delivered).toEqual(real);
		expect(worker.posted[0]).toMatchObject({
			job: { proof: { identityGeneration: { generation: 1, actorId: store.actorId } } },
		});
	});
});

describe("a store file replaced after the store opened it", () => {
	it("refuses the pack: the worker would read another database with the same memory IDs", async () => {
		const otherDir = mkdtempSync(join(tmpdir(), "codemem-pack-worker-other-"));
		const otherPath = join(otherDir, "mem.sqlite");
		const other = new MemoryStore(otherPath, { keysDir: join(otherDir, "keys") });
		seedMixedScopeFixture(other.db, other.deviceId);
		await refreshTestScopeRows(other.db, { [other.deviceId]: CANONICAL_PUBLIC_KEY });
		other.db
			.prepare("UPDATE memory_items SET title = 'Replacement ' || id, body_text = ?")
			.run(`${fixture.query} replacement contents`);
		other.db.pragma("wal_checkpoint(TRUNCATE)");
		await other.closeAsync();
		// The store keeps its file open. The path now leads to the other database.
		renameSync(otherPath, store.dbPath);
		rmSync(`${store.dbPath}-wal`, { force: true });
		rmSync(`${store.dbPath}-shm`, { force: true });
		rmSync(otherDir, { recursive: true, force: true });
		store.enablePackWorker();

		const outcome = await outcomeOf(
			store.buildMemoryPackWithTraceAsync(fixture.query, 10, 2000, {
				project: "mixed-domain-fixture",
			}),
		);

		expect(isSemanticIdentityChangedError(outcome)).toBe(true);
		expect(JSON.stringify(outcome)).not.toContain("Replacement");
	}, 30_000);
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

	it("stops using a worker after three packs in a row that it could not assemble", async () => {
		const warn = vi.fn();
		let asked = 0;
		// Two refusals first. They are answers about the request and do not count.
		const worker = fakeWorker((message) => ({
			type: "error",
			id: message.id,
			code: asked++ < 2 ? "refused" : "assembly_failed",
		}));
		executor = createPackWorkerExecutor({ store, createWorker: worker.createWorker, warn });

		const outcomes = [];
		for (let attempt = 0; attempt < 7; attempt++) outcomes.push(await executor.assemble(request()));

		expect(outcomes).toEqual([null, null, null, null, null, null, null]);
		expect(worker.posted.filter((message) => message.type === "assemble")).toHaveLength(5);
		expect(warn).toHaveBeenCalledTimes(1);
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
