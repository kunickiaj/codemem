/**
 * Sharing reviews an invitation code and hands a device pairing code to Devices, so the
 * person does not retype it. The code waits here until the Devices pairing form opens.
 */
let pendingPairingCode: string | null = null;

export function setPendingPairingCode(code: string): void {
	const trimmed = code.trim();
	pendingPairingCode = trimmed || null;
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
