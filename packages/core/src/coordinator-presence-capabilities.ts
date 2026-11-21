/** Expose only the capabilities the device listing consumes. */
export function selectDeviceListingCapabilities(capabilities: Record<string, unknown>) {
	const { sync_capability, sync_features, applied_removal_seq } = capabilities;
	const sync = { sync_capability, sync_features };
	if (
		typeof applied_removal_seq !== "number" ||
		!Number.isSafeInteger(applied_removal_seq) ||
		applied_removal_seq < 0
	)
		return sync;
	return { ...sync, applied_removal_seq };
}
