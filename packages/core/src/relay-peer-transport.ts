import { performance } from "node:perf_hooks";
import { Duplex } from "node:stream";
import type { OwnedPeerHttpConnection } from "./peer-http-client.js";
import { PeerHttpExchangeError } from "./peer-http-policy.js";
import type { RelayControl } from "./relay-control-codec.js";
import { encodeRelayDataFrame } from "./relay-data-frame.js";
import {
	RelayFailure,
	type RelayFailureReason,
	relayFailureReason,
} from "./relay-failure-reason.js";

type Done = (error?: Error | null) => void;
const BUFFER_BYTES = 256 * 1024;
const FRAME_RESERVE_BYTES = 65_558 + 14;
const nativeByteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;

export interface RelayPeerTransportOptions {
	readonly sessionId: string;
	readonly side: "source" | "target";
	readonly deadlineMs: number;
	readonly signal: AbortSignal;
	readonly validate: () => void;
	readonly send: (message: RelayControl | Uint8Array) => Promise<void>;
	readonly remove: (options: { clean: boolean }) => void;
	/** Native writes still owned after the cleanup grace require physical socket termination. */
	readonly terminate: () => void;
}

/** One logical route. Disposing this stream never closes an otherwise healthy outer socket. */
export class RelayPeerTransport extends Duplex {
	readonly completion: Promise<void>;
	private readonly result = Promise.withResolvers<void>();
	private readonly remoteEOF = Promise.withResolvers<void>();
	private remoteEnd = false;
	private endSubmitted = false;
	private endWritten = false;
	private released = false;
	private frames = 0;
	private bytes = 0;
	private writes = 0;
	private pending?: Done;
	private readonly deadlineTimer: ReturnType<typeof setTimeout>;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private receivingPartial = false;
	private waitingForResponse = false;
	private secured = false;
	private reason?: RelayFailureReason;

	constructor(private readonly options: RelayPeerTransportOptions) {
		super({ allowHalfOpen: true, autoDestroy: true, highWaterMark: 16384 });
		if (!Number.isFinite(options.deadlineMs)) throw new Error("Invalid relay deadline");
		this.completion = this.result.promise;
		void this.completion.catch(() => {});
		void this.remoteEOF.promise.catch(() => {});
		this.on("error", () => {});
		this.once("close", () => {
			if (this.errored) this.result.reject(this.errored);
			else this.result.resolve();
		});
		this.deadlineTimer = setTimeout(
			() => this.destroy(new RelayFailure("relay_expired", "Relay route expired")),
			Math.max(0, Math.min(options.deadlineMs - performance.now(), 60_000)),
		);
		this.deadlineTimer.unref();
		options.signal.addEventListener("abort", this.aborted, { once: true });
		if (options.signal.aborted) this.aborted();
	}

	/** HTTP dispatch disables this once the complete request is available for authorization. */
	setReceivingPartial({ active }: { active: boolean }): void {
		this.receivingPartial = active;
		clearTimeout(this.idleTimer);
		if (!active || this.destroyed) return;
		this.idleTimer = setTimeout(
			() => this.destroy(new RelayFailure("relay_expired", "Relay receive idle")),
			10_000,
		);
		this.idleTimer.unref();
	}

	/** Observe only when an application consumer starts reading. Attaching this must not drain bytes. */
	observePlaintext(duplex: Duplex): void {
		this.waitingForResponse = this.options.side === "source";
		if (this.options.side === "target") this.setReceivingPartial({ active: true });
		const observe = (): void => {
			if (this.destroyed) return;
			if (this.waitingForResponse) {
				this.waitingForResponse = false;
				this.receivingPartial = true;
			}
			this.setReceivingPartial({ active: this.receivingPartial });
		};
		const attach = (event: string | symbol): void => {
			if (event !== "data") return;
			duplex.off("newListener", attach);
			duplex.prependListener("data", observe);
		};
		duplex.on("newListener", attach);
		duplex.once("close", () => {
			duplex.off("newListener", attach);
			duplex.off("data", observe);
		});
	}

	/** Marks Noise authentication complete, so later untagged stream failures are record faults. */
	markSecured(): void {
		this.secured = true;
	}

	/** The first terminal reason. Unset while the route is open or after a clean completion. */
	get failureReason(): RelayFailureReason | undefined {
		return this.reason;
	}

	private check(): void {
		if (this.destroyed || this.released || performance.now() >= this.options.deadlineMs)
			throw new RelayFailure("relay_expired", "Relay route unavailable");
		this.options.validate();
	}

	private account(length: number): void {
		this.check();
		if (++this.frames > 2048 || length > 20 * 1024 * 1024 - this.bytes)
			throw new RelayFailure("relay_unavailable", "Relay route wire budget exceeded");
		this.bytes += length;
	}

	receive(payload: Uint8Array): void {
		try {
			if (this.remoteEnd) throw new RelayFailure("relay_frame_invalid", "Relay DATA after End");
			this.account(payload.byteLength + 22);
			if (this.readableLength + payload.byteLength > BUFFER_BYTES)
				throw new RelayFailure("relay_frame_invalid", "Relay route read buffer exceeded");
			this.push(Buffer.from(payload));
		} catch (error) {
			this.destroy(relayPeerError(error));
		}
	}

	receiveEnd(): void {
		try {
			this.check();
			if (this.remoteEnd || (this.options.side === "source" && !this.endSubmitted))
				throw new RelayFailure("relay_frame_invalid", "Relay End out of order");
			this.remoteEnd = true;
			this.remoteEOF.resolve();
			this.setReceivingPartial({ active: false });
			this.push(null);
		} catch (error) {
			this.destroy(relayPeerError(error));
		}
	}

	override setEncoding(_encoding: BufferEncoding): this {
		throw new TypeError("Relay transport requires byte reads");
	}

	override write(
		chunk: Uint8Array | string,
		encodingOrCallback?: BufferEncoding | Done,
		callback?: Done,
	): boolean {
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		try {
			if (!(chunk instanceof Uint8Array)) throw new TypeError("Relay writes require bytes");
			const length: number = nativeByteLength?.call(chunk);
			if (
				!Number.isSafeInteger(length) ||
				length < 0 ||
				length + this.writableLength > BUFFER_BYTES - FRAME_RESERVE_BYTES
			)
				throw new RelayFailure("relay_unavailable", "Relay route write buffer exceeded");
			const owned = Buffer.allocUnsafe(length);
			for (let index = 0; index < length; index++) owned[index] = chunk[index] ?? 0;
			return super.write(owned, done);
		} catch (error) {
			const failure = relayPeerError(error);
			queueMicrotask(() => done?.(failure));
			this.destroy(failure);
			return false;
		}
	}

	override end(
		chunkOrCallback?: Uint8Array | string | (() => void),
		encodingOrCallback?: BufferEncoding | (() => void),
		callback?: () => void,
	): this {
		if (typeof chunkOrCallback === "function") return super.end(chunkOrCallback);
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (chunkOrCallback !== undefined) this.write(chunkOrCallback);
		return super.end(done);
	}

	override _read(): void {}

	private run(operation: () => Promise<void>, callback: Done): void {
		let settled = false;
		const finish: Done = (error) => {
			if (settled) return;
			settled = true;
			this.pending = undefined;
			callback(error);
		};
		this.pending = finish;
		void operation().then(
			() => finish(),
			(error: unknown) => finish(relayPeerError(error)),
		);
	}

	private async send(message: RelayControl | Uint8Array): Promise<void> {
		this.check();
		this.writes++;
		try {
			await this.options.send(message);
			this.check();
		} finally {
			this.writes--;
		}
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: Done): void {
		this.run(async () => {
			for (let offset = 0; offset < chunk.length; offset += 65_536) {
				const frame = encodeRelayDataFrame({
					sessionId: this.options.sessionId,
					payload: chunk.subarray(offset, offset + 65_536),
				});
				this.account(frame.length);
				await this.send(frame);
			}
		}, callback);
	}

	override _final(callback: Done): void {
		this.run(async () => {
			if (this.options.side === "target") await this.remoteEOF.promise;
			this.check();
			this.endSubmitted = true;
			await this.send(this.control("end"));
			this.endWritten = true;
		}, callback);
	}

	private control(mode: "abort" | "end"): RelayControl {
		return { v: 1, type: "CLOSE", session: this.options.sessionId, body: { mode } };
	}

	private readonly aborted = (): void => {
		this.destroy(new RelayFailure(this.abortReason(), "Relay route cancelled"));
	};

	/** An executor failure such as malformed framing aborts the route, but did not expire it. */
	private abortReason(): RelayFailureReason {
		const cause: unknown = this.options.signal.reason;
		if (
			!(cause instanceof PeerHttpExchangeError) ||
			cause.code === "deadline" ||
			cause.code === "cancelled"
		)
			return "relay_expired";
		return this.secured ? "relay_record_invalid" : "relay_handshake_failed";
	}

	override _destroy(error: Error | null, callback: Done): void {
		const clean = !error && this.remoteEnd && this.endWritten && this.writes === 0;
		const failure = error ?? new Error("Relay route disposed before clean completion");
		// Streams call _destroy once, so the first terminal error decides the reason.
		if (!clean)
			this.reason = relayFailureReason(
				failure,
				this.secured ? "relay_record_invalid" : "relay_handshake_failed",
			);
		this.released = true;
		clearTimeout(this.deadlineTimer);
		clearTimeout(this.idleTimer);
		this.options.signal.removeEventListener("abort", this.aborted);
		this.remoteEOF.reject(failure);
		this.pending?.(failure);
		if (clean) {
			this.options.remove({ clean: true });
			callback(null);
			return;
		}
		let settled = false;
		let abortPending = true;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			this.options.remove({ clean: false });
			callback(failure);
		};
		const timer = setTimeout(() => {
			if (this.writes > 0 || abortPending) this.options.terminate();
			finish();
		}, 1500);
		void this.options
			.send(this.control("abort"))
			.catch(() => {})
			.finally(() => {
				abortPending = false;
				if (this.writes > 0) return;
				finish();
			});
	}
}

export function relayPeerError(error: unknown): Error {
	return error instanceof Error ? error : new Error("Relay peer connection failed");
}

export function ownRelayPeerConnection(
	raw: RelayPeerTransport,
	duplex: Duplex,
): OwnedPeerHttpConnection {
	raw.observePlaintext(duplex);
	return {
		duplex,
		completion: raw.completion,
		async dispose(error) {
			duplex.destroy(error);
			raw.destroy(error);
			await raw.completion.catch(() => {});
		},
	};
}
