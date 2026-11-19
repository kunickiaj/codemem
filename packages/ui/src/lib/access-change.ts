/** What a device without the coordinator admin secret sees when the Viewer refuses an access change. */
export function accessChangeRefusalMessage(error: unknown): string | null {
	if (!(error instanceof Error) || error.message !== "access_change_needs_admin_device")
		return null;
	return "Only a device that holds the coordinator admin secret can change who receives Projects. Nothing changed. Make the change on that device.";
}
