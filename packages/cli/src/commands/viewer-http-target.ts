const DEFAULT_VIEWER_PORT = 38888;

/** Keep operator recovery and prompt transport on the same loopback host policy. */
export function viewerBaseUrl(
	env: NodeJS.ProcessEnv,
	opts: { rejectInvalidPort?: boolean } = {},
): string | null {
	const configuredHost = env.CODEMEM_VIEWER_HOST?.trim() || "127.0.0.1";
	const host = configuredHost.toLowerCase().replace(/^\[(.*)\]$/, "$1");
	const ipv4 = host.split(".");
	const isIpv4Loopback =
		ipv4.length === 4 &&
		ipv4[0] === "127" &&
		ipv4.every(
			(part) => /^\d+$/.test(part) && String(Number(part)) === part && Number(part) <= 255,
		);
	let urlHost: string;
	if (host === "localhost" || isIpv4Loopback) urlHost = host;
	else if (host === "::1" || host === "0:0:0:0:0:0:0:1") urlHost = "[::1]";
	else return null;
	const portText = env.CODEMEM_VIEWER_PORT?.trim() || String(DEFAULT_VIEWER_PORT);
	const port = Number(portText);
	const validPort =
		/^\d+$/.test(portText) &&
		Number.isSafeInteger(port) &&
		port >= 1 &&
		port <= 65535 &&
		String(port) === portText;
	if (!validPort && opts.rejectInvalidPort) return null;
	const safePort = validPort ? port : DEFAULT_VIEWER_PORT;
	return `http://${urlHost}:${safePort}`;
}
