#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, win32 } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_PACK_LIMIT = 8;
const DEFAULT_TOKEN_BUDGET = 800;
const DEFAULT_VIEWER_PORT = 38_888;
const LEDGER_TIMEOUT_MS = 500;
const MAX_QUERY_CHARS = 500;
const MAX_QUERY_FILE_BASENAMES = 5;
const MAX_WORKING_SET_PATHS = 8;
const MAX_WORKING_SET_PATH_CHARS = 512;
const PROMPT_TRANSPORT_PROTOCOL_RANGE = Object.freeze({
	minSupportedProtocolVersion: 1,
	protocolVersion: 1,
});
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(scriptPath);

function isRecord(value) {
	return value != null && typeof value === "object" && !Array.isArray(value);
}

function isTruthy(value) {
	return ["1", "true", "yes", "on"].includes(
		String(value ?? "")
			.trim()
			.toLowerCase(),
	);
}

function isEnabled(value) {
	return !["0", "false", "off"].includes(
		String(value ?? "")
			.trim()
			.toLowerCase(),
	);
}

function parsePositiveInt(value, fallback) {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function expandHome(value, env = process.env) {
	if (value === "~") return env.HOME?.trim() || homedir();
	if (value.startsWith("~/")) return join(env.HOME?.trim() || homedir(), value.slice(2));
	return value;
}

function normalizeIdentityPath(value, cwd, env) {
	const trimmed = String(value ?? "").trim();
	if (!trimmed) return null;
	return resolve(cwd, expandHome(trimmed, env));
}

export function resolveDbPath(cwd, env) {
	return resolve(cwd, expandHome(env.CODEMEM_DB?.trim() || "~/.codemem/mem.sqlite", env));
}

export function identityTarget(cwd, env) {
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
			String(env.CODEMEM_EMBEDDING_DISABLED ?? "").toLowerCase(),
		),
		embedding_model: env.CODEMEM_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5",
	};
}

function canonicalJson(value) {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isRecord(value)) {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function normalizeProtocolRange(protocolVersion, minSupportedProtocolVersion) {
	if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 1) return null;
	const minimum =
		minSupportedProtocolVersion === undefined ? protocolVersion : minSupportedProtocolVersion;
	if (!Number.isSafeInteger(minimum) || minimum < 1 || minimum > protocolVersion) return null;
	return { minSupportedProtocolVersion: minimum, protocolVersion };
}

function protocolRangesOverlap(left, right) {
	return (
		left.minSupportedProtocolVersion <= right.protocolVersion &&
		right.minSupportedProtocolVersion <= left.protocolVersion
	);
}

export function classifyPromptTransportFailure({ kind, compatibleProfile = false }) {
	if (kind === "database_mismatch" || kind === "runtime_identity_mismatch") {
		return "local_fallback";
	}
	if (kind === "invalid_request") {
		return compatibleProfile ? "terminal" : "fallback";
	}
	if (kind === "policy_failure" || kind === "authorization_failure") {
		return "terminal";
	}
	if (kind === "viewer_contract_unsupported") {
		return compatibleProfile ? "terminal" : "fallback";
	}
	return "fallback";
}

function errorCode(body) {
	return isRecord(body) && isRecord(body.error) && typeof body.error.code === "string"
		? body.error.code
		: null;
}

function classifyHttpFailure({
	status = null,
	body = null,
	malformed = false,
	compatibleProfile = false,
}) {
	if (malformed) return classifyPromptTransportFailure({ kind: "malformed_response" });
	const code = errorCode(body);
	if (code === "viewer_db_mismatch") {
		return classifyPromptTransportFailure({ kind: "database_mismatch" });
	}
	if (code === "viewer_identity_mismatch") {
		return classifyPromptTransportFailure({ kind: "runtime_identity_mismatch" });
	}
	if (code === "viewer_contract_unsupported") {
		return classifyPromptTransportFailure({
			kind: "viewer_contract_unsupported",
			compatibleProfile,
		});
	}
	if (
		status === 401 ||
		status === 403 ||
		["authorization_failed", "forbidden", "unauthorized"].includes(code)
	) {
		return classifyPromptTransportFailure({ kind: "authorization_failure" });
	}
	if (["policy_denied", "policy_disabled"].includes(code)) {
		return classifyPromptTransportFailure({ kind: "policy_failure" });
	}
	if (code === "invalid_request") {
		return classifyPromptTransportFailure({ kind: "invalid_request", compatibleProfile });
	}
	return "fallback";
}

export function viewerBaseUrl(env = process.env) {
	const configuredHost = env.CODEMEM_VIEWER_HOST?.trim() || "127.0.0.1";
	const normalizedHost = configuredHost.toLowerCase().replace(/^\[(.*)\]$/, "$1");
	const ipv4Parts = normalizedHost.split(".");
	const isIpv4Loopback =
		ipv4Parts.length === 4 &&
		ipv4Parts[0] === "127" &&
		ipv4Parts.every(
			(part) => /^\d+$/.test(part) && String(Number(part)) === part && Number(part) <= 255,
		);
	const urlHost =
		normalizedHost === "localhost" || isIpv4Loopback
			? normalizedHost
			: normalizedHost === "::1" || normalizedHost === "0:0:0:0:0:0:0:1"
				? "[::1]"
				: null;
	if (!urlHost) return null;
	const port = parsePositiveInt(env.CODEMEM_VIEWER_PORT, DEFAULT_VIEWER_PORT);
	return `http://${urlHost}:${port}`;
}

async function responseJson(response) {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

async function readViewerProfile({
	fetchImpl,
	env,
	expectedDbPath,
	expectedIdentity,
	protocolRange,
	timeoutSignal,
}) {
	const baseUrl = viewerBaseUrl(env);
	if (!baseUrl) {
		return { ok: false, disposition: classifyPromptTransportFailure({ kind: "policy_failure" }) };
	}
	let response;
	try {
		response = await fetchImpl(`${baseUrl}/api/prompt-pack-profile`, {
			method: "GET",
			redirect: "manual",
			signal: timeoutSignal,
		});
	} catch {
		return { ok: false, disposition: "fallback" };
	}
	const body = await responseJson(response);
	if (response.status >= 300 && response.status < 400) {
		return { ok: false, disposition: "fallback" };
	}
	if (!response.ok) {
		return { ok: false, disposition: classifyHttpFailure({ status: response.status, body }) };
	}
	const viewerRange = isRecord(body)
		? normalizeProtocolRange(body.protocol_version, body.min_supported_protocol_version)
		: null;
	if (!isRecord(body) || body.service !== "codemem-viewer" || !viewerRange) {
		return {
			ok: false,
			disposition: classifyPromptTransportFailure({ kind: "profile_malformed" }),
		};
	}
	if (!protocolRangesOverlap(protocolRange, viewerRange)) {
		return {
			ok: false,
			disposition: classifyPromptTransportFailure({ kind: "protocol_range_mismatch" }),
		};
	}
	if (body.db_path !== expectedDbPath) {
		return {
			ok: false,
			disposition: classifyPromptTransportFailure({ kind: "database_mismatch" }),
		};
	}
	if (canonicalJson(body.identity_target) !== canonicalJson(expectedIdentity)) {
		return {
			ok: false,
			disposition: classifyPromptTransportFailure({ kind: "runtime_identity_mismatch" }),
		};
	}
	return { ok: true };
}

function normalizePromptText(value) {
	return typeof value === "string" ? value.trim().replaceAll("\n", " ") : "";
}

function stableSessionSuffix(sessionId) {
	let hash = 0xcbf29ce484222325n;
	for (const byte of Buffer.from(sessionId, "utf8")) {
		hash ^= BigInt(byte);
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return hash.toString(16).padStart(16, "0");
}

function sessionStatePath(sessionId, env = process.env) {
	const root = expandHome(
		env.CODEMEM_CLAUDE_HOOK_CONTEXT_DIR?.trim() || "~/.codemem/claude-hook-context",
		env,
	);
	const label = sessionId
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	return join(root, `${label || "session"}-${stableSessionSuffix(sessionId.trim())}.json`);
}

function defaultSessionState() {
	return { first_prompt: "", last_prompt: "", files_modified: [], updated_at: "" };
}

function loadSessionState(sessionId, env) {
	try {
		const parsed = JSON.parse(readFileSync(sessionStatePath(sessionId, env), "utf8"));
		if (!isRecord(parsed)) return defaultSessionState();
		return {
			first_prompt: typeof parsed.first_prompt === "string" ? parsed.first_prompt.trim() : "",
			last_prompt: typeof parsed.last_prompt === "string" ? parsed.last_prompt.trim() : "",
			files_modified: Array.isArray(parsed.files_modified)
				? parsed.files_modified
						.filter((item) => typeof item === "string" && item.trim())
						.slice(0, 64)
				: [],
			updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at.trim() : "",
		};
	} catch {
		return defaultSessionState();
	}
}

function saveSessionState(sessionId, state, env) {
	const path = sessionStatePath(sessionId, env);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(`${path}.tmp`, JSON.stringify(state), "utf8");
	renameSync(`${path}.tmp`, path);
}

function modifiedPaths(payload) {
	if (!isRecord(payload.tool_input)) return [];
	const toolName = String(payload.tool_name ?? "")
		.trim()
		.toLowerCase();
	if (!["edit", "write", "multiedit", "notebookedit", "apply_patch"].includes(toolName)) {
		return [];
	}
	const values = [
		payload.tool_input.filePath,
		payload.tool_input.file_path,
		payload.tool_input.path,
	];
	const paths = values
		.filter((value) => typeof value === "string" && value.trim())
		.map((value) => value.trim());
	if (toolName === "apply_patch") {
		const patchText = payload.tool_input.patchText || payload.tool_input.patch;
		if (typeof patchText === "string") {
			for (const line of patchText.split(/\r?\n/)) {
				const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
				const path = match?.[1]?.trim();
				if (path) paths.push(path);
			}
		}
	}
	return [...new Set(paths)];
}

export function trackClaudeSessionState(payload, env = process.env, now = () => new Date()) {
	const sessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
	if (!sessionId) return null;
	if (payload.hook_event_name === "SessionEnd") {
		try {
			rmSync(sessionStatePath(sessionId, env), { force: true });
		} catch {
			// State cleanup is best effort.
		}
		return null;
	}
	const state = loadSessionState(sessionId, env);
	let changed = false;
	if (payload.hook_event_name === "UserPromptSubmit") {
		const prompt = normalizePromptText(payload.prompt);
		if (prompt && !state.first_prompt) {
			state.first_prompt = prompt;
			changed = true;
		}
		if (prompt && state.last_prompt !== prompt) {
			state.last_prompt = prompt;
			changed = true;
		}
	} else if (["PostToolUse", "PostToolUseFailure"].includes(payload.hook_event_name)) {
		const files = state.files_modified.filter((path) => path.trim());
		for (const path of modifiedPaths(payload)) {
			if (!files.includes(path)) {
				files.push(path);
				changed = true;
			}
		}
		state.files_modified = files.slice(-64);
	}
	if (changed) {
		state.updated_at = now().toISOString();
		try {
			saveSessionState(sessionId, state, env);
		} catch {
			// Session hints are best effort and must not fail a hook.
		}
	}
	return state;
}

function normalizeProjectLabel(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	let end = trimmed.length;
	while (end > 0 && [47, 92].includes(trimmed.charCodeAt(end - 1))) end -= 1;
	const cleaned = trimmed.slice(0, end);
	if (!cleaned) return null;
	return cleaned.replaceAll("\\", "/").split("/").at(-1) || null;
}

function inferProjectFromCwd(cwd, env) {
	if (typeof cwd !== "string" || !cwd.trim()) return null;
	const expanded = expandHome(cwd.trim(), env);
	if (!isAbsolute(expanded)) return null;
	try {
		if (!statSync(expanded).isDirectory()) return null;
	} catch {
		return null;
	}
	let current = expanded;
	while (true) {
		if (existsSync(resolve(current, ".git"))) return basename(current) || null;
		const parent = dirname(current);
		if (parent === current) return basename(expanded) || null;
		current = parent;
	}
}

function resolveProject(payload, env) {
	return (
		normalizeProjectLabel(env.CODEMEM_PROJECT) ??
		inferProjectFromCwd(payload.cwd, env) ??
		normalizeProjectLabel(payload.project)
	);
}

function buildInjectQuery(prompt, project, state) {
	const firstPrompt = state ? normalizePromptText(state.first_prompt) : "";
	const parts = [];
	if (firstPrompt) parts.push(firstPrompt);
	if (prompt && prompt !== firstPrompt && prompt.length > 5) parts.push(prompt);
	if (project) parts.push(project);
	const names = (state?.files_modified ?? [])
		.filter((path) => path.trim())
		.slice(-MAX_QUERY_FILE_BASENAMES)
		.map((path) => basename(path.replaceAll("\\", "/")))
		.filter(Boolean);
	if (names.length) parts.push(names.join(" "));
	return (parts.join(" ") || "recent work").slice(0, MAX_QUERY_CHARS);
}

function truncateAdditionalContext(text, maxChars) {
	const normalized = text.trim();
	if (!normalized || normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, maxChars).trimEnd()}\n\n[pack truncated]`;
}

function normalizeWorkingSetPath(value) {
	const trimmed = value.trim();
	if (
		!trimmed ||
		trimmed.length > MAX_WORKING_SET_PATH_CHARS ||
		posix.isAbsolute(trimmed) ||
		win32.isAbsolute(trimmed)
	) {
		return null;
	}
	const normalized = posix.normalize(trimmed.replaceAll("\\", "/")).replace(/^\.\//, "");
	return !normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")
		? null
		: normalized;
}

function continueOutput(additionalContext) {
	return additionalContext
		? {
				continue: true,
				hookSpecificOutput: {
					hookEventName: "UserPromptSubmit",
					additionalContext,
				},
			}
		: { continue: true };
}

function attemptMetadata(payload, now, uuid) {
	const sessionId = typeof payload.session_id === "string" ? payload.session_id.trim() : "";
	return {
		attempt_id: uuid(),
		started_at: now().toISOString(),
		source: "claude",
		...(sessionId ? { stream_id: sessionId, source_session_id: sessionId } : {}),
		request_id: uuid(),
	};
}

function packBody({ query, project, payload, state, dbPath, identity, attempt, env }) {
	const cwd = typeof payload.cwd === "string" && isAbsolute(payload.cwd) ? payload.cwd : null;
	const workingSetFiles = (state?.files_modified ?? [])
		.filter((path) => path.trim())
		.slice(-MAX_WORKING_SET_PATHS)
		.map((path) => (cwd && isAbsolute(path) ? relative(cwd, path) : path))
		.map(normalizeWorkingSetPath)
		.filter(Boolean);
	return {
		context: query,
		limit: parsePositiveInt(env.CODEMEM_INJECT_LIMIT, DEFAULT_PACK_LIMIT),
		token_budget: parsePositiveInt(env.CODEMEM_INJECT_TOKEN_BUDGET, DEFAULT_TOKEN_BUDGET),
		...(project ? { project } : {}),
		...(cwd ? { cwd } : {}),
		working_set_files: workingSetFiles,
		db_path: dbPath,
		identity_target: identity,
		attempt,
	};
}

function validPackResponse(body) {
	return (
		isRecord(body) &&
		typeof body.pack_text === "string" &&
		isRecord(body.metrics) &&
		Number.isInteger(body.metrics.total_items) &&
		body.metrics.total_items >= 0
	);
}

async function postPack({ fetchImpl, env, body, timeoutSignal }) {
	const baseUrl = viewerBaseUrl(env);
	if (!baseUrl) {
		return { ok: false, disposition: classifyPromptTransportFailure({ kind: "policy_failure" }) };
	}
	let response;
	try {
		response = await fetchImpl(`${baseUrl}/api/pack`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: timeoutSignal,
		});
	} catch {
		return { ok: false, disposition: "fallback" };
	}
	const responseBody = await responseJson(response);
	if (response.status >= 300 && response.status < 400) {
		return { ok: false, disposition: "fallback" };
	}
	if (!response.ok) {
		return {
			ok: false,
			disposition: classifyHttpFailure({
				status: response.status,
				body: responseBody,
				compatibleProfile: true,
			}),
		};
	}
	if (!validPackResponse(responseBody)) {
		return { ok: false, disposition: classifyHttpFailure({ malformed: true }) };
	}
	return { ok: true, body: responseBody };
}

export function ledgerPayloadForState(state, attempt, details = {}) {
	if (state === "delivered") {
		return { action: "delivery", attempt_id: attempt.attempt_id, delivery_status: "handed_off" };
	}
	if (state === "empty") {
		return { action: "delivery", attempt_id: attempt.attempt_id, delivery_status: "unknown" };
	}
	if (state === "cached") {
		return { action: "cache_reuse", ...attempt, original_attempt_id: details.originalAttemptId };
	}
	return {
		action: "record",
		...attempt,
		retrieval_status: state,
		failure_code: details.failureCode || `${state}_prompt_pack`,
		failure_stage: details.failureStage || (state === "skipped" ? "policy" : "retrieval"),
	};
}

async function postLedger({ fetchImpl, env, payload, dbPath, identity, signal }) {
	const baseUrl = viewerBaseUrl(env);
	if (!baseUrl) throw new Error("viewer host must be loopback");
	const response = await fetchImpl(`${baseUrl}/api/prompt-pack-ledger`, {
		method: "POST",
		redirect: "manual",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...payload, db_path: dbPath, identity_target: identity }),
		signal,
	});
	if (response.status >= 300 && response.status < 400) throw new Error("ledger redirect rejected");
	const body = await responseJson(response);
	if (!response.ok || !isRecord(body) || body.ok !== true) throw new Error("ledger write failed");
}

export async function recordClaudePromptLedgerState(state, context, overrides = {}) {
	const payload = ledgerPayloadForState(state, context.attempt, context.details);
	return settleLedgerBestEffort(
		(signal) =>
			postLedger({
				fetchImpl: overrides.fetchImpl ?? fetch,
				env: context.env,
				payload,
				dbPath: context.dbPath,
				identity: context.identity,
				signal,
			}),
		overrides,
	);
}

export async function settleLedgerBestEffort(task, deps = {}) {
	const setTimer = deps.setTimer ?? setTimeout;
	const clearTimer = deps.clearTimer ?? clearTimeout;
	const controller = new AbortController();
	let timer;
	const deadline = new Promise((resolveDeadline) => {
		timer = setTimer(() => {
			controller.abort();
			resolveDeadline(false);
		}, LEDGER_TIMEOUT_MS);
	});
	timer?.unref?.();
	try {
		return await Promise.race([
			Promise.resolve(task(controller.signal)).then(
				() => true,
				() => false,
			),
			deadline,
		]);
	} finally {
		if (timer !== undefined) clearTimer(timer);
	}
}

function pinnedVersion(env) {
	const pluginRoot = env.CLAUDE_PLUGIN_ROOT || dirname(scriptDirectory);
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

function runInject(command, args, raw, env) {
	const result = spawnSync(command, args, {
		input: raw,
		encoding: "utf8",
		stdio: ["pipe", "pipe", "ignore"],
		timeout: 8_000,
		env,
	});
	if (result.status !== 0) return null;
	try {
		const parsed = JSON.parse(String(result.stdout ?? "").trim());
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function runCompatibilityFallback(raw, env) {
	return (
		runInject("codemem", ["claude-hook-inject"], raw, env) ??
		runInject("npx", ["-y", `codemem@${pinnedVersion(env)}`, "claude-hook-inject"], raw, env)
	);
}

function startIngestion(raw, env) {
	try {
		const child = spawn(process.execPath, [join(scriptDirectory, "ingest-hook.mjs")], {
			detached: true,
			stdio: ["pipe", "ignore", "ignore"],
			env,
		});
		child.stdin.end(raw);
		child.unref();
	} catch {
		// Event ingestion remains best effort and independent of prompt delivery.
	}
}

async function readStdin() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

export async function runClaudeUserPromptHook(raw, overrides = {}) {
	const env = overrides.env ?? process.env;
	const writeOutput = overrides.writeOutput ?? ((value) => process.stdout.write(value));
	if (!raw.trim()) {
		writeOutput(JSON.stringify(continueOutput()));
		return;
	}
	if (isTruthy(env.CODEMEM_PLUGIN_IGNORE)) {
		writeOutput(JSON.stringify(continueOutput()));
		return;
	}

	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		writeOutput(JSON.stringify(continueOutput()));
		return;
	}
	if (!isRecord(payload)) {
		writeOutput(JSON.stringify(continueOutput()));
		return;
	}

	const spawnIngestion = overrides.spawnIngestion ?? startIngestion;
	spawnIngestion(raw, env);
	const state = trackClaudeSessionState(payload, env, overrides.now);
	const prompt = normalizePromptText(payload.prompt);
	const now = overrides.now ?? (() => new Date());
	const uuid = overrides.uuid ?? randomUUID;
	const attempt = attemptMetadata(payload, now, uuid);
	const cwd =
		typeof payload.cwd === "string" && isAbsolute(payload.cwd) ? payload.cwd : process.cwd();
	const dbPath = resolveDbPath(cwd, env);
	const identity = identityTarget(cwd, env);
	const fetchImpl = overrides.fetchImpl ?? fetch;
	const requestTimeoutMs = parsePositiveInt(env.CODEMEM_INJECT_HTTP_MAX_TIME_S, 2) * 1_000;
	const requestTimeoutSignal = () => AbortSignal.timeout(requestTimeoutMs);

	if (!isEnabled(env.CODEMEM_INJECT_CONTEXT ?? "1")) {
		writeOutput(JSON.stringify(continueOutput()));
		await recordClaudePromptLedgerState(
			"skipped",
			{
				attempt,
				details: { failureCode: "injection_disabled" },
				env,
				dbPath,
				identity,
			},
			{ ...overrides, fetchImpl },
		);
		return;
	}
	if (!prompt) {
		writeOutput(JSON.stringify(continueOutput()));
		return;
	}

	const project = resolveProject(payload, env);
	const query = buildInjectQuery(prompt, project, state);
	const profile = await readViewerProfile({
		fetchImpl,
		env,
		expectedDbPath: dbPath,
		expectedIdentity: identity,
		protocolRange: overrides.protocolRange ?? PROMPT_TRANSPORT_PROTOCOL_RANGE,
		timeoutSignal: requestTimeoutSignal(),
	});
	const packResult = profile.ok
		? await postPack({
				fetchImpl,
				env,
				body: packBody({ query, project, payload, state, dbPath, identity, attempt, env }),
				timeoutSignal: requestTimeoutSignal(),
			})
		: profile;

	if (!packResult.ok && packResult.disposition !== "terminal") {
		const fallback = overrides.runFallback
			? overrides.runFallback(raw, env)
			: runCompatibilityFallback(raw, env);
		writeOutput(JSON.stringify(fallback ?? continueOutput()));
		return;
	}

	if (!packResult.ok) {
		writeOutput(JSON.stringify(continueOutput()));
		await recordClaudePromptLedgerState(
			"failed",
			{
				attempt,
				details: { failureCode: "viewer_request_rejected" },
				env,
				dbPath,
				identity,
			},
			{ ...overrides, fetchImpl },
		);
		return;
	}

	const maxChars = parsePositiveInt(env.CODEMEM_INJECT_MAX_CHARS, DEFAULT_MAX_CHARS);
	const additionalContext = truncateAdditionalContext(packResult.body.pack_text, maxChars);
	writeOutput(JSON.stringify(continueOutput(additionalContext)));
	const ledgerState = additionalContext ? "delivered" : "empty";
	await recordClaudePromptLedgerState(
		ledgerState,
		{ attempt, env, dbPath, identity },
		{ ...overrides, fetchImpl },
	);
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
	await runClaudeUserPromptHook(await readStdin());
}
