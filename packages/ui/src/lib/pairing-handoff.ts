/**
 * Sharing reviews an invitation code and hands a device pairing code to Devices, so the
 * person does not retype it. The code waits here until the Devices pairing form takes it.
 * Devices stays mounted while Sharing is open, so a form that is already open listens for
 * a code that arrives later.
 */
let pendingPairingCode: string | null = null;
const listeners = new Set<() => void>();

export function setPendingPairingCode(code: string): void {
	const trimmed = code.trim();
	pendingPairingCode = trimmed || null;
	if (pendingPairingCode) for (const listener of [...listeners]) listener();
}

export function hasPendingPairingCode(): boolean {
	return pendingPairingCode !== null;
}

/** Returns the waiting code once and clears it. */
export function takePendingPairingCode(): string | null {
	const code = pendingPairingCode;
	pendingPairingCode = null;
	return code;
}

/** Calls `listener` whenever a code is handed over. Returns a function that stops listening. */
export function onPendingPairingCode(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
