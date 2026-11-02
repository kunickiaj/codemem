import { Duplex } from "node:stream";
import {
	TRAVERSAL_MAX_FRAME_PAYLOAD_BYTES,
	TraversalFrameDecoder,
	TraversalFrameEncoder,
} from "./peer-traversal-frame.js";

/** Trusted owned port. Notifications are ordered and asynchronous relative to port calls.
 * dispose() owns the whole transport. These counters do not bound SDK reassembly or UDP memory. */
export interface TraversalMessageChannel {
	readonly delivery: "reliable-ordered";
	readonly state: "open" | "closing" | "closed";
	readonly bufferedAmount: number;
	send(frame: Uint8Array): void;
	onMessage(listener: (frame: unknown) => void): () => void;
	onDrain(listener: () => void): () => void;
	onClose(listener: () => void): () => void;
	dispose(): Promise<void>;
}

export const TRAVERSAL_BYTE_STREAM_LIMITS = Object.freeze({
	bufferBytes: 262144,
	channelBufferBytes: 262144,
	closeMs: 1500,
	sentBytes: 33554432,
	receivedBytes: 33554432,
	sentFrames: 8192,
	receivedFrames: 8192,
} as const);

type Limits = { -readonly [K in keyof typeof TRAVERSAL_BYTE_STREAM_LIMITS]: number };
type Done = (error?: Error | null) => void;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;
export interface TraversalByteStreamOptions {
	channel: TraversalMessageChannel;
	/** Fixed application role: source initiates the self-framed exchange and closes first. */
	side: "source" | "target";
	/** Absolute performance.now() deadline, additionally clamped to a 60-second lifetime. */
	deadlineMs: number;
	signal?: AbortSignal;
	limits?: Partial<Limits>;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error("Traversal transport failed");
}

function queueBytes(channel: TraversalMessageChannel): number {
	const size = channel.bufferedAmount;
	if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid channel bufferedAmount");
	return size;
}

function channelState(channel: TraversalMessageChannel): TraversalMessageChannel["state"] {
	const state = channel.state;
	if (state !== "open" && state !== "closing" && state !== "closed")
		throw new TypeError("Invalid channel state");
	return state;
}

function prepareLimits(options: TraversalByteStreamOptions): Limits {
	if (
		options.limits !== undefined &&
		(options.limits === null || typeof options.limits !== "object")
	) {
		throw new TypeError("Invalid traversal limits");
	}
	const limits: Limits = { ...TRAVERSAL_BYTE_STREAM_LIMITS };
	for (const key of Object.keys(limits) as (keyof Limits)[]) {
		const supplied = options.limits?.[key];
		const value = supplied === undefined ? limits[key] : supplied;
		let minimum = 1;
		if (key === "channelBufferBytes") minimum = 3;
		if (key === "sentBytes" || key === "receivedBytes") minimum = 2;
		if (!Number.isSafeInteger(value) || value < minimum || value > limits[key]) {
			throw new RangeError(`Invalid traversal ${key} limit`);
		}
		limits[key] = value;
	}
	return limits;
}

function prepare(options: TraversalByteStreamOptions) {
	if (!Number.isFinite(options.deadlineMs)) throw new TypeError("Invalid traversal deadline");
	const side = options.side;
	if (side !== "source" && side !== "target") throw new TypeError("Invalid traversal side");
	const limits = prepareLimits(options);
	if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
		throw new TypeError("Invalid traversal abort signal");
	}
	const channel = options.channel;
	if (channel?.delivery !== "reliable-ordered" || channelState(channel) !== "open") {
		throw new TypeError("Traversal requires an open reliable ordered channel");
	}
	if (queueBytes(channel) > limits.channelBufferBytes)
		throw new RangeError("Channel buffer exceeded");
	const port = {
		send: channel.send?.bind(channel),
		onMessage: channel.onMessage?.bind(channel),
		onDrain: channel.onDrain?.bind(channel),
		onClose: channel.onClose?.bind(channel),
		dispose: channel.dispose?.bind(channel),
	};
	if (Object.values(port).some((method) => typeof method !== "function")) {
		throw new TypeError("Invalid traversal channel methods");
	}
	return {
		channel,
		port,
		limits,
		side,
		deadline: Math.min(options.deadlineMs, performance.now() + 60000),
	};
}

/** Validation failures before subscription leave ownership with the caller.
 * Once subscription starts every terminal path disposes the entire injected transport. */
export class TraversalByteStream extends Duplex {
	/** Resource release only. Observe error or finished() to determine I/O success. */
	readonly disposed: Promise<void>;
	private readonly disposal = Promise.withResolvers<void>();
	private readonly remoteEOF = Promise.withResolvers<void>();
	private readonly encoder = new TraversalFrameEncoder();
	private readonly decoder = new TraversalFrameDecoder();
	private readonly prepared: ReturnType<typeof prepare>;
	private readonly unsubs: (() => void)[] = [];
	private readonly signal?: AbortSignal;
	private timer?: ReturnType<typeof setTimeout>;
	private disposing = false;
	private remoteEnd = false;
	private endSent = false;
	private localEnd = false;
	private physicalClosed = false;
	private deferredClean = false;
	private destructionError: Error | null = null;
	private pending?: Done;
	private waiting?: Done;
	private sentBytes = 0;
	private receivedBytes = 0;
	private sentFrames = 0;
	private receivedFrames = 0;

	constructor(options: TraversalByteStreamOptions) {
		const prepared = prepare(options);
		super({
			allowHalfOpen: true,
			autoDestroy: true,
			highWaterMark: Math.min(16384, prepared.limits.bufferBytes),
		});
		this.prepared = prepared;
		this.signal = options.signal;
		this.disposed = this.disposal.promise;
		void this.disposed.catch(() => {});
		void this.remoteEOF.promise.catch(() => {});
		// Constructor subscription failures can precede the caller's first error listener.
		this.on("error", () => {});
		try {
			this.subscribe(prepared.port.onMessage(this.receive));
			this.subscribe(prepared.port.onDrain(this.drain));
			this.subscribe(prepared.port.onClose(this.channelClosed));
			this.signal?.addEventListener("abort", this.aborted, { once: true });
			const remaining = prepared.deadline - performance.now();
			this.timer = setTimeout(
				() => this.destroy(new Error("Traversal deadline exceeded")),
				Math.max(0, remaining),
			);
			if (this.signal?.aborted) this.aborted();
			else if (remaining <= 0) this.destroy(new Error("Traversal deadline exceeded"));
		} catch (error) {
			this.destroy(asError(error));
		}
	}

	private subscribe(unsubscribe: () => void): void {
		if (typeof unsubscribe !== "function") throw new TypeError("Invalid channel unsubscribe");
		this.unsubs.push(unsubscribe);
	}

	override write(
		chunk: Uint8Array | string,
		encodingOrCallback?: BufferEncoding | Done,
		callback?: Done,
	): boolean {
		if (!(chunk instanceof Uint8Array)) throw new TypeError("Traversal writes require bytes");
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		let owned: Buffer;
		try {
			const length: number = typedArrayByteLength?.call(chunk);
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length + this.writableLength > this.prepared.limits.bufferBytes
			) {
				throw new RangeError("Traversal write buffer exceeded");
			}
			// Ignore shadowed length properties and never retain the caller's backing allocation.
			owned = Buffer.allocUnsafe(length);
			for (let index = 0; index < length; index++) owned[index] = chunk[index] ?? 0;
		} catch (error) {
			const failure = asError(error);
			queueMicrotask(() => done?.(failure));
			this.destroy(failure);
			return false;
		}
		return super.write(owned, done);
	}

	// Node's end(chunk) bypasses write(), including while corked.
	override end(
		chunkOrCallback?: Uint8Array | string | (() => void),
		encodingOrCallback?: BufferEncoding | (() => void),
		callback?: () => void,
	): this {
		if (typeof chunkOrCallback === "function") return super.end(chunkOrCallback);
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (chunkOrCallback !== undefined && chunkOrCallback !== null) this.write(chunkOrCallback);
		return super.end(done);
	}

	override read(size?: number) {
		if (size !== undefined && size !== null && typeof size !== "number") {
			throw new TypeError("Traversal read size must be a number or omitted");
		}
		if (typeof size === "number" && size > this.prepared.limits.bufferBytes) {
			throw new RangeError("Traversal read size exceeds buffer limit");
		}
		return super.read(size);
	}

	override setEncoding(_encoding: BufferEncoding): this {
		throw new TypeError("Traversal streams require byte reads. Decode returned buffers instead.");
	}

	override _read(): void {}

	private operation(callback: Done): Done {
		let settled = false;
		const finish: Done = (error) => {
			if (settled) return;
			settled = true;
			if (this.pending === finish) this.pending = undefined;
			callback(error);
		};
		this.pending = finish;
		return finish;
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: Done): void {
		const finish = this.operation(callback);
		void this.sendChunk(chunk).then(
			() => finish(),
			(error: unknown) => finish(asError(error)),
		);
	}

	private async sendChunk(chunk: Buffer): Promise<void> {
		const size = Math.min(
			TRAVERSAL_MAX_FRAME_PAYLOAD_BYTES,
			this.prepared.limits.channelBufferBytes - 2,
		);
		if (size <= 0 && chunk.length > 0) throw new RangeError("Channel cannot contain a data frame");
		for (let offset = 0; offset < chunk.length; offset += size) {
			await this.sendFrame(this.encoder.encodeData(chunk.subarray(offset, offset + size)));
		}
	}

	private async sendFrame(frame: Uint8Array, options?: { end: true }): Promise<void> {
		if (this.destroyed || this.disposing || channelState(this.prepared.channel) !== "open") {
			throw new Error("Traversal channel closed during write");
		}
		await this.waitForDrain();
		if (this.destroyed || this.disposing || channelState(this.prepared.channel) !== "open") {
			throw new Error("Traversal channel closed during write");
		}
		if (
			queueBytes(this.prepared.channel) + frame.length >
			this.prepared.limits.channelBufferBytes
		) {
			throw new RangeError("Traversal channel buffer exceeded");
		}
		this.accountFrame("sent", frame.length);
		this.prepared.port.send(frame);
		// A failed send cannot count as a transmitted End, even if close is already scheduled.
		if (options?.end) this.endSent = true;
		await this.waitForDrain();
	}

	private waitForDrain(): Promise<void> {
		if (this.destroyed || this.disposing) {
			return Promise.reject(new Error("Traversal channel closed during drain"));
		}
		return new Promise<void>((resolve, reject) => {
			this.waiting = (error) => {
				if (error) reject(error);
				else resolve();
			};
			this.drain();
		});
	}

	private readonly drain = (): void => {
		if (this.disposing || (this.destroyed && !this.deferredClean)) return;
		try {
			channelState(this.prepared.channel);
			const size = queueBytes(this.prepared.channel);
			if (size > this.prepared.limits.channelBufferBytes)
				throw new RangeError("Channel buffer exceeded");
			if (size !== 0) return;
			const waiting = this.waiting;
			this.waiting = undefined;
			waiting?.();
		} catch (error) {
			this.destroy(asError(error));
		}
	};

	override _final(callback: Done): void {
		const finish = this.operation(callback);
		void this.sendEnd().then(
			() => {
				if (this.destroyed) return;
				this.localEnd = true;
				finish();
				this.disposeIfComplete();
			},
			(error: unknown) => finish(asError(error)),
		);
	}

	private async sendEnd(): Promise<void> {
		// The target's End proves receipt of source End, independently of SDK queue counters.
		if (this.prepared.side === "target") await this.remoteEOF.promise;
		await this.sendFrame(this.encoder.encodeEnd(), { end: true });
	}

	private confirmLocalEnd(): void {
		this.localEnd = true;
		const waiting = this.waiting;
		this.waiting = undefined;
		waiting?.();
		this.pending?.();
	}

	private readonly receive = (message: unknown): void => {
		if (this.disposing || (this.destroyed && !this.deferredClean)) return;
		try {
			const frame = this.decoder.decode(message);
			this.accountFrame("received", frame.kind === "end" ? 2 : frame.payload.length + 2);
			if (frame.kind === "end") {
				if (this.prepared.side === "source" && !this.endSent) {
					throw new Error("Traversal target End arrived before source End was sent");
				}
				this.remoteEnd = true;
				this.remoteEOF.resolve();
				// Complete Node's writable half before EOF can trigger application cleanup.
				if (this.prepared.side === "source") this.confirmLocalEnd();
				this.push(null);
				this.disposeIfComplete();
				return;
			}
			if (this.readableLength + frame.payload.length > this.prepared.limits.bufferBytes) {
				throw new RangeError("Traversal read buffer exceeded");
			}
			this.push(Buffer.from(frame.payload));
		} catch (error) {
			this.destroy(asError(error));
		}
	};

	private accountFrame(direction: "sent" | "received", bytes: number): void {
		const byteKey = `${direction}Bytes` as const;
		const frameKey = `${direction}Frames` as const;
		const limits = this.prepared.limits;
		if (this[byteKey] + bytes > limits[byteKey] || this[frameKey] + 1 > limits[frameKey]) {
			throw new RangeError(`Traversal ${direction} frame budget exceeded`);
		}
		this[byteKey] += bytes;
		this[frameKey] += 1;
	}

	private readonly channelClosed = (): void => {
		if (this.disposing || (this.destroyed && !this.deferredClean)) return;
		try {
			this.physicalClosed = true;
			if (this.decoder.close() !== "ended") throw new Error("Truncated traversal stream");
			// Only source initiates clean physical close, after receiving target End.
			if (this.prepared.side === "target" && this.endSent) this.confirmLocalEnd();
			if (!this.localEnd) throw new Error("Traversal channel closed before writes flushed");
			this.disposeIfComplete();
		} catch (error) {
			this.destroy(asError(error));
		}
	};

	private readonly aborted = (): void => {
		this.destroy(new Error("Traversal stream aborted"));
	};

	private disposeIfComplete(): void {
		// Protocol completion is independent of Node's consumer draining its readable queue.
		if (!this.remoteEnd || !this.localEnd) return;
		if (this.prepared.side === "source" || this.physicalClosed) this.disposeTransport();
	}

	private disposeTransport(): void {
		if (this.disposing) return;
		this.disposing = true;
		clearTimeout(this.timer);
		this.signal?.removeEventListener("abort", this.aborted);
		let cleanupError: Error | undefined;
		for (const unsubscribe of this.unsubs.splice(0)) {
			try {
				unsubscribe();
			} catch (error) {
				cleanupError ??= asError(error);
			}
		}
		let timeout: ReturnType<typeof setTimeout>;
		void Promise.resolve()
			.then(() => {
				timeout = setTimeout(
					() => this.disposal.reject(new Error("Traversal transport disposal timed out")),
					this.prepared.limits.closeMs,
				);
				return this.prepared.port.dispose();
			})
			.then(
				() => {
					clearTimeout(timeout);
					if (cleanupError) this.disposal.reject(cleanupError);
					else this.disposal.resolve();
				},
				(error: unknown) => {
					clearTimeout(timeout);
					this.disposal.reject(asError(error));
				},
			);
	}

	/** Repeated clean release waits for source close. Cancel that wait with a signal or Error. */
	override destroy(error?: Error): this {
		if (this.deferredClean && error != null) {
			this.forceDisposal(error);
			return this;
		}
		return super.destroy(error);
	}

	private forceDisposal(failure: Error): void {
		this.destructionError ??= failure;
		this.deferredClean = false;
		this.remoteEOF.reject(failure);
		const waiting = this.waiting;
		this.waiting = undefined;
		waiting?.(failure);
		this.pending?.(failure);
		this.disposeTransport();
	}

	override _destroy(error: Error | null, callback: Done): void {
		this.destructionError = error;
		void this.disposed.then(
			() => callback(this.destructionError),
			(disposalError: unknown) => callback(this.destructionError ?? asError(disposalError)),
		);
		if (error === null && this.remoteEnd && this.localEnd) {
			this.deferredClean =
				this.prepared.side === "target" && !this.physicalClosed && !this.disposing;
			this.disposeIfComplete();
			return;
		}
		this.forceDisposal(error ?? new Error("Traversal stream disposed before protocol completion"));
	}
}
