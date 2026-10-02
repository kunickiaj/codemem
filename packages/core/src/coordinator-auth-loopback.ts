export type CoordinatorAuthLoopbackResult =
	| { ok: true; destination: string; host: "127.0.0.1" | "[::1]"; port: number }
	| { ok: false; error: "invalid_loopback_destination" };

const LOOPBACK_DESTINATION =
	/^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]*)\/codemem\/auth\/complete$/;

export function parseCoordinatorAuthLoopback(value: unknown): CoordinatorAuthLoopbackResult {
	if (typeof value !== "string") return { ok: false, error: "invalid_loopback_destination" };
	const match = LOOPBACK_DESTINATION.exec(value);
	if (!match || match[0] !== value) return { ok: false, error: "invalid_loopback_destination" };

	const port = Number(match[2]);
	if (port > 65535) return { ok: false, error: "invalid_loopback_destination" };

	return {
		ok: true,
		destination: value,
		host: match[1] as "127.0.0.1" | "[::1]",
		port,
	};
}
