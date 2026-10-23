#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
	classifyHttpFailure,
	expandHome,
	identityTarget,
	isEnabled,
	isMainModule,
	isRecord,
	isTruthy,
	PROMPT_TRANSPORT_PROTOCOL_RANGE,
	readViewerProfile,
	resolveDbPath,
	resolveProject,
	viewerBaseUrl,
} from "./user-prompt-hook.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const MAX_BYTES = 65_536;
const TOTAL_BUDGET_MS = 8_000;
const CLI_DELIVERY_BUDGET_MS = 1_500;
const SIZE_BYPASS = [
	/\.(json|jsonc|toml|ya?ml)$/i,
	/\.env(\.|$)/i,
	/(^|\/)dockerfile(\.|$)/i,
	/\.config\.(js|ts|mjs|cjs|json)$/i,
];
const CONTINUE = { continue: true };

function clientCwd(payload) {
	return typeof payload.cwd === "string" && payload.cwd.trim() ? payload.cwd : process.cwd();
}

function minimumFileBytes(env) {
	const configured = Number.parseInt(env.CODEMEM_FILE_CONTEXT_MIN_BYTES ?? "1500", 10);
	return Number.isFinite(configured) && configured >= 0 ? configured : 1500;
}

export function guardFileContext(payload, env, statFile = statSync) {
	const file = isRecord(payload.tool_input) ? payload.tool_input.file_path : null;
	if (isTruthy(env.CODEMEM_PLUGIN_IGNORE) || typeof file !== "string" || !file.trim()) return null;
	if (!isEnabled(env.CODEMEM_FILE_CONTEXT ?? "1"))
		return { action: "skip", reason: "file_context_disabled" };
	const cwd = clientCwd(payload);
	const expanded = expandHome(file.trim(), env);
	const absolutePath = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	const path = relative(cwd, absolutePath).split(sep).join("/");
	if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) {
		return { action: "skip", reason: "outside_cwd" };
	}
	let stat;
	try {
		stat = statFile(absolutePath);
	} catch {
		/* Missing/inaccessible files are ordinary skips. */
	}
	if (!stat) return { action: "skip", reason: "stat_failed", repository_paths: [path] };
	const minimum = minimumFileBytes(env);
	if (stat.size < minimum && !SIZE_BYPASS.some((pattern) => pattern.test(path))) {
		return { action: "skip", reason: "below_size_gate", repository_paths: [path] };
	}
	return { action: "lookup", relative_path: path, file_mtime_ms: stat.mtimeMs };
}

async function boundedJson(response) {
	const reader = response.body?.getReader();
	if (!reader) return null;
	const chunks = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > MAX_BYTES) throw new Error("response too large");
			chunks.push(Buffer.from(value));
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		await reader.cancel().catch(() => {});
		return null;
	} finally {
		reader.releaseLock();
	}
}

async function withinTime(task, milliseconds) {
	if (milliseconds <= 0) return { ok: false, disposition: "fallback" };
	const controller = new AbortController();
	let timer;
	try {
		return await Promise.race([
			Promise.resolve()
				.then(() => task(controller.signal))
				.catch(() => ({ ok: false, disposition: "fallback" })),
			new Promise((settle) => {
				timer = setTimeout(() => {
					controller.abort();
					settle({ ok: false, disposition: "fallback" });
				}, milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** Only this process's detached child group is killed; no user processes are inspected. */
export function runBoundedChild(command, args, input, options) {
	if (options.timeoutMs <= 0) return Promise.resolve(null);
	return new Promise((settle) => {
		const child = (options.spawnImpl ?? spawn)(command, args, {
			env: options.env,
			cwd: options.cwd,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
		});
		let bytes = 0;
		const stdout = [];
		let finished = false;
		const finish = (value) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			settle(value);
		};
		const terminate = () => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
				else child.kill("SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					/* Child already exited. */
				}
			}
			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			finish(null);
		};
		const timer = setTimeout(terminate, options.timeoutMs);
		const collect = (chunk, { keepStdout }) => {
			bytes += chunk.length;
			if (bytes > MAX_BYTES) {
				terminate();
				return;
			}
			if (keepStdout) stdout.push(Buffer.from(chunk));
		};
		child.stdout.on("data", (chunk) => collect(chunk, { keepStdout: true }));
		child.stderr.on("data", (chunk) => collect(chunk, { keepStdout: false }));
		child.once("error", () => finish(null));
		child.once("close", (status) =>
			finish(status === 0 ? Buffer.concat(stdout).toString("utf8") : null),
		);
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});
}

function exactPluginVersion(env) {
	try {
		const root = env.CLAUDE_PLUGIN_ROOT || dirname(dirname(scriptPath));
		const version = JSON.parse(
			readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"),
		).version;
		if (typeof version !== "string" || version.length > 128) return null;
		const prerelease = version.split("+")[0].split("-").slice(1).join("-");
		if (prerelease.split(".").some((part) => /^0\d+$/.test(part))) return null;
		return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
			version,
		)
			? version
			: null;
	} catch {
		return null;
	}
}

function parseObject(raw) {
	try {
		const value = JSON.parse(raw);
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

function validResult(body, request) {
	if (
		!isRecord(body) ||
		body.ok !== true ||
		body.attempt_id !== request.attempt_id ||
		body.request_id !== request.request_id ||
		typeof body.delivery_pending !== "boolean" ||
		!isRecord(body.result)
	)
		return false;
	const output = body.result.hookSpecificOutput;
	if (output === undefined) return body.result.continue === true && !body.delivery_pending;
	return (
		isRecord(output) &&
		output.hookEventName === "PreToolUse" &&
		output.permissionDecision === "allow" &&
		typeof output.additionalContext === "string" &&
		output.additionalContext.length > 0
	);
}

function hostResult(body) {
	const output = body.result.hookSpecificOutput;
	if (!output) return CONTINUE;
	return {
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision: "allow",
			additionalContext: output.additionalContext,
		},
	};
}

function attemptBody(context, action, transport) {
	return {
		...action,
		attempt_id: context.uuid(),
		request_id: `claude-file-context/${transport}/${context.requestId}`,
		source_session_id:
			typeof context.payload.session_id === "string"
				? context.payload.session_id.trim() || null
				: null,
		ledger_enabled: isEnabled(context.env.CODEMEM_RETRIEVAL_LEDGER ?? "1"),
		db_path: context.dbPath,
		identity_target: context.identity,
	};
}

async function compatibleProfile(context, maximumMs) {
	let terminal = false;
	const result = await withinTime(
		(signal) =>
			readViewerProfile({
				fetchImpl: async (...args) => {
					const response = await context.fetchImpl(...args);
					terminal =
						(response.status >= 300 && response.status < 400) ||
						response.status === 401 ||
						response.status === 403;
					return response;
				},
				env: context.env,
				expectedDbPath: context.dbPath,
				expectedIdentity: context.identity,
				protocolRange: PROMPT_TRANSPORT_PROTOCOL_RANGE,
				timeoutSignal: signal,
				readJson: (response) => {
					if (!terminal) return boundedJson(response);
					void response.body?.cancel().catch(() => {});
					return null;
				},
			}),
		Math.min(maximumMs, context.remaining()),
	);
	return terminal ? { ok: false, disposition: "terminal" } : result;
}

async function postContext(context, body, maximumMs) {
	return withinTime(
		async (signal) => {
			const response = await context.fetchImpl(`${viewerBaseUrl(context.env)}/api/file-context`, {
				method: "POST",
				redirect: "manual",
				signal,
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			// Status denials take precedence over malformed or misleading error bodies.
			if (
				(response.status >= 300 && response.status < 400) ||
				response.status === 401 ||
				response.status === 403
			) {
				void response.body?.cancel().catch(() => {});
				return { ok: false, disposition: "terminal" };
			}
			const value = await boundedJson(response);
			if (!response.ok) {
				const disposition = classifyHttpFailure({
					status: response.status,
					body: value,
					compatibleProfile: true,
				});
				const rejectedRequest =
					response.status >= 400 &&
					response.status < 500 &&
					![404, 408, 429].includes(response.status) &&
					disposition !== "local_fallback";
				return { ok: false, disposition: rejectedRequest ? "terminal" : disposition };
			}
			return { ok: true, body: value };
		},
		Math.min(maximumMs, context.remaining()),
	);
}

async function commandJson(context, command, args, body, maximumMs, { reserveMs = 250 } = {}) {
	try {
		const raw = await context.runChild(command, args, body ? JSON.stringify(body) : "", {
			env: context.env,
			cwd: context.cwd,
			timeoutMs: Math.min(maximumMs, Math.max(0, context.remaining() - reserveMs)),
		});
		return parseObject(raw);
	} catch {
		return null;
	}
}

async function localCandidate(context, action, candidate) {
	const args = [...candidate.prefix, "claude-hook-file-context"];
	const profile = await commandJson(
		context,
		candidate.command,
		[...args, "--transport-profile"],
		null,
		candidate.probeMs,
	);
	if (
		profile?.file_context_transport !== 1 ||
		profile.visibility_enforced !== true ||
		profile.deferred_delivery !== true
	)
		return null;
	const request = attemptBody(context, action, candidate.transport);
	const body = await commandJson(
		context,
		candidate.command,
		[...args, "--transport"],
		request,
		context.remaining(),
		{ reserveMs: CLI_DELIVERY_BUDGET_MS },
	);
	if (!validResult(body, request)) return null;
	return {
		result: hostResult(body),
		acknowledge: body.delivery_pending
			? async (status) => {
					await commandJson(
						context,
						candidate.command,
						[...args, "--transport"],
						deliveryBody(request, status),
						CLI_DELIVERY_BUDGET_MS,
						{ reserveMs: 0 },
					);
				}
			: null,
	};
}

async function compatibilityFallback(context, action) {
	const installed = await localCandidate(context, action, {
		command: "codemem",
		prefix: [],
		transport: "cli",
		probeMs: 750,
	});
	if (installed) return installed;
	const version = exactPluginVersion(context.env);
	if (!version || context.remaining() <= 250) return { result: CONTINUE };
	return (
		(await localCandidate(context, action, {
			command: "npx",
			prefix: ["-y", `codemem@${version}`],
			transport: "npx",
			probeMs: 1500,
		})) ?? { result: CONTINUE }
	);
}

function deliveryBody(request, status) {
	const { attempt_id, request_id, source_session_id, ledger_enabled, db_path, identity_target } =
		request;
	return {
		action: "delivery",
		attempt_id,
		request_id,
		source_session_id,
		ledger_enabled,
		db_path,
		identity_target,
		delivery_status: status,
	};
}

async function retrieveContext(context, action) {
	// A non-loopback host is a policy rejection, not an unavailable local Viewer.
	if (!viewerBaseUrl(context.env)) return { result: CONTINUE };
	if (action.action === "skip" && !isEnabled(context.env.CODEMEM_RETRIEVAL_LEDGER ?? "1"))
		return { result: CONTINUE };
	const skipping = action.action === "skip";
	const skipDeadline = context.now() + 500;
	const maximum = () => (skipping ? Math.max(0, skipDeadline - context.now()) : 750);
	const profile = await compatibleProfile(context, maximum());
	if (!profile.ok) {
		if (skipping || profile.disposition === "terminal") return { result: CONTINUE };
		return compatibilityFallback(context, action);
	}
	const request = attemptBody(context, action, "http");
	const response = await postContext(context, request, maximum());
	if (response.ok && validResult(response.body, request)) {
		return {
			result: hostResult(response.body),
			acknowledge: response.body.delivery_pending
				? async (status) => {
						await postContext(context, deliveryBody(request, status), 250);
					}
				: null,
		};
	}
	if (skipping || response.disposition === "terminal") return { result: CONTINUE };
	return compatibilityFallback(context, action);
}

function writeHostOutput(value) {
	return new Promise((settle, reject) => {
		process.stdout.write(`${value}\n`, (error) => (error ? reject(error) : settle()));
	});
}

function hookBudget(env) {
	const configured = Number.parseInt(
		env.CODEMEM_FILE_CONTEXT_TIMEOUT_MS ?? `${TOTAL_BUDGET_MS}`,
		10,
	);
	return Number.isFinite(configured) && configured > 0
		? Math.min(configured, TOTAL_BUDGET_MS)
		: TOTAL_BUDGET_MS;
}

function clientContext(payload, env, clock, overrides) {
	const cwd = clientCwd(payload);
	const uuid = overrides.uuid ?? randomUUID;
	return {
		env,
		now: clock.now,
		payload,
		cwd,
		uuid,
		requestId: uuid(),
		dbPath: resolveDbPath(cwd, env),
		identity: identityTarget(cwd, env),
		remaining: () => Math.max(0, Math.floor(clock.deadline - clock.now())),
		fetchImpl: overrides.fetchImpl ?? fetch,
		runChild: overrides.runChild ?? runBoundedChild,
	};
}

export async function runClaudePreReadHook(raw, overrides = {}) {
	const env = overrides.env ?? process.env;
	const now = overrides.now ?? (() => performance.now());
	const deadline = Math.min(overrides.deadline ?? Infinity, now() + hookBudget(env));
	let outcome = { result: CONTINUE };
	try {
		const payload = Buffer.byteLength(raw) <= MAX_BYTES ? parseObject(raw) : null;
		const action = payload ? guardFileContext(payload, env, overrides.statFile) : null;
		if (action) {
			const context = clientContext(payload, env, { now, deadline }, overrides);
			if (action.action === "lookup") action.project = resolveProject(payload, env);
			outcome = await retrieveContext(context, action);
		}
	} catch {
		/* Hook failures must not prevent Read. */
	}
	try {
		await (overrides.writeOutput ?? writeHostOutput)(JSON.stringify(outcome.result));
	} catch {
		return;
	} // Never acknowledge context the host did not receive.
	try {
		await outcome.acknowledge?.("handed_off");
	} catch {
		/* No fallback after output. */
	}
}

async function readInput(deadline) {
	const chunks = [];
	let bytes = 0;
	const timer = setTimeout(
		() => process.stdin.destroy(),
		Math.max(0, deadline - performance.now()),
	);
	try {
		for await (const chunk of process.stdin) {
			bytes += chunk.length;
			if (bytes > MAX_BYTES) return "";
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks).toString("utf8");
	} finally {
		clearTimeout(timer);
	}
}

if (isMainModule(process.argv[1], scriptPath)) {
	const deadline = performance.now() + hookBudget(process.env);
	// EPIPE means the host stopped listening; no delivery acknowledgment may follow.
	process.stdout.on("error", () => {});
	await runClaudePreReadHook(await readInput(deadline).catch(() => ""), { deadline });
}
