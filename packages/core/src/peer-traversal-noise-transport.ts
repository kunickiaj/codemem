import { Duplex } from "node:stream";
import { TraversalByteStream } from "./peer-traversal-stream.js";

type Done = (error?: Error | null) => void;
const nativeByteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error("Traversal Noise transport failed");
}

/** Internal ownership boundary. Creates no channel and queues nothing before attachment. */
export class DeferredTraversalTransport extends Duplex {
	private inner?: TraversalByteStream;
	private pending?: Done;
	private destruction?: { error: Error | null; callback: Done };

	constructor(private readonly bufferBytes: number) {
		super({ allowHalfOpen: true, autoDestroy: true, highWaterMark: Math.min(16384, bufferBytes) });
		if (!Number.isSafeInteger(bufferBytes) || bufferBytes < 1 || bufferBytes > 262144)
			throw new RangeError("Invalid deferred traversal buffer limit");
		this.on("error", this.observeError);
		this.once("close", () => this.off("error", this.observeError));
	}

	/** Every call transfers ownership, including rejected or repeated attachments. */
	attach(stream: TraversalByteStream): void {
		try {
			this.validateAttachment(stream);
			this.inner = stream;
			stream.pause();
			stream.on("data", this.receive);
			stream.on("end", this.endRead);
			stream.on("error", this.failed);
			stream.on("close", this.closedInner);
			stream.resume();
		} catch (error) {
			const failure = asError(error);
			if (stream instanceof Duplex && stream !== this.inner && !stream.closed) {
				const observe = (): void => {};
				stream.on("error", observe);
				stream.once("close", () => stream.off("error", observe));
				stream.destroy(failure);
			}
			this.destroy(failure);
			throw failure;
		}
	}

	private validateAttachment(stream: TraversalByteStream): void {
		if (this.inner !== undefined || this.destroyed || this.readableEnded || this.writableEnded)
			throw new Error("Deferred traversal transport unavailable or already attached");
		if (!(stream instanceof TraversalByteStream) || stream.side !== "source")
			throw new TypeError("Traversal Noise initiator requires a source TraversalByteStream");
		if (
			stream.destroyed ||
			stream.readableEnded ||
			stream.writableEnded ||
			stream.errored ||
			stream.readableLength !== 0 ||
			stream.writableLength !== 0 ||
			stream.readableHighWaterMark > this.bufferBytes ||
			stream.writableHighWaterMark > this.bufferBytes
		)
			throw new Error("Traversal source must be open with empty compatible buffers");
	}

	override setEncoding(_encoding: BufferEncoding): this {
		throw new TypeError("Traversal Noise transport requires byte reads");
	}

	override write(
		chunk: Uint8Array | string,
		encodingOrCallback?: BufferEncoding | Done,
		callback?: Done,
	): boolean {
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		try {
			if (!(chunk instanceof Uint8Array))
				throw new TypeError("Traversal Noise writes require bytes");
			const length: number = nativeByteLength?.call(chunk);
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length + this.writableLength > this.bufferBytes
			)
				throw new RangeError("Deferred traversal write buffer exceeded");
			const owned = Buffer.allocUnsafe(length);
			for (let index = 0; index < length; index++) owned[index] = chunk[index] ?? 0;
			return super.write(owned, done);
		} catch (error) {
			const failure = asError(error);
			queueMicrotask(() => done?.(failure));
			this.destroy(failure);
			return false;
		}
	}

	// end(chunk) otherwise bypasses the byte and queue checks, including while corked.
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

	override _read(): void {
		if (!this.destroyed) this.inner?.resume();
	}

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
		try {
			if (!this.inner) throw new Error("Traversal Noise write before attachment");
			this.inner.write(chunk, finish);
		} catch (error) {
			finish(asError(error));
		}
	}

	override _final(callback: Done): void {
		const finish = this.operation(callback);
		try {
			if (!this.inner) throw new Error("Traversal Noise end before attachment");
			this.inner.end(finish);
		} catch (error) {
			finish(asError(error));
		}
	}

	private readonly receive = (chunk: unknown): void => {
		try {
			if (this.destroyed) return;
			if (!(chunk instanceof Uint8Array))
				throw new TypeError("Traversal Noise requires byte chunks");
			const length: number = nativeByteLength?.call(chunk);
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				this.readableLength + length > this.bufferBytes
			)
				throw new RangeError("Deferred traversal read buffer exceeded");
			const owned = Buffer.allocUnsafe(length);
			for (let index = 0; index < length; index++) owned[index] = chunk[index] ?? 0;
			if (!this.push(owned)) this.inner?.pause();
		} catch (error) {
			this.destroy(asError(error));
		}
	};
	private readonly endRead = (): void => {
		this.push(null);
	};
	private readonly failed = (error: Error): void => {
		this.destroy(error);
	};
	private readonly observeError = (): void => {};

	private readonly closedInner = (): void => {
		const inner = this.inner;
		if (!inner) return;
		inner.off("data", this.receive);
		inner.off("end", this.endRead);
		inner.off("error", this.failed);
		inner.off("close", this.closedInner);
		if (this.destruction) {
			const { error, callback } = this.destruction;
			this.destruction = undefined;
			callback(error ?? inner.errored);
		} else if (inner.errored || !inner.readableEnded || !inner.writableFinished) {
			this.destroy(inner.errored ?? new Error("Traversal transport closed prematurely"));
		}
		// Clean close leaves Node's buffered bytes and EOF for the consumer to drain.
	};

	override _destroy(error: Error | null, callback: Done): void {
		this.pending?.(error ?? new Error("Deferred traversal transport disposed"));
		const inner = this.inner;
		if (!inner || inner.closed) {
			callback(error ?? inner?.errored);
			return;
		}
		this.destruction = { error, callback };
		inner.destroy(error ?? undefined);
	}
}
