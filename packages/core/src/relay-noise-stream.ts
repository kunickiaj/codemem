import { Duplex } from "node:stream";
import type {
	AbortOptions,
	Logger,
	MessageStream,
	StreamCloseEvent,
	StreamMessageEvent,
} from "@libp2p/interface";
import { AbstractMessageStream } from "@libp2p/utils";
import { RelayNoiseOpening, relayNoiseOpeningDigest } from "./relay-noise-opening.js";

export const relayNoiseSilentLog: Logger = Object.freeze(
	Object.assign(() => {}, {
		error: () => {},
		trace: () => {},
		enabled: false,
		newScope: (): Logger => relayNoiseSilentLog,
	}),
);

export interface RelayNoiseWireOptions {
	readonly bufferBytes: number;
	readonly opening?: "hold" | { readonly verifiedDigest: string };
	readonly account: (bytes: number) => void;
	readonly onFailure: (error: Error) => void;
	readonly onReadEnd: () => void;
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error("Noise stream failed");
}

// Each congestion episode needs a new wait. The pinned base class caches its onDrain promise.
function waitForDrain(stream: MessageStream, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error): void => {
			if (settled) return;
			settled = true;
			stream.removeEventListener("drain", wake);
			stream.removeEventListener("idle", wake);
			stream.removeEventListener("close", closed);
			signal?.removeEventListener("abort", aborted);
			if (error !== undefined) reject(error);
			else resolve();
		};
		const check = (): void => {
			if (!stream.writableNeedsDrain && stream.writeBufferLength === 0) finish();
		};
		const wake = (): void => queueMicrotask(check);
		const closed = (event: StreamCloseEvent): void =>
			finish(event.error ?? new Error("Noise stream closed during write"));
		const aborted = (): void => finish(new Error("Noise write cancelled"));
		stream.addEventListener("drain", wake);
		stream.addEventListener("idle", wake);
		stream.addEventListener("close", closed);
		signal?.addEventListener("abort", aborted, { once: true });
		if (signal?.aborted) aborted();
		else if (stream.status !== "open" && stream.status !== "closing")
			finish(new Error("Noise stream is closed"));
		else check();
	});
}

/** Owns the supplied ordered transport until it closes. No network operations are created here. */
export class RelayNoiseWire extends AbstractMessageStream {
	readonly opening: Promise<Uint8Array>;
	private readonly capture = Promise.withResolvers<Uint8Array>();
	private readonly prefix = new RelayNoiseOpening();
	private held?: Uint8Array;
	private gateOpen: boolean;
	private closing?: Promise<void>;
	private failed = false;

	constructor(
		private readonly transport: Duplex,
		private readonly options: RelayNoiseWireOptions,
	) {
		super({
			log: relayNoiseSilentLog,
			inactivityTimeout: 0,
			maxReadBufferLength: options.bufferBytes,
			maxWriteBufferLength: options.bufferBytes,
		});
		this.gateOpen = options.opening === undefined;
		this.opening = this.capture.promise;
		void this.opening.catch(() => {});
		transport.on("data", this.receive);
		transport.on("drain", this.drain);
		transport.on("end", this.end);
		transport.on("error", this.error);
		transport.on("close", this.closed);
		if (transport.destroyed || transport.readableEnded)
			this.fail(new Error("Noise transport already ended"));
	}

	private readonly receive = (chunk: unknown): void => {
		try {
			if (!(chunk instanceof Uint8Array)) throw new Error("Noise transport requires byte chunks");
			this.options.account(chunk.byteLength);
			if (!this.gateOpen) {
				if (this.options.opening === "hold") throw new Error("Noise data before opening release");
				this.captureOpening(chunk);
				return;
			}
			if (chunk.byteLength + this.readBufferLength > this.options.bufferBytes)
				throw new Error("Noise wire read buffer exceeded");
			this.onData(Buffer.from(chunk));
		} catch (error) {
			this.fail(asError(error));
		}
	};

	private captureOpening(chunk: Uint8Array): void {
		const complete = this.prefix.append(chunk);
		if (complete === undefined) return;
		const mode = this.options.opening;
		if (typeof mode === "object" && relayNoiseOpeningDigest(complete) !== mode.verifiedDigest) {
			throw new Error("Noise opening digest mismatch");
		}
		this.held = complete;
		if (mode !== "hold") this.transport.pause();
		this.capture.resolve(Uint8Array.from(complete));
	}

	/** One-shot release after the caller's independent admission and ACCEPTED checks. */
	releaseOpening(): void {
		if (this.gateOpen || this.held === undefined || this.status !== "open") {
			const error = new Error("Noise opening unavailable or already released");
			this.fail(error);
			throw error;
		}
		if (this.transport.readableLength !== 0) {
			const error = new Error("Extra early Noise data");
			this.fail(error);
			throw error;
		}
		const held = this.held;
		this.held = undefined;
		this.gateOpen = true;
		if (this.options.opening === "hold") {
			if (!this.writeTransport(held)) this.onMuxerNeedsDrain();
		} else {
			this.onData(held);
			this.transport.resume();
		}
	}

	override send(data: Parameters<MessageStream["send"]>[0]): boolean {
		if (data.byteLength + this.writeBufferLength > this.options.bufferBytes) {
			const error = new Error("Noise wire write buffer exceeded");
			this.fail(error);
			throw error;
		}
		return super.send(data);
	}

	override abort(error: Error): void {
		this.capture.reject(error);
		this.held = undefined;
		super.abort(error);
	}

	sendData(data: Parameters<AbstractMessageStream["sendData"]>[0]) {
		this.options.account(data.byteLength);
		if (!this.gateOpen) {
			if (this.options.opening !== "hold")
				throw new Error("Noise response before opening verification");
			this.captureOpening(data.subarray());
			return { sentBytes: data.byteLength, canSendMore: true };
		}
		return { sentBytes: data.byteLength, canSendMore: this.writeTransport(data.subarray()) };
	}

	private writeTransport(data: Uint8Array): boolean {
		if (data.byteLength + this.transport.writableLength > this.options.bufferBytes)
			throw new Error("Noise transport write buffer exceeded");
		return this.transport.write(Buffer.from(data));
	}

	sendReset(error: Error): void {
		this.transport.destroy(error);
	}
	sendPause(): void {
		this.transport.pause();
	}
	sendResume(): void {
		if (this.gateOpen) this.transport.resume();
	}

	close(options?: AbortOptions): Promise<void> {
		if (this.closing !== undefined) return this.closing;
		if (this.writeStatus === "closed") return Promise.resolve();
		this.writeStatus = "closing";
		this.closing = waitForDrain(this, options?.signal)
			.then(
				() =>
					new Promise<void>((resolve, reject) => {
						let settled = false;
						const finish = (error?: Error | null): void => {
							if (settled) return;
							settled = true;
							this.transport.off("error", failed);
							this.transport.off("close", closed);
							options?.signal?.removeEventListener("abort", aborted);
							if (error != null) {
								reject(error);
								return;
							}
							this.writeStatus = "closed";
							if (this.remoteWriteStatus === "closed") this.onTransportClosed();
							resolve();
						};
						const failed = (error: Error): void => finish(error);
						const closed = (): void => finish(new Error("Noise transport closed while ending"));
						const aborted = (): void => {
							const error = new Error("Noise close cancelled");
							this.fail(error);
							finish(error);
						};
						if (options?.signal?.aborted) {
							aborted();
							return;
						}
						if (this.transport.destroyed) {
							closed();
							return;
						}
						this.transport.once("error", failed);
						this.transport.once("close", closed);
						options?.signal?.addEventListener("abort", aborted, { once: true });
						this.transport.end(() => finish());
					}),
			)
			.catch((error: unknown) => {
				// The drain can reject before end() installs its cancellation handlers.
				const failure = asError(error);
				this.fail(failure);
				throw failure;
			});
		return this.closing;
	}

	private fail(error: Error): void {
		if (this.failed) return;
		this.failed = true;
		this.capture.reject(error);
		this.held = undefined;
		this.abort(error);
		this.options.onFailure(error);
	}
	private readonly drain = (): void => this.onMuxerDrain();
	private readonly end = (): void => {
		if (!this.gateOpen) {
			this.fail(new Error("Truncated or unreleased Noise opening"));
			return;
		}
		this.onRemoteCloseWrite();
		this.options.onReadEnd();
	};
	private readonly error = (error: Error): void => this.fail(error);
	private readonly closed = (): void => {
		this.capture.reject(new Error("Noise transport closed"));
		this.held = undefined;
		this.onTransportClosed();
		this.transport.off("data", this.receive);
		this.transport.off("drain", this.drain);
		this.transport.off("end", this.end);
		this.transport.off("error", this.error);
		this.transport.off("close", this.closed);
	};
}

export interface RelayNoisePlaintextOptions {
	readonly bufferBytes: number;
	readonly accountSent: (bytes: number) => void;
	readonly accountReceived: (bytes: number) => void;
}

type WriteCallback = (error?: Error | null) => void;

/** Bounds queues even when a caller ignores the Writable backpressure return value. */
export class RelayNoiseDuplex extends Duplex {
	private readonly controller = new AbortController();
	private pendingWrite?: WriteCallback;
	private pendingRead?: Buffer;
	private pendingReadOffset = 0;
	private drainingRead = false;
	private readingNode = false;
	private upstreamEnded = false;
	private eofPushed = false;

	constructor(
		private readonly stream: MessageStream,
		private readonly limits: RelayNoisePlaintextOptions,
	) {
		super({ allowHalfOpen: true, highWaterMark: Math.min(16_384, limits.bufferBytes) });
		stream.maxReadBufferLength = limits.bufferBytes;
		stream.maxWriteBufferLength = limits.bufferBytes;
		this.on("error", this.observeError);
		this.once("close", () => this.off("error", this.observeError));
		stream.addEventListener("message", this.message);
		stream.addEventListener("end", this.endRead);
		stream.addEventListener("close", this.closeStream);
		if (stream.readableEnded) this.endRead();
	}

	override write(
		chunk: Uint8Array | string,
		encodingOrCallback?: BufferEncoding | WriteCallback,
		callback?: WriteCallback,
	): boolean {
		const encoding = typeof encodingOrCallback === "string" ? encodingOrCallback : undefined;
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		try {
			if (typeof chunk !== "string" && !(chunk instanceof Uint8Array)) {
				throw new Error("Noise plaintext writes require bytes or a string");
			}
			const length =
				typeof chunk === "string" ? Buffer.byteLength(chunk, encoding) : chunk.byteLength;
			if (!Number.isSafeInteger(length) || length < 0)
				throw new Error("Invalid Noise plaintext byte length");
			if (length + this.writableLength > this.limits.bufferBytes)
				throw new Error("Noise plaintext write buffer exceeded");
			this.limits.accountSent(length);
		} catch (error) {
			const failure = asError(error);
			queueMicrotask(() => done?.(failure));
			this.destroy(failure);
			return false;
		}
		if (encoding !== undefined) return super.write(chunk, encoding, done);
		return super.write(chunk, done);
	}

	// Writable.end(chunk) otherwise bypasses the public write override and its queue/budget checks.
	override end(
		chunkOrCallback?: Uint8Array | string | (() => void),
		encodingOrCallback?: BufferEncoding | (() => void),
		callback?: () => void,
	): this {
		if (typeof chunkOrCallback === "function") return super.end(chunkOrCallback);
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (chunkOrCallback !== undefined) {
			if (typeof encodingOrCallback === "string") this.write(chunkOrCallback, encodingOrCallback);
			else this.write(chunkOrCallback);
		}
		return super.end(done);
	}

	override read(size?: number) {
		if (size !== undefined && size !== null && typeof size !== "number") {
			throw new TypeError("Noise read size must be a number or omitted");
		}
		if (typeof size === "number" && size > this.limits.bufferBytes) {
			throw new RangeError(
				`Noise read size exceeds the ${this.limits.bufferBytes}-byte buffer limit`,
			);
		}
		if (this.readingNode) return super.read(size);
		this.readingNode = true;
		try {
			const chunk = super.read(size);
			// Node can request _read before consuming a full buffer and then wait for a push.
			// Retry after consumption creates capacity, including when the cap equals its high-water mark.
			this._read();
			return chunk;
		} finally {
			this.readingNode = false;
		}
	}

	override _read(): void {
		try {
			if (this.destroyed || this.drainingRead) return;
			if (
				this.drainPendingRead() &&
				!this.upstreamEnded &&
				this.readableLength < this.limits.bufferBytes
			)
				this.stream.resume();
		} catch (error) {
			this.destroy(asError(error));
		}
	}
	private drainPendingRead(): boolean {
		if (this.destroyed || this.drainingRead) return false;
		this.drainingRead = true;
		try {
			let ready = true;
			if (this.pendingRead !== undefined) {
				const capacity = this.limits.bufferBytes - this.readableLength;
				if (capacity <= 0) return false;
				const end = Math.min(this.pendingRead.length, this.pendingReadOffset + capacity);
				const chunk = Buffer.from(this.pendingRead.subarray(this.pendingReadOffset, end));
				this.pendingReadOffset = end;
				if (end === this.pendingRead.length) {
					this.pendingRead = undefined;
					this.pendingReadOffset = 0;
				}
				ready = this.push(chunk);
			}
			if (this.pendingRead !== undefined) return false;
			if (this.upstreamEnded && !this.eofPushed) {
				this.eofPushed = true;
				this.push(null);
			}
			return ready;
		} finally {
			this.drainingRead = false;
		}
	}
	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: WriteCallback): void {
		this.pendingWrite = callback;
		void this.sendChunked(chunk).then(
			() => this.finishWrite(),
			(error: unknown) => this.finishWrite(asError(error)),
		);
	}
	private async sendChunked(chunk: Uint8Array): Promise<void> {
		// Leave room for the library's two-byte length and 16-byte authentication tag.
		const size = Math.min(65_519, this.limits.bufferBytes - 18);
		if (size <= 0) throw new Error("Noise buffer cannot contain an encrypted record");
		for (let offset = 0; offset < chunk.byteLength; offset += size) {
			this.controller.signal.throwIfAborted();
			if (!this.stream.send(chunk.subarray(offset, offset + size))) {
				await waitForDrain(this.stream, this.controller.signal);
			}
		}
	}
	private finishWrite(error?: Error): void {
		const callback = this.pendingWrite;
		this.pendingWrite = undefined;
		callback?.(error);
	}
	override _final(callback: WriteCallback): void {
		void this.stream.close({ signal: this.controller.signal }).then(
			() => callback(),
			(error: unknown) => callback(asError(error)),
		);
	}
	override _destroy(error: Error | null, callback: WriteCallback): void {
		this.pendingRead = undefined;
		this.pendingReadOffset = 0;
		this.stream.removeEventListener("message", this.message);
		this.stream.removeEventListener("end", this.endRead);
		this.stream.removeEventListener("close", this.closeStream);
		if (error === null && this.readableEnded && this.writableFinished) {
			this.controller.abort();
			callback(null);
			return;
		}
		const failure = error ?? new Error("Noise stream disposed");
		this.controller.abort(failure);
		this.finishWrite(failure);
		this.stream.abort(failure);
		callback(error);
	}
	private readonly message = (event: StreamMessageEvent): void => {
		try {
			if (this.destroyed) return;
			const length = event.data.byteLength;
			if (
				this.pendingRead !== undefined ||
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length > this.limits.bufferBytes
			)
				throw new Error("Noise plaintext read buffer exceeded");
			this.limits.accountReceived(length);
			if (this.destroyed) return;
			// Own one bounded snapshot rather than retain a view into a larger ciphertext allocation.
			this.pendingRead = Buffer.from(event.data.subarray());
			if (!this.drainPendingRead() && !this.upstreamEnded && !this.destroyed) this.stream.pause();
		} catch (error) {
			this.destroy(asError(error));
		}
	};
	private readonly endRead = (): void => {
		this.upstreamEnded = true;
		this.drainPendingRead();
	};
	private readonly closeStream = (event: StreamCloseEvent): void => {
		if (event.error !== undefined) {
			this.destroy(event.error);
			return;
		}
		this.endRead();
		// The wire can close inside _final before its promise resolves and Node emits finish.
		if (!this.writableEnded)
			this.destroy(new Error("Noise stream closed before local writes ended"));
	};
	private readonly observeError = (): void => {};
}
