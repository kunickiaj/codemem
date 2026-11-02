import { setImmediate as schedule } from "node:timers";
import { setImmediate } from "node:timers/promises";
import type { TraversalMessageChannel } from "./peer-traversal-stream.js";

/** Controlled application-facing queues only. This does not model RTC/UDP allocation. */
export class MemoryChannel implements TraversalMessageChannel {
	delivery = "reliable-ordered" as const;
	state: TraversalMessageChannel["state"] = "open";
	bufferedAmount = 0;
	held = false;
	deferredDelivery = false;
	dropped = 0;
	private pumping = false;
	peer?: MemoryChannel;
	readonly sent: Uint8Array[] = [];
	readonly messages = new Set<(frame: unknown) => void>();
	readonly drains = new Set<() => void>();
	readonly closes = new Set<() => void>();
	readonly retiredMessages: ((frame: unknown) => void)[] = [];
	readonly retiredDrains: (() => void)[] = [];
	readonly retiredCloses: (() => void)[] = [];
	readonly queued: Uint8Array[] = [];
	disposals = 0;
	subscriptions = 0;
	failSubscription?: "message" | "drain" | "close";
	disposalError?: Error;
	neverDispose = false;
	sendError?: Error;

	send(frame: Uint8Array): void {
		if (this.sendError) throw this.sendError;
		if (this.state !== "open") throw new Error("Test port is closed");
		const copy = Uint8Array.from(frame);
		this.sent.push(copy);
		this.queued.push(copy);
		if (this.deferredDelivery) {
			// SDK acceptance is not evidence that the peer has received the frame.
			this.pump();
			this.notifyDrain();
			return;
		}
		this.bufferedAmount += copy.length;
		if (!this.held) queueMicrotask(() => this.release());
	}

	private pump(): void {
		if (this.pumping) return;
		this.pumping = true;
		schedule(() => {
			this.pumping = false;
			const frame = this.queued.shift();
			if (frame && this.state === "open" && this.peer?.state === "open") {
				this.peer.emitMessage(frame);
			}
			if (this.queued.length > 0) this.pump();
		});
	}

	release(): void {
		this.held = false;
		const frames = this.queued.splice(0);
		queueMicrotask(() => {
			for (const frame of frames) this.peer?.emitMessage(frame);
			this.bufferedAmount = 0;
			for (const listener of this.drains) listener();
		});
	}

	inject(frame: unknown): void {
		queueMicrotask(() => this.emitMessage(frame));
	}

	private emitMessage(frame: unknown): void {
		for (const listener of this.messages) listener(frame);
	}

	notifyDrain(): void {
		queueMicrotask(() => {
			for (const listener of this.drains) listener();
		});
	}

	close(): void {
		this.state = "closing";
		queueMicrotask(() => {
			this.state = "closed";
			for (const listener of this.closes) listener();
		});
	}

	onMessage(listener: (frame: unknown) => void): () => void {
		this.subscriptions++;
		if (this.failSubscription === "message") throw new Error("Subscription failed");
		this.messages.add(listener);
		return () => {
			this.messages.delete(listener);
			this.retiredMessages.push(listener);
		};
	}

	onDrain(listener: () => void): () => void {
		this.subscriptions++;
		if (this.failSubscription === "drain") throw new Error("Subscription failed");
		this.drains.add(listener);
		return () => {
			this.drains.delete(listener);
			this.retiredDrains.push(listener);
		};
	}

	onClose(listener: () => void): () => void {
		this.subscriptions++;
		if (this.failSubscription === "close") throw new Error("Subscription failed");
		this.closes.add(listener);
		return () => {
			this.closes.delete(listener);
			this.retiredCloses.push(listener);
		};
	}

	async dispose(): Promise<void> {
		this.disposals++;
		if (this.neverDispose) return new Promise(() => {});
		if (this.disposalError) throw this.disposalError;
		if (this.deferredDelivery) {
			this.dropped += this.queued.splice(0).length;
			if (this.peer) this.peer.dropped += this.peer.queued.splice(0).length;
		}
		this.close();
		this.peer?.close();
	}

	get listeners(): number {
		return this.messages.size + this.drains.size + this.closes.size;
	}
}

export function channelPair(
	options: { deferredDelivery?: boolean } = {},
): [MemoryChannel, MemoryChannel] {
	const left = new MemoryChannel();
	const right = new MemoryChannel();
	left.peer = right;
	right.peer = left;
	left.deferredDelivery = right.deferredDelivery = options.deferredDelivery ?? false;
	return [left, right];
}

/** Flush microtasks and Node stream nextTicks, without advancing deadline timers. */
export async function flush(): Promise<void> {
	await setImmediate();
}
