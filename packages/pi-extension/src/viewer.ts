/**
 * Viewer discovery + auto-start + stream backoff (opencode-plugin pattern).
 *
 * Factory must not start processes — call ensureViewerRunning from session_start
 * (or first need). stopViewerTracking is idempotent for session_shutdown.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { PiExtensionConfig } from "./config.js";

const DEFAULT_EMBEDDING_MODEL = "Xenova/bge-small-en-v1.5";
const DEFAULT_EMBEDDING_REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
const VIEWER_TARGET_CONFLICT_CODES = [
	"viewer_db_mismatch",
	"viewer_identity_mismatch",
	"viewer_contract_unsupported",
];
const PROMPT_TRANSPORT_PROTOCOL_RANGE = {
	minSupportedProtocolVersion: 1,
	protocolVersion: 1,
} as const;

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

export function promptPackProfileUrl(config: PiExtensionConfig): string {
	return `${viewerBaseUrl(config)}/api/prompt-pack-profile`;
}

export function apiUrl(config: PiExtensionConfig, path: string): string {
	const normalized = path.startsWith("/") ? path : `/${path}`;
	return `${viewerBaseUrl(config)}${normalized}`;
}

function normalizeIdentityPath(
	value: string | undefined,
	cwd: string,
	env: NodeJS.ProcessEnv,
): string | null {
	const trimmed = String(value || "").trim();
	if (!trimmed) return null;
	const expanded = trimmed.startsWith("~/")
		? join(env.HOME?.trim() || homedir(), trimmed.slice(2))
		: trimmed;
	return resolve(cwd, expanded);
}

/** Resolve CODEMEM_DB the same way the OpenCode plugin does. */
export function resolveViewerDbPath(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	const raw = env.CODEMEM_DB?.trim() || "";
	const expanded = raw.startsWith("~/") ? join(env.HOME?.trim() || homedir(), raw.slice(2)) : raw;
	return resolve(cwd, expanded || join(homedir(), ".codemem", "mem.sqlite"));
}

/** Duplicate of plugin runtime.js identity keys — do not import @codemem/core. */
export function buildViewerIdentityTarget(
	env: NodeJS.ProcessEnv = process.env,
	cwd: string = process.cwd(),
) {
	const embeddingModel = env.CODEMEM_EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;
	let embeddingRevision = env.CODEMEM_EMBEDDING_REVISION?.trim() || null;
	if (!embeddingRevision && embeddingModel === DEFAULT_EMBEDDING_MODEL) {
		embeddingRevision = DEFAULT_EMBEDDING_REVISION;
	}
	return {
		device_id: env.CODEMEM_DEVICE_ID?.trim() || null,
		actor_id_present: Object.hasOwn(env, "CODEMEM_ACTOR_ID"),
		actor_id: env.CODEMEM_ACTOR_ID?.trim() || null,
		config_path: normalizeIdentityPath(env.CODEMEM_CONFIG, cwd, env),
		runtime_root: normalizeIdentityPath(env.CODEMEM_RUNTIME_ROOT, cwd, env),
		workspace_id: env.CODEMEM_WORKSPACE_ID?.trim() || null,
		home_dir: normalizeIdentityPath(env.HOME || homedir(), cwd, env),
		pack_compression: env.CODEMEM_PACK_COMPRESSION?.trim() || null,
		embedding_disabled: ["1", "true", "yes"].includes(
			String(env.CODEMEM_EMBEDDING_DISABLED || "").toLowerCase(),
		),
		embedding_offline: ["1", "true", "yes"].includes(
			String(env.CODEMEM_EMBEDDING_OFFLINE || "").toLowerCase(),
		),
		embedding_model: embeddingModel,
		embedding_revision: embeddingRevision,
	};
}

export function viewerRequestTarget(cwd: string, env: NodeJS.ProcessEnv = process.env) {
	return {
		db_path: resolveViewerDbPath(cwd, env),
		identity_target: buildViewerIdentityTarget(env, cwd),
	};
}

export function isViewerTargetConflict(status: number, body: unknown): boolean {
	if (status !== 409 || body == null || typeof body !== "object" || Array.isArray(body)) {
		return false;
	}
	const error = (body as Record<string, unknown>).error;
	if (error == null || typeof error !== "object" || Array.isArray(error)) return false;
	return VIEWER_TARGET_CONFLICT_CODES.includes(
		String((error as Record<string, unknown>).code ?? ""),
	);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

/** Renderer-owned pack item spans (core PackResponse.rendered_items). */
export type RenderedPackItem = {
	id: number;
	fingerprint: string;
	spans: Array<{ start: number; end: number }>;
};

/** Successful proven pack body; null when unproven, failing, or non-JSON. */
export type ProvenPack = {
	packText: string;
	/** Present only when the response carried renderer span data. */
	renderedItems?: RenderedPackItem[];
	/** metrics.total_items from the same response. */
	itemCount?: number;
	/** metrics.pack_tokens from the same response, when present. */
	packTokens?: number;
};

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function normalizeProtocolRange(
	protocolVersion: unknown,
	minSupportedProtocolVersion?: unknown,
): { minSupportedProtocolVersion: number; protocolVersion: number } | null {
	if (!Number.isSafeInteger(protocolVersion) || Number(protocolVersion) < 1) return null;
	const minimum =
		minSupportedProtocolVersion === undefined ? protocolVersion : minSupportedProtocolVersion;
	if (
		!Number.isSafeInteger(minimum) ||
		Number(minimum) < 1 ||
		Number(minimum) > Number(protocolVersion)
	) {
		return null;
	}
	return {
		minSupportedProtocolVersion: Number(minimum),
		protocolVersion: Number(protocolVersion),
	};
}

export function profileMatchesViewerTarget(
	profile: unknown,
	dbPath: string,
	identity: unknown,
): boolean {
	if (!isRecord(profile) || profile.service !== "codemem-viewer") return false;
	const range = normalizeProtocolRange(
		profile.protocol_version,
		profile.min_supported_protocol_version,
	);
	if (!range) return false;
	if (
		PROMPT_TRANSPORT_PROTOCOL_RANGE.minSupportedProtocolVersion > range.protocolVersion ||
		range.minSupportedProtocolVersion > PROMPT_TRANSPORT_PROTOCOL_RANGE.protocolVersion
	) {
		return false;
	}
	if (profile.db_path !== dbPath) return false;
	return canonicalJson(profile.identity_target) === canonicalJson(identity);
}

async function readJson(res: Response): Promise<unknown> {
	try {
		return await res.json();
	} catch {
		return null;
	}
}

/**
 * PackResponse contract check. A valid zero-item pack has a string `pack_text`
 * and numeric `metrics.total_items` (0 is success). `{}`, a non-string `pack_text`,
 * a missing item count, a non-array `rendered_items`, or an `error` field is not a pack.
 */
export function parseProvenPack(body: unknown): ProvenPack | null {
	if (!isRecord(body) || "error" in body) return null;
	if (typeof body.pack_text !== "string") return null;
	if (!isRecord(body.metrics)) return null;
	const totalItems = body.metrics.total_items;
	if (typeof totalItems !== "number" || !Number.isFinite(totalItems)) return null;
	const pack: ProvenPack = { packText: body.pack_text.trim(), itemCount: totalItems };
	const packTokens = body.metrics.pack_tokens;
	if (typeof packTokens === "number" && Number.isFinite(packTokens)) pack.packTokens = packTokens;
	if (body.rendered_items === undefined) return pack;
	if (!Array.isArray(body.rendered_items)) return null;
	pack.renderedItems = body.rendered_items as RenderedPackItem[];
	return pack;
}

/**
 * GET /api/prompt-pack-profile, then POST /api/pack with db_path + identity_target.
 * Returns a contract-valid pack, including a zero-item pack; null means unproven,
 * failed, or a body that is not a PackResponse, and the caller may fall back.
 */
export async function proveAndPostPack(
	config: PiExtensionConfig,
	args: {
		context: string;
		cwd: string;
		project: string | null;
		signal: AbortSignal;
		limit?: number;
		tokenBudget?: number;
	},
): Promise<ProvenPack | null> {
	if (!config.viewerEnabled) return null;
	const target = viewerRequestTarget(args.cwd);
	const profileRes = await fetch(promptPackProfileUrl(config), {
		method: "GET",
		redirect: "manual",
		signal: args.signal,
	});
	if (profileRes.status >= 300 && profileRes.status < 400) return null;
	if (!profileRes.ok) return null;
	if (
		!profileMatchesViewerTarget(await readJson(profileRes), target.db_path, target.identity_target)
	) {
		return null;
	}
	const res = await fetch(packUrl(config), {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			context: args.context,
			limit: args.limit ?? config.injectLimit,
			token_budget: args.tokenBudget ?? config.injectTokenBudget,
			...(args.project ? { project: args.project } : {}),
			...target,
		}),
		signal: args.signal,
	});
	if (!res.ok) return null;
	return parseProvenPack(await readJson(res));
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
	if (!config.viewerEnabled) return false;
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
