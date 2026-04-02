export async function waitFor(
	check: () => Promise<void>,
	options: { timeoutMs?: number; intervalMs?: number; description: string },
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 60_000;
	const intervalMs = options.intervalMs ?? 1_000;
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			await check();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, intervalMs));
		}
	}
	throw new Error(
		`Timed out waiting for ${options.description}${
			lastError instanceof Error ? `: ${lastError.message}` : ""
		}`,
	);
}
