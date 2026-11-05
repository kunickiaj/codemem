/**
 * Native codemem memory tools for OpenCode: the plugin registers the same
 * fourteen tools the codemem MCP server exposes and runs each call through
 * the shared viewer (`POST /api/memory-tools/:name`), falling back to
 * `codemem memory-tool <name>` when the viewer cannot take the call.
 *
 * Arguments pass through unchanged. The viewer and the CLI run the real MCP
 * handlers with this caller's directory and CODEMEM_PROJECT, so default
 * project scoping matches stdio MCP without the plugin injecting anything.
 */

import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export const NATIVE_TOOLS_ENV = "CODEMEM_OPENCODE_NATIVE_TOOLS";
// Experimental for one release; the setup/docs rollout step flips this default.
// On by default; CODEMEM_OPENCODE_NATIVE_TOOLS=0 (or false/no/off) turns it off.
const NATIVE_TOOLS_DEFAULT = true;
const TRUTHY_VALUES = new Set(["1", "true", "yes"]);
const FALSY_VALUES = new Set(["0", "false", "no", "off"]);

export const MEMORY_TOOL_NAMESPACE = "codemem";
export const MEMORY_TOOL_NAMESPACE_DESCRIPTION =
  "codemem persistent memory: search, inspect, and record memories for this project";
// The ingest filter drops tool events with this prefix, so tool output never
// gets captured and re-distilled into new memories.
export const MEMORY_TOOL_ID_PREFIX = "codemem_memory_";
export const CLI_FALLBACK_NOTE = "(codemem viewer unavailable; ran via CLI)";
export const MEMORY_TOOL_CALL_CAPABILITY = "memory_tool_call";

const WRITE_TOOLS = new Set(["memory_remember", "memory_forget"]);
const TOOL_TIMEOUT_MS = Object.freeze({
  memory_pack: 120_000,
  memory_distill_candidates: 300_000,
});
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const PROOF_TIMEOUT_MS = 2_000;
const PROOF_TTL_MS = 30_000;
// Failures where the request never reached the viewer, so a CLI retry cannot double-apply a write.
const SAFE_CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);
const FALLBACK_STATUSES = new Set([404, 405, 409]);

const isRecord = (value) => value != null && typeof value === "object" && !Array.isArray(value);

export const nativeMemoryToolsEnabled = (env = process.env) => {
  const raw = String(env[NATIVE_TOOLS_ENV] ?? "").trim().toLowerCase();
  if (!raw) return NATIVE_TOOLS_DEFAULT;
  if (TRUTHY_VALUES.has(raw)) return true;
  return !FALSY_VALUES.has(raw) && NATIVE_TOOLS_DEFAULT;
};

export const memoryToolId = (name) => `${MEMORY_TOOL_NAMESPACE}_${name}`;

/** Host tool names may arrive namespaced with dots (`codemem.memory_search`); compare the effective form. */
export const isMemoryToolId = (toolName) =>
  String(toolName || "").replace(/[^A-Za-z0-9_]/g, "_").startsWith(MEMORY_TOOL_ID_PREFIX);

let contractsCache = null;
export const loadMemoryToolContracts = () => {
  contractsCache ??= Object.freeze(
    JSON.parse(readFileSync(new URL("./memory-tool-contracts.json", import.meta.url), "utf8")),
  );
  return contractsCache;
};

export const memoryToolTimeoutMs = (name) => TOOL_TIMEOUT_MS[name] ?? DEFAULT_TOOL_TIMEOUT_MS;

const abortError = (signal) => {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("codemem memory tool call was cancelled");
  error.name = "AbortError";
  return error;
};

const throwIfAborted = (signal) => {
  if (signal?.aborted) throw abortError(signal);
};

const collectErrorCodes = (error) => {
  const codes = [];
  let current = error;
  for (let depth = 0; depth < 6 && isRecord(current); depth += 1) {
    if (typeof current.code === "string") codes.push(current.code);
    current = current.cause;
  }
  return codes;
};

export const isSafeConnectFailure = (error) =>
  collectErrorCodes(error).some((code) => SAFE_CONNECT_CODES.has(code));

/** Abort on the caller's signal or after `timeoutMs`, and report which one fired. */
const linkSignal = (timeoutMs, signal) => {
  const controller = new AbortController();
  const state = { timedOut: false };
  const onAbort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    state,
    release: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
};

const readJson = async (response) => {
  try {
    return await response.json();
  } catch {
    return null;
  }
};

export const buildMemoryToolCaller = ({ directory, sessionID, callID, envProject }) => {
  const sessionId = typeof sessionID === "string" && sessionID.trim() ? sessionID.trim() : null;
  const requestId = typeof callID === "string" && callID.trim() ? callID.trim() : null;
  const project = typeof envProject === "string" ? envProject.trim() : "";
  return {
    directory,
    env_project: project || null,
    ...(sessionId ? { session_id: sessionId } : {}),
    // The viewer rejects a request ID without a session, and so would the ledger.
    ...(sessionId && requestId ? { request_id: requestId } : {}),
  };
};

/**
 * `--db-path` pins the database the viewer target proof uses. A relative
 * CODEMEM_DB would otherwise resolve against the caller directory (the CLI's
 * cwd) instead of the runtime cwd the viewer was started from.
 */
export const buildMemoryToolCliArgs = (name, caller, dbPath) => {
  const args = ["memory-tool", name];
  if (dbPath) args.push("--db-path", dbPath);
  if (caller.session_id) args.push("--session-id", caller.session_id);
  if (caller.request_id) args.push("--request-id", caller.request_id);
  return args;
};

/** The last stdout line that parses as a JSON object; the CLI may log before it. */
const parseCliPayload = (stdout) => {
  const lines = String(stdout || "").split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) return parsed;
    } catch {
      // keep scanning earlier lines
    }
  }
  return null;
};

const toolOutcome = (payload) => {
  if (payload.ok === true) return { ok: true, result: payload.result };
  return {
    ok: false,
    error: String(payload.error ?? "tool_error"),
    ...(payload.result !== undefined ? { result: payload.result } : {}),
  };
};

const unsettledWriteMessage = (name, reason) =>
  `${name} ${reason}; the write may have completed, so it was not retried. Check with memory_recent before retrying.`;

/** Viewer failure where retrying the same call through the CLI is safe for reads but not writes. */
const uncertainFailure = (name, reason) => {
  if (WRITE_TOOLS.has(name)) return { kind: "error", error: unsettledWriteMessage(name, reason) };
  return { kind: "fallback", reason };
};

const classifyViewerResponse = async (name, response) => {
  const body = await readJson(response);
  if (response.ok && isRecord(body) && typeof body.ok === "boolean") {
    return { kind: "outcome", outcome: toolOutcome(body) };
  }
  if (response.ok) return uncertainFailure(name, "returned a malformed viewer response");
  if (FALLBACK_STATUSES.has(response.status)) {
    return { kind: "fallback", reason: `viewer HTTP ${response.status}`, invalidate: true };
  }
  if (response.status >= 500) return uncertainFailure(name, `failed in the viewer (HTTP ${response.status})`);
  const message = isRecord(body?.error) ? body.error.message : body?.error;
  return { kind: "error", error: String(message || `viewer HTTP ${response.status}`) };
};

const createViewerProof = ({ fetchImpl, profileUrl, isProfileMatch, now }) => {
  let provenUntil = 0;
  const prove = async (signal) => {
    if (now() < provenUntil) return true;
    const link = linkSignal(PROOF_TIMEOUT_MS, signal);
    try {
      const response = await fetchImpl(profileUrl, { method: "GET", redirect: "manual", signal: link.signal });
      const profile = response.ok ? await readJson(response) : null;
      const capable = Array.isArray(profile?.capabilities)
        && profile.capabilities.includes(MEMORY_TOOL_CALL_CAPABILITY);
      if (!capable || !isProfileMatch(profile)) return false;
      provenUntil = now() + PROOF_TTL_MS;
      return true;
    } catch {
      throwIfAborted(signal);
      return false;
    } finally {
      link.release();
    }
  };
  return {
    prove,
    invalidate: () => {
      provenUntil = 0;
    },
  };
};

const formatCliFailure = (name, result) => {
  if (result.exitCode === null) {
    if (WRITE_TOOLS.has(name)) return unsettledWriteMessage(name, "timed out in the codemem CLI");
    return `${name} timed out in the codemem CLI`;
  }
  const payload = parseCliPayload(result.stdout);
  const detail = payload?.message ?? payload?.error ?? String(result.stderr || "").trim();
  return detail ? String(detail) : `codemem memory-tool exited with code ${result.exitCode}`;
};

/**
 * @param {object} options
 * @param {boolean} options.viewerEnabled
 * @param {string} options.viewerBaseUrl `http://host:port`, no trailing slash
 * @param {string} options.dbPath
 * @param {object} options.identityTarget
 * @param {(profile: unknown) => boolean} options.isProfileMatch Same target proof prompt recall uses.
 * @param {(args: string[], options: object) => Promise<{exitCode: number | null, stdout: string, stderr: string}>} options.runCli
 * @param {string} options.defaultDirectory Used only when the host context omits a directory.
 */
export const createMemoryToolExecutor = ({
  viewerEnabled,
  viewerBaseUrl,
  dbPath,
  identityTarget,
  isProfileMatch,
  runCli,
  defaultDirectory,
  readEnvProject = () => process.env.CODEMEM_PROJECT,
  fetchImpl = (...args) => fetch(...args),
  now = Date.now,
}) => {
  const proof = createViewerProof({
    fetchImpl,
    profileUrl: `${viewerBaseUrl}/api/prompt-pack-profile`,
    isProfileMatch,
    now,
  });

  const callViewer = async (name, args, caller, signal) => {
    if (!viewerEnabled) return { kind: "fallback", reason: "viewer disabled" };
    if (!(await proof.prove(signal))) return { kind: "fallback", reason: "viewer unproven" };
    const link = linkSignal(memoryToolTimeoutMs(name), signal);
    try {
      const response = await fetchImpl(`${viewerBaseUrl}/api/memory-tools/${encodeURIComponent(name)}`, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ arguments: args, caller, db_path: dbPath, identity_target: identityTarget }),
        signal: link.signal,
      });
      const classified = await classifyViewerResponse(name, response);
      if (classified.invalidate) proof.invalidate();
      return classified;
    } catch (error) {
      proof.invalidate();
      throwIfAborted(signal);
      if (link.state.timedOut) return uncertainFailure(name, "timed out in the viewer");
      if (isSafeConnectFailure(error)) return { kind: "fallback", reason: "viewer unreachable" };
      return uncertainFailure(name, "lost its viewer connection");
    } finally {
      link.release();
    }
  };

  const callCli = async (name, args, caller, signal) => {
    const result = await runCli(buildMemoryToolCliArgs(name, caller, dbPath), {
      cwd: caller.directory,
      stdinText: JSON.stringify(args),
      signal,
      timeoutMs: memoryToolTimeoutMs(name),
    });
    throwIfAborted(signal);
    const payload = result.exitCode === 0 ? parseCliPayload(result.stdout) : null;
    if (typeof payload?.ok === "boolean") return toolOutcome(payload);
    return { ok: false, error: formatCliFailure(name, result) };
  };

  /**
   * Run one memory tool. Resolves `{ ok, result | error, transport }`; throws
   * only when `signal` aborts.
   */
  const execute = async (name, rawArgs, { directory, sessionID, callID, signal } = {}) => {
    throwIfAborted(signal);
    const args = isRecord(rawArgs) ? rawArgs : {};
    const caller = buildMemoryToolCaller({
      directory: typeof directory === "string" && isAbsolute(directory) ? directory : defaultDirectory,
      sessionID,
      callID,
      envProject: readEnvProject(),
    });
    const viewer = await callViewer(name, args, caller, signal);
    if (viewer.kind === "outcome") return { ...viewer.outcome, transport: "viewer" };
    if (viewer.kind === "error") return { ok: false, error: viewer.error, transport: "viewer" };
    return { ...(await callCli(name, args, caller, signal)), transport: "cli" };
  };

  return { execute, invalidateProof: proof.invalidate };
};

const resultText = (value) => (typeof value === "string" ? value : JSON.stringify(value ?? null));

/**
 * Text the model sees, matching the MCP tool content: the JSON result on
 * success, the MCP error payload (or `{"error":...}`) on failure. The CLI note
 * stays separate so the JSON remains parseable.
 */
export const formatMemoryToolOutcome = (outcome) => {
  let text;
  if (outcome.ok) text = resultText(outcome.result);
  else if (outcome.result != null) text = resultText(outcome.result);
  else text = JSON.stringify({ error: outcome.error });
  return {
    isError: !outcome.ok,
    text,
    note: outcome.transport === "cli" ? CLI_FALLBACK_NOTE : null,
  };
};

export const MCP_PREFERRED_MESSAGE =
  "codemem MCP server is configured, so codemem's built-in memory tools are off. "
  + "Run `codemem setup` (or remove the codemem MCP server from your OpenCode config) to switch to them, or keep it.";
const MCP_DETECTION_TIMEOUT_MS = 2_000;

const withTimeout = (promise, timeoutMs) => {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/**
 * Runtime-facing bundle: contracts, the executor, and the registration
 * decision. A configured "codemem" MCP server wins so the model never sees
 * two sets of memory tools (users who chose `--opencode-mcp stdio`, or who
 * upgraded without re-running setup). Detection failures register the
 * native tools.
 */
export const createNativeMemoryTools = ({ executor, log, notify = null }) => {
  const announceMcpPreferred = async () => {
    await log("warn", MCP_PREFERRED_MESSAGE);
    if (!notify) return;
    try {
      await notify({ message: MCP_PREFERRED_MESSAGE, variant: "warning" });
    } catch {
      // best-effort only
    }
  };
  let announced = false;
  const announceOnce = async () => {
    if (announced) return;
    announced = true;
    await announceMcpPreferred();
  };
  return {
    contracts: loadMemoryToolContracts(),
    execute: executor.execute,
    /** Log and toast once that a codemem MCP server took precedence. */
    announceMcpPreferred: announceOnce,
    /** @param {{ isCodememMcpConfigured: (() => Promise<boolean>) | null }} detection */
    shouldRegister: async ({ isCodememMcpConfigured }) => {
      if (typeof isCodememMcpConfigured !== "function") {
        await log("warn", "codemem could not check for a codemem MCP server; registering built-in memory tools");
        return true;
      }
      let configured;
      try {
        configured = await withTimeout(isCodememMcpConfigured(), MCP_DETECTION_TIMEOUT_MS);
      } catch (error) {
        await log("warn", "codemem MCP server check failed; registering built-in memory tools", {
          error: error instanceof Error ? error.message : String(error),
        });
        return true;
      }
      if (!configured) return true;
      await announceOnce();
      return false;
    },
  };
};
