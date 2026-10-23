import type {
	RankInput,
	RankOutput,
	WorkerReply,
	WorkerRequest,
} from "./semantic-worker-protocol.js";

export interface WorkerEvents {
	message(message: WorkerReply): void;
	failure(error: Error): void;
	exit(code: number): void;
}

export interface WorkerTransport {
	postMessage(message: WorkerRequest): void;
	terminate(): Promise<number>;
}

export interface QueueOptions {
	createWorker(events: WorkerEvents): WorkerTransport;
	maxPending?: number;
	readinessMs?: number;
	requestMs?: number;
	shutdownMs?: number;
	onCircuitOpen?(code: SemanticWorkerErrorCode): void;
}

export type SemanticWorkerErrorCode =
	| "overloaded"
	| "expired"
	| "aborted"
	| "not_ready"
	| "worker_failed"
	| "closed";

export class SemanticWorkerError extends Error {
	constructor(readonly code: SemanticWorkerErrorCode) {
		super(`semantic_worker_${code}`);
	}
}

export interface SemanticWorkerQueue {
	run(
		prepare: () => Promise<RankInput | null>,
		options?: { signal?: AbortSignal },
	): Promise<RankOutput | null>;
	close(): Promise<void>;
}

interface Job {
	id: number;
	deadlineAt: number;
	prepare: () => Promise<RankInput | null>;
	settled: boolean;
	started: boolean;
	dispatched: boolean;
	finish(value: RankOutput | null, error?: unknown): void;
}

function duration(value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) throw new Error("invalid_worker_duration");
	return value;
}

/** Single native job, including embedding preparation. Caller cancellation is not SQL cancellation. */
export function createSemanticWorkerQueue(options: QueueOptions): SemanticWorkerQueue {
	const readinessMs = duration(options.readinessMs, 5_000);
	const requestMs = duration(options.requestMs, 15_000);
	const shutdownMs = duration(options.shutdownMs, 5_000);
	const maxPending = options.maxPending ?? 4;
	if (!Number.isSafeInteger(maxPending) || maxPending < 0)
		throw new Error("invalid_worker_queue_limit");
	return new WorkerQueue({ ...options, maxPending, readinessMs, requestMs, shutdownMs });
}

type ResolvedOptions = Required<Omit<QueueOptions, "onCircuitOpen">> &
	Pick<QueueOptions, "onCircuitOpen">;

class WorkerQueue implements SemanticWorkerQueue {
	private worker: WorkerTransport | undefined;
	private ready = false;
	private exited = false;
	private closing = false;
	private circuit: SemanticWorkerErrorCode | undefined;
	private pending: Job[] = [];
	private active: Job | undefined;
	private nextId = 0;
	private readinessTimer: ReturnType<typeof setTimeout> | undefined;
	private shutdownTimer: ReturnType<typeof setTimeout> | undefined;
	private termination: Promise<number> | undefined;
	private closePromise: Promise<void> | undefined;
	private joined: (() => void) | undefined;
	private preparation: Promise<void> | undefined;

	constructor(private readonly options: ResolvedOptions) {}

	run(prepare: Job["prepare"], options: { signal?: AbortSignal } = {}): Promise<RankOutput | null> {
		if (this.closing) return Promise.reject(new SemanticWorkerError("closed"));
		if (this.circuit) return Promise.reject(new SemanticWorkerError(this.circuit));
		if (options.signal?.aborted) return Promise.reject(new SemanticWorkerError("aborted"));
		if (this.active && this.pending.length >= this.options.maxPending) {
			return Promise.reject(new SemanticWorkerError("overloaded"));
		}
		return new Promise((resolve, reject) => {
			const job = this.createJob(prepare, options.signal, resolve, reject);
			if (this.active) this.pending.push(job);
			else this.active = job;
			this.startWorker();
			this.pump();
		});
	}

	private createJob(
		prepare: Job["prepare"],
		signal: AbortSignal | undefined,
		resolve: (value: RankOutput | null) => void,
		reject: (error: unknown) => void,
	): Job {
		const cancel = (code: "aborted" | "expired") => {
			job.finish(null, new SemanticWorkerError(code));
			this.pending = this.pending.filter((item) => item !== job);
			// Preparation/native SQL keep ownership until their actual completion.
			if (this.active === job && !job.started) this.release(job);
		};
		const abort = () => cancel("aborted");
		const timer = setTimeout(() => cancel("expired"), this.options.requestMs);
		const job: Job = {
			id: ++this.nextId,
			deadlineAt: Date.now() + this.options.requestMs,
			prepare,
			settled: false,
			started: false,
			dispatched: false,
			finish(value, error) {
				if (job.settled) return;
				job.settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				if (error !== undefined) reject(error);
				else resolve(value);
			},
		};
		signal?.addEventListener("abort", abort, { once: true });
		return job;
	}

	private startWorker(): void {
		if (this.worker || this.circuit || this.closing) return;
		this.readinessTimer = setTimeout(() => this.fail("not_ready"), this.options.readinessMs);
		try {
			this.worker = this.options.createWorker({
				message: (message) => this.message(message),
				failure: () => this.fail("worker_failed"),
				exit: () => this.onExit(),
			});
		} catch {
			this.fail("worker_failed");
		}
	}

	private message(message: WorkerReply): void {
		if (this.circuit || this.exited) return;
		if (message.type === "ready") {
			this.ready = true;
			clearTimeout(this.readinessTimer);
			this.pump();
			return;
		}
		const job = this.active;
		if (!job?.dispatched || job.id !== message.id) return;
		if (message.type === "result") job.finish(message.output);
		else
			job.finish(
				null,
				new SemanticWorkerError(message.code === "expired" ? "expired" : "worker_failed"),
			);
		this.release(job);
	}

	private pump(): void {
		if (this.circuit || this.exited || !this.ready) return;
		const job = this.active;
		if (!job) {
			if (this.closing) this.sendClose();
			return;
		}
		if (job.started) return;
		job.started = true;
		const preparation = Promise.resolve().then(() => this.prepare(job));
		this.preparation = preparation;
		void preparation.then(() => {
			if (this.preparation === preparation) this.preparation = undefined;
		});
	}

	private async prepare(job: Job): Promise<void> {
		try {
			const input = await job.prepare();
			if (job.settled || !input || this.circuit || this.exited) {
				job.finish(null);
				this.release(job);
				return;
			}
			job.dispatched = true;
			this.worker?.postMessage({ type: "rank", id: job.id, deadlineAt: job.deadlineAt, input });
		} catch (error) {
			job.finish(null, error);
			this.release(job);
		}
	}

	private release(job: Job): void {
		if (this.active !== job) return;
		this.active = this.pending.shift();
		this.pump();
	}

	private fail(code: SemanticWorkerErrorCode): void {
		if (this.circuit || this.exited) return;
		this.circuit = code;
		clearTimeout(this.readinessTimer);
		try {
			this.options.onCircuitOpen?.(code);
		} catch {
			// Diagnostics must not prevent active and pending callers from settling.
		}
		this.active?.finish(null, new SemanticWorkerError(code));
		for (const job of this.pending.splice(0)) job.finish(null, new SemanticWorkerError(code));
		void this.terminate();
	}

	private onExit(): void {
		if (this.exited) return;
		if (!this.closing) this.fail("worker_failed");
		this.exited = true;
		clearTimeout(this.readinessTimer);
		clearTimeout(this.shutdownTimer);
		this.active?.finish(null, new SemanticWorkerError("closed"));
		// Native worker exit does not cancel an embedding promise owned by this parent.
		if (this.preparation) void this.preparation.then(() => this.joined?.());
		else this.joined?.();
	}

	private terminate(): Promise<number> | undefined {
		if (this.termination || this.exited || !this.worker) return this.termination;
		this.termination = this.worker.terminate();
		void this.termination.then(
			() => this.onExit(),
			() => {
				// A failed termination is not a confirmed exit; the owner's close must fail.
			},
		);
		return this.termination;
	}

	private sendClose(): void {
		try {
			this.worker?.postMessage({ type: "close" });
		} catch {
			void this.terminate();
		}
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		for (const job of this.pending.splice(0)) job.finish(null, new SemanticWorkerError("closed"));
		if (this.active && !this.active.started) {
			this.active.finish(null, new SemanticWorkerError("closed"));
			this.active = undefined;
		}
		if (!this.worker) return Promise.resolve();
		if (this.exited) return this.preparation ?? Promise.resolve();
		this.closePromise = new Promise<void>((resolve, reject) => {
			this.joined = resolve;
			this.shutdownTimer = setTimeout(() => {
				this.active?.finish(null, new SemanticWorkerError("closed"));
				this.terminate()?.catch(reject);
			}, this.options.shutdownMs);
			if (!this.active) this.sendClose();
		});
		return this.closePromise;
	}
}
