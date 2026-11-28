export type CanaryDirection = "sender-to-receiver" | "receiver-to-sender";
export type CanaryObservation = { direction: CanaryDirection; id: string };

/** Only fixture body markers count. The import key also travels in metadata. */
export function observeCanaries(text: string, direction: CanaryDirection): CanaryObservation[] {
	const pattern =
		/offline-proof-synthetic-body:(memory-source-v1:[\w-]+:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?=\\?")/gu;
	return Array.from(text.matchAll(pattern), ([, id]) => ({ direction, id: id! }));
}
