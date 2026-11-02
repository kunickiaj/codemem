import {
	decodeTraversalSignalPacket,
	encodeTraversalSignalPacket,
	type TraversalSignalPacket,
} from "./peer-traversal-signal-codec.js";

export type TraversalSignalEnvelopeType = "traversal-offer" | "traversal-answer";
export interface TraversalSignalEnvelope {
	readonly v: 1;
	readonly type: TraversalSignalEnvelopeType;
	readonly packets: readonly [Readonly<TraversalSignalPacket>, Readonly<TraversalSignalPacket>];
}
export interface TraversalSignalCarrier {
	publish(envelope: unknown): boolean;
	take(type: TraversalSignalEnvelopeType): TraversalSignalEnvelope | null;
	close(): void;
}

function captureEnvelope(value: unknown, sessionId: string): TraversalSignalEnvelope | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== 3 || !["v", "type", "packets"].every((key) => keys.includes(key)))
		return null;
	const { v, type, packets } = value as Record<string, unknown>;
	if (
		v !== 1 ||
		(type !== "traversal-offer" && type !== "traversal-answer") ||
		!Array.isArray(packets) ||
		packets.length !== 2
	)
		return null;
	const first = decodeTraversalSignalPacket(packets[0]);
	const second = decodeTraversalSignalPacket(packets[1]);
	const phases = type === "traversal-offer" ? ["prepare", "offer"] : ["offer-check", "answer"];
	if (
		first.value.sessionId !== sessionId ||
		second.value.sessionId !== sessionId ||
		first.value.phase !== phases[0] ||
		second.value.phase !== phases[1]
	)
		return null;
	return Object.freeze({
		v,
		type,
		packets: Object.freeze([
			Object.freeze(encodeTraversalSignalPacket(first)),
			Object.freeze(encodeTraversalSignalPacket(second)),
		] as const),
	});
}

/** One local attempt with two single-use slots. Format checks do not authenticate
 * peers or approve descriptions. Closing drops references without secure-erasure claims. */
export function createTraversalSignalCarrier(
	options: { readonly sessionId: string; readonly deadlineMs: number },
	deps?: { readonly now?: () => number },
): TraversalSignalCarrier | null {
	try {
		const { sessionId, deadlineMs } = options;
		const clock = deps?.now;
		if (clock !== undefined && typeof clock !== "function") return null;
		const now = clock === undefined ? performance.now.bind(performance) : clock.bind(deps);
		const start = now();
		if (
			typeof sessionId !== "string" ||
			sessionId.length !== 32 ||
			!/^[0-9a-f]{32}$/.test(sessionId) ||
			!Number.isFinite(start) ||
			start < 0 ||
			!Number.isFinite(deadlineMs) ||
			deadlineMs <= start ||
			deadlineMs - start > 55000
		)
			return null;
		return createSlots({ sessionId, deadlineMs, start, now });
	} catch {
		return null;
	}
}

function createSlots(input: {
	sessionId: string;
	deadlineMs: number;
	start: number;
	now: () => number;
}): TraversalSignalCarrier {
	let offer: TraversalSignalEnvelope | null = null;
	let answer: TraversalSignalEnvelope | null = null;
	let offered = false;
	let answered = false;
	let closed = false;
	let last = input.start;
	const close = () => {
		closed = true;
		offer = null;
		answer = null;
		clearTimeout(timer);
	};
	const timer = setTimeout(close, input.deadlineMs - input.start);
	const live = () => {
		if (closed) return false;
		try {
			const current = input.now();
			if (Number.isFinite(current) && current >= last && current < input.deadlineMs) {
				last = current;
				return true;
			}
		} catch {
			/* Unknown clocks close the attempt through the same path as expiry. */
		}
		close();
		return false;
	};
	return Object.freeze({
		publish: (value: unknown) => {
			if (!live()) return false;
			try {
				const envelope = captureEnvelope(value, input.sessionId);
				if (!envelope || !live()) return false;
				if (envelope.type === "traversal-offer") {
					if (offered) return false;
					offered = true;
					offer = envelope;
				} else {
					if (answered) return false;
					answered = true;
					answer = envelope;
				}
				return true;
			} catch {
				return false;
			}
		},
		take: (type: TraversalSignalEnvelopeType) => {
			if (!live()) return null;
			if (type === "traversal-offer") {
				const result = offer;
				offer = null;
				return result;
			}
			if (type !== "traversal-answer") return null;
			const result = answer;
			answer = null;
			return result;
		},
		close,
	});
}
