#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildRawEventEnvelopeFromHook,
	TRUSTED_HOOK_MAPPER_OPTIONS,
} from "./codemem-normalizer.mjs";
import {
	identityTarget,
	resolveDbPath,
	trackClaudeSessionState,
	viewerBaseUrl,
} from "./user-prompt-hook.mjs";

const MAX_BODY_BYTES = 1_048_576;
const BOUNDARY_DEADLINE_MARGIN_MS = 50;
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || dirname(scriptDirectory);

function boundaryFallbackReserveMs(hostBudget) {
	const usableBudget = Math.max(1, hostBudget - BOUNDARY_DEADLINE_MARGIN_MS);
	const preferredReserve = Math.min(5000, Math.max(500, Math.floor(hostBudget / 10)));
	return Math.max(1, Math.min(preferredReserve, Math.floor(usableBudget / 2)));
}

function isTruthy(value) {
	return ["1", "true", "yes", "on"].includes(
		String(value ?? "")
			.trim()
			.toLowerCase(),
	);
}

function envTruthy(env, name, fallback) {
	const value = env[name];
	if (value === undefined) return fallback;
	const normalized = String(value).trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

export function boundaryTimeoutMs(payload, env = process.env) {
	const parsed = Number.parseInt(env.CODEMEM_CLAUDE_HOOK_BOUNDARY_TIMEOUT_MS ?? "", 10);
	const hostBudget = boundaryExecutionBudgetMs(payload, env);
	if (hostBudget == null) return Number.isFinite(parsed) && parsed > 0 ? parsed : 125_000;
	const fallbackReserve = boundaryFallbackReserveMs(hostBudget);
	const usableBudget = Math.max(1, hostBudget - BOUNDARY_DEADLINE_MARGIN_MS);
	const maxRequestBudget = Math.max(1, usableBudget - fallbackReserve);
	return Number.isFinite(parsed) && parsed > 0
		? Math.min(parsed, maxRequestBudget)
		: maxRequestBudget;
}

export function boundaryExecutionBudgetMs(payload, env = process.env) {
	if (payload.hook_event_name === "Stop") {
		const configuredBudget = Number.parseInt(env.CODEMEM_CLAUDE_HOOK_BOUNDARY_TIMEOUT_MS ?? "", 10);
		return Number.isFinite(configuredBudget) && configuredBudget > 0 ? configuredBudget : 125_000;
	}
	if (payload.hook_event_name !== "SessionEnd") return null;
	const configuredHostBudget = Number.parseInt(
		env.CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS ?? "",
		10,
	);
	return Number.isFinite(configuredHostBudget) && configuredHostBudget > 0
		? configuredHostBudget
		: 1500;
}

export function shouldForceBoundaryFlush(payload, env = process.env) {
	// Keep this policy in sync with packages/cli/src/commands/claude-hook-ingest-spool.ts.
	const eventName =
		typeof payload.hook_event_name === "string" ? payload.hook_event_name.trim() : "";
	if (eventName === "SessionEnd") return envTruthy(env, "CODEMEM_CLAUDE_HOOK_FLUSH", true);
	if (eventName !== "Stop") return false;
	return (
		envTruthy(env, "CODEMEM_CLAUDE_HOOK_FLUSH", false) &&
		envTruthy(env, "CODEMEM_CLAUDE_HOOK_FLUSH_ON_STOP", false)
	);
}

function log(message) {
	const configured = process.env.CODEMEM_PLUGIN_LOG_PATH || process.env.CODEMEM_PLUGIN_LOG;
	const path =
		!configured || ["0", "1", "false", "off", "true", "yes"].includes(configured)
			? join(homedir(), ".codemem", "plugin.log")
			: configured;
	try {
		mkdirSync(dirname(path), { recursive: true });
		appendFileSync(path, `${new Date().toISOString()} ${message}\n`);
	} catch {
		// Logging must not turn best-effort ingestion into a hook failure.
	}
}

async function readStdin() {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of process.stdin) {
		const buffer = Buffer.from(chunk);
		bytes += buffer.byteLength;
		if (bytes > MAX_BODY_BYTES) throw new Error("payload too large");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function pinnedVersion() {
	try {
		const manifest = JSON.parse(
			readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"),
		);
		return typeof manifest.version === "string" && manifest.version.trim()
			? manifest.version.trim()
			: "latest";
	} catch {
		return "latest";
	}
}

export async function postEnvelope(body, overrides = {}) {
	const env = overrides.env ?? process.env;
	const baseUrl = viewerBaseUrl(env);
	if (!baseUrl) return false;
	try {
		const envelope = JSON.parse(body);
		const cwd =
			typeof envelope.cwd === "string" && envelope.cwd.trim() ? envelope.cwd : process.cwd();
		const response = await (overrides.fetchImpl ?? fetch)(`${baseUrl}/api/raw-events`, {
			method: "POST",
			redirect: "manual",
			headers: {
				"Content-Type": "application/json",
				...(overrides.flushBoundary ? { "X-Codemem-Boundary-Flush": "1" } : {}),
			},
			body: JSON.stringify({
				...envelope,
				db_path: resolveDbPath(cwd, env),
				identity_target: identityTarget(cwd, env),
			}),
			signal: AbortSignal.timeout(overrides.timeoutMs ?? 5000),
		});
		if (response.status >= 300 && response.status < 400) return false;
		if (!response.ok) {
			if (response.status !== 409) return false;
			const errorBody = await response.json().catch(() => null);
			const code = errorBody?.error?.code;
			return [
				"viewer_db_mismatch",
				"viewer_identity_mismatch",
				"viewer_contract_unsupported",
			].includes(code)
				? "target_mismatch"
				: false;
		}
		const result = await response.json();
		return (
			result != null &&
			typeof result === "object" &&
			typeof result.inserted === "number" &&
			typeof result.skipped === "number"
		);
	} catch {
		return false;
	}
}

function runFallback(command, args, body, timeoutMs = 8000) {
	const startedAt = Date.now();
	const result = spawnSync(command, args, {
		input: body,
		encoding: "utf8",
		stdio: ["pipe", "ignore", "pipe"],
		timeout: timeoutMs,
	});
	if (result.status === 0) return true;
	const excerpt = [...String(result.stderr ?? "").slice(0, 400)]
		.map((character) => {
			const code = character.charCodeAt(0);
			return code <= 0x1f || code === 0x7f ? " " : character;
		})
		.join("");
	log(
		`codemem enqueue-raw-event failed via ${command} rc=${result.status ?? 1} ms=${Date.now() - startedAt} stderr=${excerpt || "<empty>"}`,
	);
	return false;
}

export async function runClaudeIngestHook(overrides = {}) {
	const now = overrides.now ?? Date.now;
	const hookStartedAt = now();
	const env = overrides.env ?? process.env;
	try {
		const raw = await (overrides.readInput ?? readStdin)();
		if (!raw.trim() || isTruthy(env.CODEMEM_PLUGIN_IGNORE)) return 0;
		const nativePayload = JSON.parse(raw);
		if (nativePayload == null || typeof nativePayload !== "object" || Array.isArray(nativePayload))
			throw new Error("payload must be a JSON object");
		if (nativePayload.hook_event_name !== "UserPromptSubmit") {
			trackClaudeSessionState(nativePayload, env);
		}

		const envelope = buildRawEventEnvelopeFromHook(nativePayload, TRUSTED_HOOK_MAPPER_OPTIONS);
		if (envelope === null) return 0;
		const envelopeBody = JSON.stringify(envelope);
		const flushBoundary = shouldForceBoundaryFlush(nativePayload, env);
		const executionBudgetMs = flushBoundary ? boundaryExecutionBudgetMs(nativePayload, env) : null;
		const fallbackReserveMs =
			executionBudgetMs == null ? 0 : boundaryFallbackReserveMs(executionBudgetMs);
		const deadline =
			executionBudgetMs == null
				? null
				: hookStartedAt + Math.max(1, executionBudgetMs - BOUNDARY_DEADLINE_MARGIN_MS);
		const remainingBudgetMs = () =>
			deadline == null ? null : Math.max(0, Math.floor(deadline - now()));
		const post = overrides.postEnvelope ?? postEnvelope;
		const fallback = overrides.runFallback ?? runFallback;
		const postWithinBudget = async (options = {}, reserveMs = 0) => {
			const remaining = remainingBudgetMs();
			const available = remaining == null ? null : Math.max(0, remaining - reserveMs);
			if (available != null && available <= 0) return false;
			const requestedTimeout = options.timeoutMs ?? 5000;
			const timeoutMs =
				available == null ? options.timeoutMs : Math.max(1, Math.min(requestedTimeout, available));
			return post(envelopeBody, { ...options, env, timeoutMs });
		};
		const fallbackWithinBudget = (command, args) => {
			const remaining = remainingBudgetMs();
			if (remaining != null && remaining <= 0) return false;
			const timeoutMs = remaining == null ? undefined : Math.max(1, Math.min(8000, remaining));
			return fallback(command, args, envelopeBody, timeoutMs);
		};
		const postOptions = {
			flushBoundary,
			timeoutMs: flushBoundary ? boundaryTimeoutMs(nativePayload, env) : undefined,
		};

		const firstPost = await postWithinBudget(postOptions, fallbackReserveMs);
		if (firstPost === true) return 0;
		// A timed-out boundary request may still be extracting server-side.
		// Retry only the durable enqueue so it cannot multiply observer work.
		if (
			firstPost !== "target_mismatch" &&
			flushBoundary &&
			(await postWithinBudget({}, fallbackReserveMs)) === true
		)
			return 0;
		if (fallbackWithinBudget("codemem", ["enqueue-raw-event"])) return 0;
		if (fallbackWithinBudget("npx", ["-y", `codemem@${pinnedVersion()}`, "enqueue-raw-event"]))
			return 0;
		log("codemem enqueue-raw-event failed: all command attempts failed");
		return 1;
	} catch (error) {
		log(
			`codemem Claude hook ingest failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 1;
	}
}

function isMainModule(argvPath = process.argv[1]) {
	if (!argvPath) return false;
	try {
		return realpathSync(resolve(argvPath)) === realpathSync(scriptPath);
	} catch {
		return false;
	}
}

if (isMainModule()) {
	process.exit(await runClaudeIngestHook());
}
