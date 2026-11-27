/**
 * Assembles prompt packs in a worker thread and decides on this thread whether each one
 * may be delivered.
 *
 * Assembling a pack is synchronous SQL and blocked the process that serves requests for
 * about 200 ms per pack. The worker does that part on its own read-only connection.
 *
 * Who may see what is decided twice. The worker reads as the Identity in the proof this
 * thread captured before asking. When the reply arrives, this thread checks that its
 * Identity, its device key and its store file are still the ones it captured, and that
 * every memory the pack names is visible to that Identity now. A pack that fails the first
 * check is never delivered. One that fails the second is assembled again on this thread.
 *
 * The worker is an optimisation: when it cannot start, fails or is too slow, the caller
 * assembles the pack itself, as it did before.
 */
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { PackArtifacts, PackAssemblyRequest } from "../pack.js";
import type { StoreHandle } from "../search.js";
import { SemanticIdentityChangedError } from "../semantic/semantic-executor-seam.js";
import {
	assertCompletion,
	assertDatabaseIdentity,
	captureProof,
	fileIdentity,
} from "../semantic/semantic-worker-executor.js";
import type {
	PackWorkerData,
	PackWorkerJob,
	PackWorkerReply,
	PackWorkerRequest,
} from "./pack-worker-protocol.js";

export interface PackWorkerStore extends StoreHandle {
	hasCurrentIdentity(): boolean;
	onIdentityChanged?(listener: () => void): () => void;
	/** Which of these memories the store's current Identity may see. */
	visibleMemoryIds(memoryIds: readonly number[]): Set<number>;
}

export interface PackWorkerTransport {
	postMessage(message: PackWorkerRequest): void;
	terminate(): Promise<number>;
}

export interface PackWorkerEvents {
	message(reply: PackWorkerReply): void;
	failure(error: Error): void;
	exit(code: number): void;
}

export interface PackWorkerOptions {
	store: PackWorkerStore;
	/** How long the worker may take to start, and to assemble one pack. */
	readinessMs?: number;
	requestMs?: number;
	/** Packs waiting for the worker beyond this many are assembled by the caller. */
	maxPending?: number;
	/** Fault injection for tests; returns null when no worker can be started. */
	createWorker?: (events: PackWorkerEvents) => PackWorkerTransport | null;
	warn?: (message: string) => void;
}

export interface PackWorkerExecutor {
	/** The pack, checked for delivery, or null when the caller should assemble it. */
	assemble(
		request: PackAssemblyRequest,
		options?: { signal?: AbortSignal },
	): Promise<PackArtifacts | null>;
	close(): Promise<void>;
}

/** After this many failures in a row the worker is not used again in this process. */
const MAX_CONSECUTIVE_FAILURES = 3;

function tsxLoaderUrl(): string | null {
	try {
		return pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
	} catch {
		return null;
	}
}

/** The parent's `--conditions` flags, so the worker resolves packages as the parent does. */
function conditionFlags(execArgv: readonly string[]): string[] {
	const flags: string[] = [];
	for (let index = 0; index < execArgv.length; index++) {
		const flag = execArgv[index] ?? "";
		if (flag === "--conditions" || flag === "-C") flags.push(flag, execArgv[index + 1] ?? "");
		else if (flag.startsWith("--conditions=")) flags.push(flag);
	}
	return flags;
}

/**
 * Where the worker's code is and how to start it. An installed package runs the built file
 * beside this module. From source, `store.ts` and what it imports use TypeScript syntax
 * that Node cannot strip, so the thread is started through the tsx loader. Without tsx
 * there is no worker.
 */
function workerEntry(): { url: URL; execArgv: string[] } | null {
	const fromSource = import.meta.url.endsWith(".ts");
	// The name is computed so that the bundler leaves the URL alone. These sibling files
	// are separate build entries, and a literal here would be inlined as an asset.
	const entryName = fromSource ? "./pack-worker-entry.ts" : "./pack-worker-entry.js";
	const url = new URL(entryName, import.meta.url);
	if (!fromSource) return { url, execArgv: [] };
	const loader = tsxLoaderUrl();
	if (!loader) return null;
	return { url, execArgv: ["--import", loader, ...conditionFlags(process.execArgv)] };
}

function startWorkerThread(
	workerData: PackWorkerData,
	events: PackWorkerEvents,
): PackWorkerTransport | null {
	const entry = workerEntry();
	if (!entry) return null;
	const worker = new Worker(entry.url, {
		workerData,
		// The request names the Identity; the worker inherits no settings or credentials.
		env: {},
		execArgv: entry.execArgv,
	});
	worker.on("message", (reply: PackWorkerReply) => {
		if (!reply || !["ready", "result", "error"].includes(reply.type)) {
			events.failure(new Error("invalid_pack_worker_reply"));
			return;
		}
		events.message(reply);
	});
	worker.on("error", events.failure);
	worker.on("exit", events.exit);
	return worker;
}

interface PendingJob {
	finish(artifacts: PackArtifacts | null): void;
	timer: ReturnType<typeof setTimeout>;
}

/** One worker thread and the packs waiting for it. Every failure resolves to null. */
class PackWorkerClient {
	private transport: PackWorkerTransport | null = null;
	private ready: Promise<boolean> | null = null;
	private readonly pending = new Map<number, PendingJob>();
	private nextId = 1;
	private consecutiveFailures = 0;
	private closed = false;

	constructor(
		private readonly options: {
			createWorker: (events: PackWorkerEvents) => PackWorkerTransport | null;
			readinessMs: number;
			requestMs: number;
			maxPending: number;
			warn: (message: string) => void;
		},
	) {}

	get usable(): boolean {
		return !this.closed && this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES;
	}

	async run(job: PackWorkerJob, signal?: AbortSignal): Promise<PackArtifacts | null> {
		if (!this.usable || this.pending.size >= this.options.maxPending) return null;
		if (!(await this.start()) || signal?.aborted) return null;
		const transport = this.transport;
		if (!transport) return null;
		const id = this.nextId++;
		return new Promise((resolve) => {
			const finish = (artifacts: PackArtifacts | null) => {
				const entry = this.pending.get(id);
				if (!entry) return;
				this.pending.delete(id);
				clearTimeout(entry.timer);
				signal?.removeEventListener("abort", abandon);
				resolve(artifacts);
			};
			const abandon = () => finish(null);
			// A worker that is still busy after the limit is replaced, not waited for.
			const timer = setTimeout(() => this.fail("timed out"), this.options.requestMs);
			this.pending.set(id, { finish, timer });
			signal?.addEventListener("abort", abandon, { once: true });
			transport.postMessage({
				type: "assemble",
				id,
				deadlineAt: Date.now() + this.options.requestMs,
				job,
			});
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		const transport = this.transport;
		this.transport = null;
		this.ready = null;
		this.finishAll();
		if (!transport) return;
		try {
			transport.postMessage({ type: "close" });
		} catch {
			// The thread is already gone.
		}
		await transport.terminate().catch(() => undefined);
	}

	private start(): Promise<boolean> {
		if (this.ready) return this.ready;
		this.ready = new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => {
				this.fail("did not start");
				resolve(false);
			}, this.options.readinessMs);
			const settle = (started: boolean) => {
				clearTimeout(timer);
				resolve(started);
			};
			let transport: PackWorkerTransport | null = null;
			try {
				transport = this.options.createWorker({
					message: (reply) => {
						if (this.transport !== transport) return;
						if (reply.type === "ready") settle(true);
						else this.settle(reply);
					},
					failure: () => {
						if (this.transport !== transport) return;
						this.fail("failed");
						settle(false);
					},
					exit: () => {
						if (this.transport !== transport) return;
						this.fail("exited");
						settle(false);
					},
				});
			} catch {
				transport = null;
			}
			this.transport = transport;
			if (!transport) {
				// Nothing to retry: this process cannot start the worker at all.
				this.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
				this.ready = null;
				settle(false);
			}
		});
		return this.ready;
	}

	private settle(reply: Exclude<PackWorkerReply, { type: "ready" }>): void {
		const entry = this.pending.get(reply.id);
		if (!entry) return;
		if (reply.type === "result") {
			this.consecutiveFailures = 0;
			entry.finish(reply.artifacts);
			return;
		}
		entry.finish(null);
	}

	/** Drop the worker thread. Waiting packs go back to their callers. */
	private fail(what: string): void {
		const transport = this.transport;
		this.transport = null;
		this.ready = null;
		this.finishAll();
		void transport?.terminate().catch(() => undefined);
		if (this.closed) return;
		this.consecutiveFailures += 1;
		if (this.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
			this.options.warn(
				`codemem: the prompt pack worker ${what} ${MAX_CONSECUTIVE_FAILURES} times in a row; packs are assembled on the main thread until restart.`,
			);
		}
	}

	private finishAll(): void {
		for (const entry of [...this.pending.values()]) entry.finish(null);
	}
}

function addIds(into: Set<number>, ids: readonly unknown[] | undefined): void {
	for (const id of ids ?? []) into.add(Number(id));
}

/** Every memory a pack names, in what is delivered and in its trace. */
export function packMemoryIds(artifacts: PackArtifacts): number[] {
	const ids = new Set<number>();
	const { response, trace } = artifacts;
	addIds(ids, response.item_ids);
	addIds(
		ids,
		response.items.map((item) => item.id),
	);
	addIds(
		ids,
		trace.retrieval.candidates.map((candidate) => candidate.id),
	);
	addIds(ids, trace.assembly.deduped_ids);
	addIds(ids, trace.assembly.trimmed_ids);
	for (const group of trace.assembly.collapsed_groups) addIds(ids, [group.kept, ...group.dropped]);
	for (const cluster of trace.assembly.compressed_clusters) {
		addIds(ids, [cluster.representative_id, ...cluster.compressed_ids]);
	}
	for (const section of Object.values(trace.assembly.sections)) addIds(ids, section);
	return [...ids];
}

/** Whether the store's current Identity may see every memory the pack names. */
function everyMemoryVisible(store: PackWorkerStore, artifacts: PackArtifacts): boolean {
	const ids = packMemoryIds(artifacts);
	if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) return false;
	const visible = store.visibleMemoryIds(ids);
	return ids.every((id) => visible.has(id));
}

/** The owner must await close() before closing its store. */
export function createPackWorkerExecutor(options: PackWorkerOptions): PackWorkerExecutor {
	const { store } = options;
	if (!isAbsolute(store.db.name) || store.db.name === ":memory:") {
		throw new Error("pack_worker_file_required");
	}
	const dbPath = realpathSync(store.db.name);
	const identity = fileIdentity(dbPath);
	const client = new PackWorkerClient({
		createWorker:
			options.createWorker ??
			((events) => startWorkerThread({ dbPath, fileIdentity: identity }, events)),
		readinessMs: options.readinessMs ?? 10_000,
		requestMs: options.requestMs ?? 10_000,
		maxPending: options.maxPending ?? 8,
		warn: options.warn ?? console.warn,
	});
	let generation = 0;
	const unsubscribe = store.onIdentityChanged?.(() => {
		generation++;
	});
	return {
		async assemble(request, executionOptions) {
			if (!client.usable) return null;
			const requestGeneration = generation;
			const proof = captureProof(store);
			assertDatabaseIdentity(store, dbPath, identity);
			const artifacts = await client.run({ proof, request }, executionOptions?.signal);
			// Checked whether or not the worker answered: after an Identity change the caller
			// must not assemble and deliver this request under the new Identity either.
			assertCompletion(store, proof, dbPath, identity);
			if (generation !== requestGeneration) throw new SemanticIdentityChangedError();
			if (!artifacts || !everyMemoryVisible(store, artifacts)) return null;
			return artifacts;
		},
		async close() {
			await client.close();
			unsubscribe?.();
		},
	};
}
