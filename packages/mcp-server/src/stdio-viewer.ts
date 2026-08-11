import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_VIEWER_HOST = "127.0.0.1";
const DEFAULT_VIEWER_PORT = "38888";
const VIEWER_PROBE_TIMEOUT_MS = 2_000;
const VIEWER_POLL_INTERVAL_MS = 1_000;
const VIEWER_POLL_ATTEMPTS = 5;

export interface ViewerChildProcess {
	on(event: "error", listener: () => void): unknown;
	unref(): void;
}

export type SpawnViewerProcess = (
	command: string,
	args: string[],
	options: {
		detached: true;
		stdio: "ignore";
		env: NodeJS.ProcessEnv;
	},
) => ViewerChildProcess;

export interface ViewerProbeOptions {
	host?: string;
	port?: string;
	fetchImpl?: typeof fetch;
}

export interface EnsureViewerOptions extends ViewerProbeOptions {
	env?: NodeJS.ProcessEnv;
	execPath?: string;
	resolveCliPath?: () => string | null;
	sleep?: (milliseconds: number) => Promise<void>;
	spawnImpl?: SpawnViewerProcess;
}

/** Resolve the `codemem` CLI binary path. Checks package-local paths first, then PATH. */
export function resolveCliPath(): string | null {
	const selfDir = dirname(import.meta.dirname ?? ".");
	const candidates = [
		join(selfDir, "..", "cli", "dist", "index.js"),
		join(selfDir, "..", ".bin", "codemem"),
		join(selfDir, "..", "..", ".bin", "codemem"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return "codemem";
}

/** Check for a live CodeMem viewer, with one old-viewer compatibility probe on health 404. */
export async function isViewerHealthy(options: ViewerProbeOptions = {}): Promise<boolean> {
	const host = options.host ?? process.env.CODEMEM_VIEWER_HOST ?? DEFAULT_VIEWER_HOST;
	const port = options.port ?? process.env.CODEMEM_VIEWER_PORT ?? DEFAULT_VIEWER_PORT;
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = `http://${host}:${port}`;

	try {
		const response = await fetchImpl(`${baseUrl}/api/health`, {
			signal: AbortSignal.timeout(VIEWER_PROBE_TIMEOUT_MS),
		});
		if (response.status === 404) {
			// Old-viewer compatibility: every released viewer's stats payload
			// includes `viewer_pid`, so require that identifying evidence
			// rather than trusting any 2xx from an arbitrary local service.
			const compatibilityResponse = await fetchImpl(`${baseUrl}/api/stats`, {
				signal: AbortSignal.timeout(VIEWER_PROBE_TIMEOUT_MS),
			});
			if (!compatibilityResponse.ok) return false;
			try {
				const stats: unknown = await compatibilityResponse.json();
				if (!stats || typeof stats !== "object" || Array.isArray(stats)) return false;
				const viewerPid = (stats as { viewer_pid?: unknown }).viewer_pid;
				return typeof viewerPid === "number" && Number.isSafeInteger(viewerPid) && viewerPid > 0;
			} catch {
				return false;
			}
		}
		if (!response.ok) return false;

		const body: unknown = await response.json();
		return (
			typeof body === "object" &&
			body !== null &&
			"service" in body &&
			body.service === "codemem-viewer"
		);
	} catch {
		return false;
	}
}

/** Attempt to start the viewer as a detached, best-effort background process. */
export async function ensureViewer(options: EnsureViewerOptions = {}): Promise<void> {
	const env = options.env ?? process.env;
	if (env.CODEMEM_VIEWER === "0" || env.CODEMEM_VIEWER_AUTO === "0") return;

	const host = options.host ?? env.CODEMEM_VIEWER_HOST ?? DEFAULT_VIEWER_HOST;
	const port = options.port ?? env.CODEMEM_VIEWER_PORT ?? DEFAULT_VIEWER_PORT;
	const probeOptions = { host, port, fetchImpl: options.fetchImpl };
	if (await isViewerHealthy(probeOptions)) return;

	const cli = (options.resolveCliPath ?? resolveCliPath)();
	if (!cli) return;

	try {
		const isJsFile = cli.endsWith(".js");
		const command = isJsFile ? (options.execPath ?? process.execPath) : cli;
		const args = isJsFile ? [cli, "serve", "start"] : ["serve", "start"];
		if (host !== DEFAULT_VIEWER_HOST) args.push("--host", host);
		if (port !== DEFAULT_VIEWER_PORT) args.push("--port", port);

		const spawnImpl: SpawnViewerProcess =
			options.spawnImpl ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
		const child = spawnImpl(command, args, {
			detached: true,
			stdio: "ignore",
			env: { ...env, CODEMEM_PLUGIN_IGNORE: "1" },
		});
		child.on("error", () => {});
		child.unref();

		const sleep =
			options.sleep ??
			((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
		for (let attempt = 0; attempt < VIEWER_POLL_ATTEMPTS; attempt++) {
			await sleep(VIEWER_POLL_INTERVAL_MS);
			if (await isViewerHealthy(probeOptions)) return;
		}
	} catch {
		// Best effort — MCP server continues regardless.
	}
}
