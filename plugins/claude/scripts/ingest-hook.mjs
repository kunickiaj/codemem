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
import { trackClaudeSessionState, viewerBaseUrl } from "./user-prompt-hook.mjs";

const MAX_BODY_BYTES = 1_048_576;
const scriptPath = fileURLToPath(import.meta.url);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || dirname(scriptDirectory);

function isTruthy(value) {
	return ["1", "true", "yes", "on"].includes(
		String(value ?? "")
			.trim()
			.toLowerCase(),
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
	const baseUrl = viewerBaseUrl(overrides.env ?? process.env);
	if (!baseUrl) return false;
	try {
		const response = await (overrides.fetchImpl ?? fetch)(`${baseUrl}/api/raw-events`, {
			method: "POST",
			redirect: "manual",
			headers: { "Content-Type": "application/json" },
			body,
			signal: AbortSignal.timeout(overrides.timeoutMs ?? 5000),
		});
		if (response.status >= 300 && response.status < 400) return false;
		if (!response.ok) return false;
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

function runFallback(command, args, body) {
	const startedAt = Date.now();
	const result = spawnSync(command, args, {
		input: body,
		encoding: "utf8",
		stdio: ["pipe", "ignore", "pipe"],
		timeout: 8000,
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

async function runClaudeIngestHook() {
	try {
		const raw = await readStdin();
		if (!raw.trim() || isTruthy(process.env.CODEMEM_PLUGIN_IGNORE)) return 0;
		const nativePayload = JSON.parse(raw);
		if (nativePayload == null || typeof nativePayload !== "object" || Array.isArray(nativePayload))
			throw new Error("payload must be a JSON object");
		if (nativePayload.hook_event_name !== "UserPromptSubmit") {
			trackClaudeSessionState(nativePayload);
		}

		const envelope = buildRawEventEnvelopeFromHook(nativePayload, TRUSTED_HOOK_MAPPER_OPTIONS);
		if (envelope === null) return 0;
		const envelopeBody = JSON.stringify(envelope);

		if (await postEnvelope(envelopeBody)) return 0;
		if (await postEnvelope(envelopeBody)) return 0;
		if (runFallback("codemem", ["enqueue-raw-event"], envelopeBody)) return 0;
		if (runFallback("npx", ["-y", `codemem@${pinnedVersion()}`, "enqueue-raw-event"], envelopeBody))
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
