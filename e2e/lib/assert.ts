export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(message);
	}
}

export function assertStatus(status: number | null, expected: number, message: string): void {
	if (status !== expected) {
		throw new Error(`${message} (expected exit ${expected}, got ${status ?? "null"})`);
	}
}
