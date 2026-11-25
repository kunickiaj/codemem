/** Display-only: a malformed marker is dropped, so it can never change what the Viewer shows or allows. */
export function isRejoinTimestamp(value: unknown): value is number {
	// 8.64e15 is the largest millisecond value a Date can hold.
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8.64e15;
}
