#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildRawEventEnvelopeFromCodexHook,
	TRUSTED_HOOK_MAPPER_OPTIONS,
} from "./codemem-normalizer.mjs";
import { viewerBaseUrl } from "./user-prompt-hook.mjs";

export { viewerBaseUrl };

const MAX_BODY_BYTES = 1_048_576;
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const pluginRoot =
	process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || dirname(scriptDirectory);

function isTruthy(value) {
	return ["1", "true", "yes", "on"].includes(
		String(value ?? "")
			.trim()
			.toLowerCase(),
	);
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

function normalizeTimestampAndNonce(payload) {
	const hasTimestamp =
		(typeof payload.timestamp === "string" && payload.timestamp.trim() !== "") ||
		(typeof payload.ts === "string" && payload.ts.trim() !== "");
	return hasTimestamp
		? payload
		: {
				...payload,
				timestamp: new Date().toISOString(),
				codemem_generated_event_nonce: randomUUID(),
			};
}

function pinnedVersion() {
	try {
		const manifest = JSON.parse(
			readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
		);
		return typeof manifest.version === "string" && manifest.version.trim()
			? manifest.version.trim()
			: "latest";
	} catch {
		return "latest";
	}
}

function httpTimeoutMs() {
	const parsed = Number.parseInt(process.env.CODEMEM_CODEX_HOOK_HTTP_TIMEOUT_MS ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
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
			signal: AbortSignal.timeout(overrides.timeoutMs ?? httpTimeoutMs()),
		});
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
	const result = spawnSync(command, args, {
		input: body,
		encoding: "utf8",
		stdio: ["pipe", "ignore", "ignore"],
		timeout: 2000,
	});
	return result.status === 0;
}

function expandHome(path) {
	if (path === "~") return homedir();
	return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function spoolEnvelope(body) {
	try {
		const directory = spoolDirectory();
		mkdirSync(directory, { recursive: true });
		const suffix = `${process.pid}-${Date.now()}-${randomInt(1000, 10000)}`;
		const temporaryPath = join(directory, `.raw-event-tmp-${suffix}.json`);
		const finalPath = join(directory, `raw-event-${suffix}.json`);
		writeFileSync(temporaryPath, body, "utf8");
		renameSync(temporaryPath, finalPath);
		return finalPath;
	} catch {
		// Best-effort last resort only.
		return null;
	}
}

function removeSpooledEnvelope(path) {
	if (!path) return;
	try {
		unlinkSync(path);
	} catch {
		// A later invocation can safely redeliver the stable event ID.
	}
}

function spoolDirectory() {
	return expandHome(
		process.env.CODEMEM_CODEX_RAW_EVENT_SPOOL_DIR?.trim() || "~/.codemem/codex-raw-event-spool",
	);
}

async function drainNormalizedSpool() {
	let names;
	try {
		names = readdirSync(spoolDirectory())
			.filter((name) => name.startsWith("raw-event-") && name.endsWith(".json"))
			.sort();
	} catch {
		return;
	}
	for (const name of names.slice(0, 1)) {
		const path = join(spoolDirectory(), name);
		let body;
		try {
			body = readFileSync(path, "utf8");
		} catch {
			continue;
		}
		if (!(await postEnvelope(body))) continue;
		try {
			unlinkSync(path);
		} catch {
			// A later invocation can safely redeliver the stable event ID.
		}
	}
}

export async function runCodexIngestHook(overrides = {}) {
	try {
		const raw = await (overrides.readInput ?? readStdin)();
		if (raw.trim() && !isTruthy(process.env.CODEMEM_PLUGIN_IGNORE)) {
			const parsed = JSON.parse(raw);
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("payload must be a JSON object");
			}

			const nativePayload = normalizeTimestampAndNonce(parsed);
			const envelope = buildRawEventEnvelopeFromCodexHook(
				nativePayload,
				TRUSTED_HOOK_MAPPER_OPTIONS,
			);
			if (envelope !== null) {
				const envelopeBody = JSON.stringify(envelope);
				if (await (overrides.postEnvelope ?? postEnvelope)(envelopeBody)) {
					await (overrides.drainNormalizedSpool ?? drainNormalizedSpool)();
				} else {
					// Persist before spawning either fallback. Codex can terminate this
					// hook at its deadline, so durability cannot depend on a child
					// command returning before the remaining budget expires.
					const spooledPath = (overrides.spoolEnvelope ?? spoolEnvelope)(envelopeBody);
					const fallback = overrides.runFallback ?? runFallback;
					const enqueued =
						fallback("codemem", ["enqueue-raw-event"], envelopeBody) ||
						fallback(
							"npx",
							["-y", `codemem@${pinnedVersion()}`, "enqueue-raw-event"],
							envelopeBody,
						);
					if (enqueued) {
						(overrides.removeSpooledEnvelope ?? removeSpooledEnvelope)(spooledPath);
					}
				}
			}
		}
	} catch {
		// Hook ingestion is best-effort and must never block the Codex session.
	}

	(overrides.writeOutput ?? process.stdout.write.bind(process.stdout))('{"continue":true}\n');
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
	await runCodexIngestHook();
}
