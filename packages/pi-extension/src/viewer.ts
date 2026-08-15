/**
 * Viewer discovery + auto-start + stream backoff (opencode-plugin pattern).
 *
 * Factory must not start processes — call ensureViewerRunning from session_start
 * (or first need). stopViewerTracking is idempotent for session_shutdown.
 */

import { spawn } from "node:child_process";
import type { PiExtensionConfig } from "./config.js";

export type ViewerRuntime = {
	/** True when this runtime started the viewer (for optional stop). */
	startedByUs: boolean;
	streamUnavailableUntil: number;
	lastStatusCheckAt: number;
	lastStatusAvailable: boolean;
};

export function createViewerRuntime(): ViewerRuntime {
	return {
		startedByUs: false,
		streamUnavailableUntil: 0,
		lastStatusCheckAt: 0,
		lastStatusAvailable: true,
	};
}

function viewerBaseUrl(config: PiExtensionConfig): string {
	return `http://${config.viewerHost}:${config.viewerPort}`;
}

export function rawEventsStatusUrl(config: PiExtensionConfig): string {
	return `${viewerBaseUrl(config)}/api/raw-events/status?limit=1`;
}

export function piHooksUrl(config: PiExtensionConfig): string {
	return `${viewerBaseUrl(config)}/api/pi-hooks`;
}

export function packUrl(config: PiExtensionConfig): string {
	return `${viewerBaseUrl(config)}/api/pack`;
}

export function apiUrl(config: PiExtensionConfig, path: string): string {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	return `${viewerBaseUrl(config)}${normalized}`;
}

/** Probe viewer with a cheap GET. Returns true when reachable. */
export async function probeViewer(
	config: PiExtensionConfig,
	signal?: AbortSignal,
): Promise<boolean> {
	if (!config.viewerEnabled) return false;
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	const timeout = setTimeout(() => controller.abort(), Math.min(config.httpTimeoutMs, 2000));
	try {
		const res = await fetch(rawEventsStatusUrl(config), {
			method: "GET",
			signal: controller.signal,
		});
		return res.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
		signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * Auto-start `codemem serve start --host --port` when enabled and not already up.
 * Fire-and-forget detached spawn (matches opencode-plugin).
 */
export async function ensureViewerRunning(
	config: PiExtensionConfig,
	runtime: ViewerRuntime,
	opts: { cwd?: string; signal?: AbortSignal } = {},
): Promise<boolean> {
	if (!config.viewerEnabled) return false;
	if (await probeViewer(config, opts.signal)) {
		return true;
	}
	if (!config.viewerAutoStart) return false;
	if (runtime.startedByUs) {
		// Already attempted this session — re-probe only.
		return probeViewer(config, opts.signal);
	}

	runtime.startedByUs = true;
	const args = ["serve", "start", "--host", config.viewerHost, "--port", String(config.viewerPort)];
	const dbPath = process.env.CODEMEM_DB?.trim();
	if (dbPath) args.push("--db-path", dbPath);
	const configPath = process.env.CODEMEM_CONFIG?.trim();
	if (configPath) args.push("--config", configPath);

	try {
		const child = spawn("codemem", args, {
			cwd: opts.cwd || process.cwd(),
			env: process.env,
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {
			// best-effort; CLI fallback remains available
		});
		child.unref();
	} catch {
		// spawn failed — HTTP will keep failing and CLI fallback handles ingest
	}

	// Brief settle so the first POST has a chance to hit a live server.
	await sleep(400, opts.signal);
	return probeViewer(config, opts.signal);
}

export function markStreamFailure(config: PiExtensionConfig, runtime: ViewerRuntime): void {
	runtime.streamUnavailableUntil = Date.now() + Math.max(1000, config.rawEventsBackoffMs);
}

export function clearStreamFailure(runtime: ViewerRuntime): void {
	runtime.streamUnavailableUntil = 0;
	runtime.lastStatusAvailable = true;
}

export function isStreamInBackoff(runtime: ViewerRuntime): boolean {
	return Date.now() < runtime.streamUnavailableUntil;
}

/**
 * Optional status check with caching (CODEMEM_RAW_EVENTS_STATUS_CHECK_MS).
 * Returns false when ingest is known unavailable.
 */
export async function checkIngestAvailable(
	config: PiExtensionConfig,
	runtime: ViewerRuntime,
	signal?: AbortSignal,
): Promise<boolean> {
	const now = Date.now();
	if (now - runtime.lastStatusCheckAt < Math.max(1000, config.rawEventsStatusCheckMs)) {
		return runtime.lastStatusAvailable;
	}
	try {
		const controller = new AbortController();
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort, { once: true });
		const timeout = setTimeout(() => controller.abort(), Math.min(config.httpTimeoutMs, 2000));
		try {
			const res = await fetch(rawEventsStatusUrl(config), {
				method: "GET",
				signal: controller.signal,
			});
			if (!res.ok) {
				runtime.lastStatusAvailable = false;
			} else {
				const body = (await res.json()) as { ingest?: { available?: boolean } };
				runtime.lastStatusAvailable = body?.ingest?.available !== false;
			}
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		}
	} catch {
		runtime.lastStatusAvailable = false;
	}
	runtime.lastStatusCheckAt = now;
	return runtime.lastStatusAvailable;
}

/** Idempotent session_shutdown cleanup — no hard kill of shared viewer by default. */
export function stopViewerTracking(runtime: ViewerRuntime): void {
	runtime.startedByUs = false;
	runtime.streamUnavailableUntil = 0;
	runtime.lastStatusCheckAt = 0;
	runtime.lastStatusAvailable = true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
