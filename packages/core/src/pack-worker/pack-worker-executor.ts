/**
 * Assembles prompt packs in a worker thread and decides on this thread whether each one
 * may be delivered.
 *
 * Assembling a pack is synchronous SQL and blocked the process that serves requests for
 * about 200 ms per pack. The worker does that part on its own read-only connection.
 *
 * Who may see what is decided twice. The worker reads as the Identity in the proof this
 * thread captured before asking. When the reply arrives, this thread checks that its
 * Identity, its device key, the Identity generation persisted in the store and the store
 * file are still the ones it captured, and that every memory the pack names is visible to
 * that Identity and not forgotten. A pack that fails the first check is never delivered.
 * One that fails the second is assembled again on this thread.
 *
 * The store file is the one the store identified when it opened its connection. The worker
 * opens the same path later, so both sides compare the path with that identity.
 *
 * The worker is an optimisation: when it cannot start, fails or is too slow, the caller
 * assembles the pack itself, as it did before.
 */
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { type DatabaseFileIdentity, isDatabaseFileUnchanged } from "../database-file-identity.js";
import { readLocalIdentityGenerationMarker } from "../local-identity-generation.js";
import type { PackArtifacts, PackAssemblyRequest } from "../pack.js";
import { packArtifactMemoryIds } from "../pack-memory-ids.js";
import type { StoreHandle } from "../search.js";
import { SemanticIdentityChangedError } from "../semantic/semantic-executor-seam.js";
import { captureProof } from "../semantic/semantic-worker-executor.js";
import type {
	PackWorkerData,
	PackWorkerJob,
	PackWorkerProof,
	PackWorkerReply,
	PackWorkerRequest,
} from "./pack-worker-protocol.js";

export interface PackWorkerStore extends StoreHandle {
	hasCurrentIdentity(): boolean;
	onIdentityChanged?(listener: () => void): () => void;
	/** Which of these memories may be delivered to the current Identity: visible and not forgotten. */
	deliverableMemoryIds(memoryIds: readonly number[]): Set<number>;
	/** The file the store's connection opened, identified when it opened it. */
	databaseFile(): DatabaseFileIdentity | null;
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

/** Start the worker thread for the store file. Null when this process cannot start one. */
export function startPackWorkerThread(
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
		// A refusal is the worker working: its view of the store did not match the proof.
		if (reply.code === "refused") return;
		this.countFailure("could not assemble a pack");
		if (!this.usable) this.dropWorker();
	}

	/** Drop the worker thread after it failed. Waiting packs go back to their callers. */
	private fail(what: string): void {
		this.dropWorker();
		this.countFailure(what);
	}

	private dropWorker(): void {
		const transport = this.transport;
		this.transport = null;
		this.ready = null;
		this.finishAll();
		void transport?.terminate().catch(() => undefined);
	}

	private countFailure(what: string): void {
		if (this.closed) return;
		this.consecutiveFailures += 1;
		if (this.consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
			this.options.warn(
				`codemem: the prompt pack worker ${what}, the last of ${MAX_CONSECUTIVE_FAILURES} failures in a row; packs are assembled on the main thread until restart.`,
			);
		}
	}

	private finishAll(): void {
		for (const entry of [...this.pending.values()]) entry.finish(null);
	}
}

/**
 * Whether the pack may go to the store's current Identity: every memory it or its trace
 * names is visible to that Identity and not forgotten. A pack with no complete inventory
 * of the memories it names may not.
 */
function mayDeliver(store: PackWorkerStore, artifacts: PackArtifacts): boolean {
	const ids = packArtifactMemoryIds(artifacts);
	if (!ids) return false;
	const deliverable = store.deliverableMemoryIds(ids);
	return ids.every((id) => deliverable.has(id));
}

/**
 * Who this thread is now. Throws when a switch has committed in the store to another
 * Identity than this process runs as: the configuration may not name the new one yet, and
 * until it does the process still looks current to itself.
 */
function captureDeliveryProof(store: PackWorkerStore): PackWorkerProof {
	const proof: PackWorkerProof = {
		...captureProof(store),
		identityGeneration: readLocalIdentityGenerationMarker(store.db),
	};
	if (proof.identityGeneration && proof.identityGeneration.actorId !== proof.actorId) {
		throw new SemanticIdentityChangedError();
	}
	return proof;
}

function assertProofUnchanged(store: PackWorkerStore, proof: PackWorkerProof): void {
	if (JSON.stringify(captureDeliveryProof(store)) !== JSON.stringify(proof)) {
		throw new SemanticIdentityChangedError();
	}
}

/** The path must still lead to the file the store's connection opened. */
function assertStoreFileUnchanged(opened: DatabaseFileIdentity): void {
	if (!isDatabaseFileUnchanged(opened)) throw new SemanticIdentityChangedError();
}

/** The owner must await close() before closing its store. */
export function createPackWorkerExecutor(options: PackWorkerOptions): PackWorkerExecutor {
	const { store } = options;
	const opened = store.databaseFile();
	if (!opened) throw new Error("pack_worker_file_required");
	const client = new PackWorkerClient({
		createWorker:
			options.createWorker ??
			((events) =>
				startPackWorkerThread({ dbPath: opened.path, fileIdentity: opened.fileIdentity }, events)),
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
			const proof = captureDeliveryProof(store);
			assertStoreFileUnchanged(opened);
			const artifacts = await client.run({ proof, request }, executionOptions?.signal);
			// Checked whether or not the worker answered: after an Identity change the caller
			// must not assemble and deliver this request under the new Identity either.
			assertProofUnchanged(store, proof);
			assertStoreFileUnchanged(opened);
			if (generation !== requestGeneration) throw new SemanticIdentityChangedError();
			if (!artifacts || !mayDeliver(store, artifacts)) return null;
			return artifacts;
		},
		async close() {
			await client.close();
			unsubscribe?.();
		},
	};
}
