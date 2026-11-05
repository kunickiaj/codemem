import type {
	RelayRegistrationSnapshot,
	RelayServerSocket,
	RelaySocketEvents,
} from "@codemem/core/internal/relay-host";

/** Close code for sockets the engine or adapter rejects. */
export const RELAY_CLOSE_POLICY = 1008;
/** Close code when the relay is switched off or this realm has no provisioned quota. */
export const RELAY_CLOSE_UNAVAILABLE = 1013;
/** Contract target. The documented hard limit is 16 KiB. */
export const MAX_ATTACHMENT_BYTES = 8192;
/**
 * How long an engine-closed socket stays charged while waiting for the peer's
 * close reply. This timer keeps the object resident for at most this long.
 */
export const RELAY_CLOSE_GRACE_MS = 8000;
const MAX_CONTROL_BYTES = 4096;
const MAX_DATA_BYTES = 65_558;
const encoder = new TextEncoder();

/**
 * RelayServerSocket over one hibernatable Workers WebSocket.
 *
 * Workers `send()` returns nothing and reports no completion, and the Workers
 * WebSocket has no `bufferedAmount`. The runtime owns the bytes once `send()`
 * returns. The adapter therefore reports a write as complete on the next
 * microtask, which means "handed to the runtime", not "delivered" or "drained".
 * The microtask keeps engine callbacks from running inside `send()`.
 * `bufferedBytes()` reports only those bytes not yet released, so the engine's
 * queue caps cover its own copies, not the runtime's outbound buffer. The
 * Durable Object limits bound that buffer only for routes open at the same time
 * (see concurrentRouteOutboundBound). Bytes left from ended routes are limited
 * only by the traffic quota rate.
 */
export class RelaySocketAdapter implements RelayServerSocket {
	private owned = 0;
	private open = true;
	private released = false;
	private events: RelaySocketEvents | null = null;
	private grace: ReturnType<typeof setTimeout> | undefined;
	constructor(
		readonly webSocket: WebSocket,
		private readonly onReleased: () => void,
		private readonly closeGraceMs = RELAY_CLOSE_GRACE_MS,
	) {}

	bind(events: RelaySocketEvents): void {
		this.events = events;
	}
	/** True until the engine sees the socket register. */
	pending(): boolean {
		return this.events?.pending() ?? false;
	}
	sendText(json: string, onWritten: (error?: Error) => void): void {
		this.send(json, encoder.encode(json).byteLength, onWritten);
	}
	sendBinary(frame: Uint8Array, onWritten: (error?: Error) => void): void {
		this.send(frame, frame.byteLength, onWritten);
	}
	bufferedBytes(): number {
		return this.owned;
	}
	/** Workers has no input pause. See the class comment for what bounds memory instead. */
	pauseInput(): void {}
	/** See pauseInput. */
	resumeInput(): void {}
	/**
	 * Engine-initiated close. It clears the stored snapshot first, so a later wake
	 * cannot restore this socket. The adapter sends nothing more, but the socket
	 * stays charged to the engine's physical-socket limits until the peer confirms
	 * the close (webSocketClose or webSocketError calls peerClosed). A peer that
	 * never answers is released after RELAY_CLOSE_GRACE_MS.
	 */
	close(): void {
		if (!this.open) return;
		this.open = false;
		try {
			this.webSocket.serializeAttachment(null);
		} catch {
			/* A socket that is already gone holds no attachment to restore. */
		}
		try {
			this.webSocket.close(RELAY_CLOSE_POLICY, "relay closed");
		} catch {
			/* Already closing. */
		}
		this.grace = setTimeout(() => this.release(), this.closeGraceMs);
	}
	/** The peer closed or the socket failed. Releases engine state now. */
	peerClosed(): void {
		this.open = false;
		this.release();
	}
	/** Called by the engine's onRegistration hook. Throwing makes the engine close the socket. */
	storeSnapshot(snapshot: RelayRegistrationSnapshot | null): void {
		if (snapshot && encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_ATTACHMENT_BYTES)
			throw new Error("Relay attachment too large");
		this.webSocket.serializeAttachment(snapshot);
	}
	/** Delivers one inbound message. Oversized messages close the socket before decoding. */
	async deliver(message: string | ArrayBuffer): Promise<void> {
		const events = this.events;
		if (!events || !this.open) return;
		if (typeof message === "string") {
			const bytes = encoder.encode(message);
			if (bytes.byteLength > MAX_CONTROL_BYTES) {
				this.close();
				return;
			}
			await events.text(bytes);
			return;
		}
		if (!(message instanceof ArrayBuffer) || message.byteLength > MAX_DATA_BYTES) {
			this.close();
			return;
		}
		events.binary(new Uint8Array(message));
	}

	private send(data: string | Uint8Array, bytes: number, onWritten: (error?: Error) => void) {
		if (!this.open) {
			queueMicrotask(() => onWritten(new Error("Relay socket closed")));
			return;
		}
		try {
			this.webSocket.send(data);
		} catch {
			queueMicrotask(() => onWritten(new Error("Relay write failed")));
			return;
		}
		this.owned += bytes;
		queueMicrotask(() => {
			this.owned -= bytes;
			onWritten();
		});
	}
	private release(): void {
		if (this.released) return;
		this.released = true;
		if (this.grace) clearTimeout(this.grace);
		this.events?.closed();
		this.onReleased();
	}
}
