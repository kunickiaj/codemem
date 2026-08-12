import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, posix, resolve, win32 } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { spawn as nodeSpawn, execSync } from "node:child_process";
import { tool } from "@opencode-ai/plugin";

import {
  isVersionAtLeast,
  parseBackendUpdatePolicy,
  parseSemver,
  resolveAutoUpdatePlan,
  resolveUpgradeGuidance,
} from "../lib/compat.js";

const TRUTHY_VALUES = ["1", "true", "yes"];
const DISABLED_VALUES = ["0", "false", "off"];
const PINNED_BACKEND_VERSION = "0.40.2";
const COMPAT_CHECK_DELAY_MS = 1500;
const COMPAT_CHECK_CACHE_TTL_MS = 5 * 60 * 1000;
const CODEMEM_CONTEXT_PART_ID_PREFIX = "codemem-context-";
const MAX_MESSAGE_INJECTION_CACHE_SESSIONS = 20;
const MAX_MESSAGE_INJECTION_CACHE_MESSAGES = 100;
const COMPACTION_INJECTION_SKIP_TTL_MS = 30 * 1000;
const MAX_WORKING_SET_PATH_CHARS = 400;
const VIEWER_HEALTH_CHECK_INTERVAL_MS = 60_000;
const VIEWER_HEALTH_TIMEOUT_MS = 5_000;
const VIEWER_HEALTH_RESTART_THRESHOLD = 3;
const VIEWER_HEALTH_RESTART_COOLDOWN_MS = 5 * 60_000;
const RAW_EVENTS_STATUS_TIMEOUT_MS = 5_000;

let compatCheckCache = null;

// Release an unread response body without surfacing cancellation failures.
const discardResponseBody = (response) => {
  try {
    const cancelled = response?.body?.cancel?.();
    if (cancelled && typeof cancelled.catch === "function") {
      cancelled.catch(() => {});
    }
  } catch {
    // Best effort — a locked or already-errored stream is fine to abandon.
  }
};

// Bounded ingest-availability preflight: a hung viewer socket must not stall
// raw-event delivery indefinitely. Failures fall into the existing stream
// backoff + CLI enqueue fallback path.
const fetchRawEventsStatus = (url, fetchFn = fetch) =>
  fetchFn(url, {
    method: "GET",
    signal: AbortSignal.timeout(RAW_EVENTS_STATUS_TIMEOUT_MS),
  });

const normalizeEnvValue = (value) => (value || "").toLowerCase();
const envHasValue = (value, truthyValues) =>
  truthyValues.includes(normalizeEnvValue(value));
const envNotDisabled = (value) =>
  !DISABLED_VALUES.includes(normalizeEnvValue(value));

const createViewerHealthMonitor = ({
  viewerHealthUrl,
  legacyStatusUrl,
  isActive,
  restartViewer,
  logLine,
  fetchFn = fetch,
  now = Date.now,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  timeoutSignal = (timeoutMs) => AbortSignal.timeout(timeoutMs),
}) => {
  let timer = null;
  let consecutiveFailures = 0;
  let lastRestartAttempt = 0;

  const boundedFetch = (url) => fetchFn(url, {
    method: "GET",
    signal: timeoutSignal(VIEWER_HEALTH_TIMEOUT_MS),
  });

  const probe = async () => {
    let response;
    try {
      response = await boundedFetch(viewerHealthUrl);
    } catch (error) {
      return { live: false, detail: `error: ${String(error).slice(0, 200)}` };
    }

    if (response.status === 404) {
      discardResponseBody(response);
      try {
        // Old-viewer compatibility: released viewers serving this route
        // always include the `ingest` availability object, so require that
        // identifying evidence rather than trusting any 2xx from an
        // arbitrary local service.
        const fallbackResponse = await boundedFetch(legacyStatusUrl);
        if (!fallbackResponse.ok) {
          discardResponseBody(fallbackResponse);
          return { live: false, detail: `fallback status=${fallbackResponse.status}` };
        }
        const fallbackPayload = await fallbackResponse.json();
        const looksLikeViewer =
          fallbackPayload &&
          typeof fallbackPayload === "object" &&
          fallbackPayload.ingest &&
          typeof fallbackPayload.ingest === "object";
        return looksLikeViewer
          ? { live: true }
          : { live: false, detail: "fallback unexpected payload" };
      } catch (error) {
        return { live: false, detail: `fallback error: ${String(error).slice(0, 200)}` };
      }
    }

    if (!response.ok) {
      // Release the unread body so a persistently failing viewer does not
      // pin connections across the 60s monitor interval.
      discardResponseBody(response);
      return { live: false, detail: `status=${response.status}` };
    }

    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      return { live: false, detail: `invalid JSON: ${String(error).slice(0, 200)}` };
    }
    if (!payload || typeof payload !== "object" || payload.service !== "codemem-viewer") {
      return { live: false, detail: "unexpected service" };
    }
    return { live: true };
  };

  const check = async () => {
    if (!isActive()) return;
    const result = await probe();
    if (result.live) {
      if (consecutiveFailures > 0) {
        await logLine(`viewer.health recovered after ${consecutiveFailures} failure(s)`);
      }
      consecutiveFailures = 0;
      return;
    }

    consecutiveFailures += 1;
    await logLine(
      `viewer.health check failed (${result.detail}, consecutive=${consecutiveFailures})`
    );
    if (
      consecutiveFailures < VIEWER_HEALTH_RESTART_THRESHOLD ||
      now() - lastRestartAttempt < VIEWER_HEALTH_RESTART_COOLDOWN_MS
    ) {
      return;
    }

    // Re-check after the awaited probe: a stop requested while the probe was
    // in flight must not be undone by a restart.
    if (!isActive()) return;

    lastRestartAttempt = now();
    await logLine(`viewer.health restarting viewer after ${consecutiveFailures} consecutive failures`);
    try {
      const restartResult = await restartViewer();
      const restarted = restartResult?.exitCode === 0;
      await logLine(
        `viewer.health restart ${restarted ? "succeeded" : "failed"} (exit=${restartResult?.exitCode ?? "unknown"})`
      );
      if (restarted) consecutiveFailures = 0;
    } catch (error) {
      await logLine(`viewer.health restart error: ${String(error).slice(0, 200)}`);
    }
  };

  const start = () => {
    if (timer) return;
    consecutiveFailures = 0;
    timer = setIntervalFn(() => {
      check().catch(() => {});
    }, VIEWER_HEALTH_CHECK_INTERVAL_MS);
    if (timer?.unref) timer.unref();
  };

  const stop = () => {
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    consecutiveFailures = 0;
  };

  return {
    check,
    start,
    stop,
    state: () => ({
      consecutiveFailures,
      lastRestartAttempt,
      running: timer !== null,
    }),
  };
};

const resolveInjectSurface = (value) => {
  const normalized = String(value || "message").trim().toLowerCase();
  if (normalized === "system") {
    return "system";
  }
  return "message";
};

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const deterministicUuid = (namespace, components) => {
  const hex = createHash("sha256")
    .update(JSON.stringify([namespace, ...components.map((value) => String(value ?? ""))]))
    .digest("hex");
  const bytes = Buffer.from(hex.slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

const promptPackIdentity = ({
  source = "opencode",
  sessionID = "unknown",
  requestKey,
  surface,
  promptNumber = 0,
  queryHash,
}) => {
  const components = [source, sessionID, requestKey, surface, promptNumber, queryHash];
  return {
    attemptId: deterministicUuid("codemem.prompt-pack.attempt.v1", components),
    requestId: deterministicUuid("codemem.prompt-pack.request.v1", components),
  };
};

const hashPromptPackQuery = (query) =>
  createHash("sha256").update(String(query || "")).digest("hex");

const redactPackCommand = (runner, runnerArgs, packArgs) => {
  const safePackArgs = [...packArgs];
  if (safePackArgs[0] === "pack" && safePackArgs.length > 1) {
    safePackArgs[1] = "[query-redacted]";
  }
  for (let index = 0; index < safePackArgs.length - 1; index += 1) {
    if (safePackArgs[index] === "--working-set-file") {
      safePackArgs[index + 1] = "[path-redacted]";
    }
  }
  return [runner, ...runnerArgs, ...safePackArgs].join(" ");
};

const rejectsInternalLedgerFlag = (result) => {
  if (!result || result.exitCode === 0) return false;
  const diagnostics = `${result.stderr || ""}\n${result.stdout || ""}`;
  return diagnostics.includes("--internal-ledger")
    && /(?:unknown|unsupported|unrecognized|invalid)\s+(?:option|argument)/i.test(diagnostics);
};

const parseFallbackStructuredError = (stdout) => {
  const lines = String(stdout || "").trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") {
        return {
          code: typeof parsed.error === "string" ? parsed.error : "",
          message: typeof parsed.message === "string" ? parsed.message : "",
        };
      }
    } catch {
      // Continue past non-JSON CLI output.
    }
  }
  return { code: "", message: "" };
};

const classifyFallbackCommandResult = (result) => {
  const structured = parseFallbackStructuredError(result?.stdout);
  const diagnostic = [structured.code, structured.message, result?.stderr, result?.stdout]
    .filter(Boolean)
    .join("\n");
  if (/SQLITE_(?:BUSY|LOCKED)|database(?: table)? (?:is )?(?:busy|locked)/i.test(diagnostic)) {
    return { retryable: true, cause: "SQLite database is locked" };
  }
  if (result?.exitCode == null && /(?:timeout|timed out|ETIMEDOUT)/i.test(diagnostic)) {
    return { retryable: true, cause: "enqueue-raw-event command timeout" };
  }
  if (structured.code === "validation_error" || /invalid raw event|session id required/i.test(diagnostic)) {
    return { retryable: false, cause: "enqueue-raw-event validation failed" };
  }
  if (/unknown command ['\"]?enqueue-raw-event|command not found|\bENOENT\b/i.test(diagnostic)) {
    return { retryable: false, cause: "enqueue-raw-event command unavailable" };
  }
  const exitCode = result?.exitCode ?? "unknown";
  return { retryable: false, cause: `enqueue-raw-event failed (${exitCode})` };
};

const DEFAULT_LOG_PATH = (homeDir, cwd) => `${homeDir || cwd}/.codemem/plugin.log`;

const resolveLogPath = (logPathEnvRaw, cwd, homeDir) => {
  const logPathEnv = normalizeEnvValue(logPathEnvRaw);
  const logEnabled = !!logPathEnvRaw && !DISABLED_VALUES.includes(logPathEnv);
  if (!logEnabled) {
    return null;
  }
  if (["true", "yes", "1"].includes(logPathEnv)) {
    return DEFAULT_LOG_PATH(homeDir, cwd);
  }
  return logPathEnvRaw;
};

/** Path for error/warning logging — always available regardless of debug flag. */
const resolveErrorLogPath = (cwd, homeDir) => DEFAULT_LOG_PATH(homeDir, cwd);

const resolveCompatCheckCacheKey = ({ backendUpdatePolicy, minVersion, runner, runnerFrom }) =>
  [backendUpdatePolicy, minVersion, runner, runnerFrom || ""].join("|");

const readCompatCheckCache = (cacheKey) => {
  if (!compatCheckCache) {
    return null;
  }
  if (compatCheckCache.cacheKey !== cacheKey) {
    return null;
  }
  if (Date.now() >= compatCheckCache.expiresAtMs) {
    compatCheckCache = null;
    return null;
  }
  return compatCheckCache.value;
};

const writeCompatCheckCache = (cacheKey, value) => {
  compatCheckCache = {
    cacheKey,
    expiresAtMs: Date.now() + COMPAT_CHECK_CACHE_TTL_MS,
    value,
  };
};

const clearCompatCheckCache = () => {
  compatCheckCache = null;
};

const createLogLine = (logPath) => async (line) => {
  if (!logPath) {
    return;
  }
  try {
    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${new Date().toISOString()} ${line}\n`);
  } catch (err) {
    // ignore logging failures
  }
};

const createDebugLogger = ({ debug, client, logTimeoutMs, getLogLine, getErrorLogLine }) =>
  async (level, message, extra = {}) => {
    // Always log errors and warnings to the error log path
    const alwaysLog = level === "error" || level === "warn";
    if (alwaysLog) {
      const extraStr = Object.keys(extra).length > 0 ? ` ${JSON.stringify(extra)}` : "";
      await getErrorLogLine()(`[${level}] ${message}${extraStr}`);
    }
    if (!debug && !alwaysLog) {
      return;
    }
    try {
      const logPromise = client.app.log({
        service: "codemem",
        level,
        message,
        extra,
      });
      if (!Number.isFinite(logTimeoutMs) || logTimeoutMs <= 0) {
        await logPromise;
        return;
      }
      let timedOut = false;
      await Promise.race([
        logPromise,
        new Promise((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, logTimeoutMs)
        ),
      ]);
      if (timedOut) {
        await getLogLine()("debug log timed out");
      }
    } catch (err) {
      // ignore debug logging failures
    }
  };

const extractApplyPatchPaths = (patchText) => {
  if (!patchText || typeof patchText !== "string") {
    return [];
  }
  const paths = [];
  const seen = new Set();
  const lines = patchText.split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (!match) {
      continue;
    }
    const path = String(match[1] || "").trim();
    if (!path || seen.has(path)) {
      continue;
    }
    seen.add(path);
    paths.push(path);
  }
  return paths;
};

const windowsPathFlavor = (value, doubleSlashIsUnc = true) =>
  /^[A-Za-z]:[\\/]/.test(value)
  || /^\\\\/.test(value)
  || (doubleSlashIsUnc && /^\/\/[^/]+[\\/][^/]+/.test(value));

const hasTraversalSegment = (value) =>
  value.replaceAll("\\", "/").split("/").includes("..");

const normalizeWorkingSetPath = (value, repositoryRoot) => {
  if (typeof value !== "string" || typeof repositoryRoot !== "string") return null;
  const candidate = value.trim();
  if (
    !candidate
    || candidate.length > MAX_WORKING_SET_PATH_CHARS
    || hasTraversalSegment(candidate)
  ) {
    return null;
  }

  const root = repositoryRoot.trim();
  const candidateIsAbsolute = posix.isAbsolute(candidate) || win32.isAbsolute(candidate);
  if (candidateIsAbsolute) {
    if (!root || hasTraversalSegment(root)) return null;
    const rootUsesWindows = windowsPathFlavor(root);
    const candidateUsesWindows = windowsPathFlavor(candidate, rootUsesWindows);
    if (candidateUsesWindows !== rootUsesWindows) return null;
    const pathApi = candidateUsesWindows ? win32 : posix;
    if (!pathApi.isAbsolute(root) || !pathApi.isAbsolute(candidate)) return null;
    const relative = pathApi.relative(pathApi.normalize(root), pathApi.normalize(candidate));
    if (
      !relative
      || relative === ".."
      || relative.startsWith(`..${pathApi.sep}`)
      || pathApi.isAbsolute(relative)
    ) {
      return null;
    }
    const normalized = relative.replaceAll("\\", "/");
    return normalized.length <= MAX_WORKING_SET_PATH_CHARS ? normalized : null;
  }

  if (/^[A-Za-z]:/.test(candidate)) return null;
  const normalized = posix.normalize(candidate.replaceAll("\\", "/")).replace(/^\.\//, "");
  if (
    !normalized
    || normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || posix.isAbsolute(normalized)
    || normalized.length > MAX_WORKING_SET_PATH_CHARS
  ) {
    return null;
  }
  return normalized;
};

const addWorkingSetPath = (paths, value, repositoryRoot) => {
  const normalized = normalizeWorkingSetPath(value, repositoryRoot);
  if (!normalized) return null;
  const duplicate = windowsPathFlavor(repositoryRoot)
    ? Array.from(paths).some((existing) => existing.toLowerCase() === normalized.toLowerCase())
    : paths.has(normalized);
  if (!duplicate) paths.add(normalized);
  return normalized;
};

const appendWorkingSetFileArgs = (args, workingSetFiles) => {
  if (!Array.isArray(workingSetFiles) || workingSetFiles.length === 0) {
    return args;
  }
  for (const file of workingSetFiles) {
    const normalized = String(file || "").trim();
    if (!normalized || normalized.length > MAX_WORKING_SET_PATH_CHARS) {
      continue;
    }
    args.push("--working-set-file", normalized);
  }
  return args;
};

const buildInjectQuery = ({ firstPrompt, lastPromptText, projectName, filesModified }) => {
  const parts = [];

  if (firstPrompt && String(firstPrompt).trim()) {
    parts.push(String(firstPrompt).trim());
  }

  if (
    lastPromptText
    && String(lastPromptText).trim()
    && String(lastPromptText).trim() !== String(firstPrompt || "").trim()
    && String(lastPromptText).trim().length > 5
  ) {
    parts.push(String(lastPromptText).trim());
  }

  if (projectName) {
    parts.push(String(projectName));
  }

  const recentFiles = Array.from(filesModified || [])
    .slice(-5)
    .map((filePath) => String(filePath || "").split("/").pop())
    .filter(Boolean)
    .join(" ");
  if (recentFiles) {
    parts.push(recentFiles);
  }

  if (parts.length === 0) {
    return "recent work";
  }

  const query = parts.join(" ");
  return query.length > 500 ? query.slice(0, 500) : query;
};

const buildPackArgs = ({ query, filesModified, injectLimit, injectTokenBudget, internalLedger = false }) => {
  const workingSetFiles = Array.from(filesModified || [])
    .slice(-8)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const args = ["pack", query, "--json"];
  if (internalLedger) {
    args.push("--internal-ledger");
  }
  if (injectLimit !== null && Number.isFinite(injectLimit) && injectLimit > 0) {
    args.push("--limit", String(injectLimit));
  }
  if (
    injectTokenBudget !== null
    && Number.isFinite(injectTokenBudget)
    && injectTokenBudget > 0
  ) {
    args.push("--token-budget", String(injectTokenBudget));
  }
  return appendWorkingSetFileArgs(args, workingSetFiles);
};

const parsePackText = (stdout) => {
  if (!stdout || !stdout.trim()) {
    return "";
  }
  try {
    const payload = JSON.parse(stdout);
    return (payload?.pack_text || "").trim();
  } catch {
    return "";
  }
};

const parsePackMetrics = (stdout) => {
  if (!stdout || !stdout.trim()) {
    return null;
  }
  try {
    const payload = JSON.parse(stdout);
    return payload?.metrics || null;
  } catch {
    return null;
  }
};

const parsePackOutput = (result) => {
  const succeeded = result?.exitCode === 0;
  let payload = null;
  if (succeeded) {
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      payload = null;
    }
  }
  const ledgerConflict = payload?.ledger_outcome?.ok === false
    && payload.ledger_outcome.errorCode === "retrieval_ledger_write_failed"
    && payload.ledger_outcome.reason === "idempotency_conflict";
  const metrics = succeeded ? payload?.metrics || null : null;
  const itemCount = Number.isFinite(Number(metrics?.total_items))
    ? Number(metrics.total_items)
    : null;
  const candidatePackText = succeeded && itemCount !== 0
    ? String(payload?.pack_text || "").trim()
    : "";
  return {
    conflictPackText: ledgerConflict ? candidatePackText : "",
    ledgerConflict,
    metrics,
    itemCount,
    // The real builder renders section headings even when it selected no
    // memories. Treat the structured count as authoritative so headings alone
    // are never handed to the model as retrieved context.
    packText: !ledgerConflict ? candidatePackText : "",
  };
};

const isRecord = (value) => value != null && typeof value === "object" && !Array.isArray(value);

const isValidPackHttpPayload = (payload) => {
  if (!isRecord(payload) || typeof payload.pack_text !== "string" || !isRecord(payload.metrics)) {
    return false;
  }
  const itemCount = payload.metrics.total_items;
  if (!Number.isInteger(itemCount) || itemCount < 0) {
    return false;
  }
  if (
    payload.ledger_artifact_fingerprint != null
    && !/^[0-9a-f]{64}$/i.test(payload.ledger_artifact_fingerprint)
  ) {
    return false;
  }
  if (payload.ledger_outcome != null) {
    return isRecord(payload.ledger_outcome)
      && payload.ledger_outcome.ok === false
      && payload.ledger_outcome.errorCode === "retrieval_ledger_write_failed"
      && payload.ledger_outcome.reason === "idempotency_conflict";
  }
  return true;
};

const isValidLedgerHttpPayload = (payload) => isRecord(payload) && payload.ok === true;

const isValidLedgerFailureHttpPayload = (payload) =>
  isRecord(payload)
  && payload.ok === false
  && (
    payload.errorCode === "retrieval_ledger_write_failed"
    || payload.errorCode === "retrieval_ledger_delivery_write_failed"
  )
  && typeof payload.reason === "string";

const isViewerDbMismatchPayload = (payload) =>
  isRecord(payload)
  && isRecord(payload.error)
  && payload.error.code === "viewer_db_mismatch";

const isViewerIdentityMismatchPayload = (payload) =>
  isRecord(payload)
  && isRecord(payload.error)
  && payload.error.code === "viewer_identity_mismatch";

const isViewerContractUnsupportedPayload = (payload) =>
  isRecord(payload)
  && isRecord(payload.error)
  && payload.error.code === "viewer_contract_unsupported";

const isViewerInvalidRequestPayload = (payload) =>
  isRecord(payload)
  && isRecord(payload.error)
  && payload.error.code === "invalid_request"
  && typeof payload.error.message === "string";

const classifyViewerHttpFailure = ({
  operation,
  status = null,
  error = null,
  malformed = false,
  body = null,
}) => {
  if (malformed) {
    return { cause: `${operation} returned malformed success`, retryable: true };
  }
  if (
    isViewerDbMismatchPayload(body)
    || isViewerIdentityMismatchPayload(body)
    || isViewerContractUnsupportedPayload(body)
  ) {
    return { cause: `${operation} viewer profile mismatch`, retryable: true };
  }
  if (operation === "prompt-pack-ledger" && isValidLedgerFailureHttpPayload(body)) {
    return { cause: `${operation} request rejected (${status})`, retryable: false };
  }
  if (isViewerInvalidRequestPayload(body) && !operation.endsWith(" profile")) {
    return { cause: `${operation} request rejected (${status})`, retryable: false };
  }
  if (status === 404 || status === 405) {
    return { cause: `${operation} endpoint unavailable (${status})`, retryable: true };
  }
  if (Number.isInteger(status) && status >= 500) {
    return { cause: `${operation} server failure (${status})`, retryable: true };
  }
  if (Number.isInteger(status)) {
    return { cause: `${operation} unexpected response (${status})`, retryable: true };
  }
  const diagnostic = [
    error?.name,
    error?.code,
    error?.cause?.code,
    error?.message,
    error,
  ].filter(Boolean).join(" ");
  const timedOut = /AbortError|TimeoutError|timeout|timed out|ETIMEDOUT/i.test(diagnostic);
  return {
    cause: timedOut ? `${operation} request timeout` : `${operation} connection failed`,
    retryable: true,
  };
};

const buildPackHttpBody = ({
  query,
  filesModified,
  injectLimit,
  injectTokenBudget,
  projectName,
  cwd,
  dbPath,
  identityTarget,
  attempt,
}) => ({
  context: query,
  limit: injectLimit !== null && Number.isFinite(injectLimit) && injectLimit > 0
    ? Math.trunc(injectLimit)
    : 10,
  token_budget:
    injectTokenBudget !== null
    && Number.isFinite(injectTokenBudget)
    && injectTokenBudget > 0
      ? Math.trunc(injectTokenBudget)
      : null,
  ...(projectName ? { project: projectName } : {}),
  ...(cwd ? { cwd } : {}),
  db_path: dbPath,
  identity_target: identityTarget,
  working_set_files: Array.from(filesModified || [])
    .slice(-8)
    .map((value) => String(value || "").trim())
    .filter((value) => value && value.length <= MAX_WORKING_SET_PATH_CHARS),
  attempt,
});

const canonicalJson = (value) => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const promptPackArtifactFingerprint = (stdout, packText) => {
  try {
    const payload = JSON.parse(stdout);
    if (/^[0-9a-f]{64}$/i.test(payload?.ledger_artifact_fingerprint || "")) {
      return payload.ledger_artifact_fingerprint.toLowerCase();
    }
    return createHash("sha256").update(canonicalJson(payload)).digest("hex");
  } catch {
    return createHash("sha256").update(packText).digest("hex");
  }
};

const applyInjectedContextToOutput = async ({
  injectEnabled,
  input,
  output,
  injectionToastShown,
  showToast,
  resolveInjectQuery,
  buildInjectedContext,
  confirmDelivery,
  recordSkipped,
}) => {
  if (!injectEnabled) {
    recordSkipped?.("injection_disabled", input?.sessionID || null);
    return false;
  }

  // The previous incarnation cached by sessionID-only, so a follow-up
  // turn whose query happened to match the cache key (e.g. because
  // lastPromptText hadn't yet been captured by the time
  // experimental.chat.system.transform fired) would silently re-serve
  // the first turn's pack. Recompute on every call instead — the chat
  // path tolerates the transport round trip, and correctness beats the
  // O(1) hit when the cache key isn't tied to the prompt that produced
  // the pack.
  const query = resolveInjectQuery();
  const sessionID = input?.sessionID || null;
  const injected = await buildInjectedContext(query, {
    sessionID,
    requestKey: `system:${sessionID || "unknown"}`,
    surface: "system",
  });
  if (!injected?.text) {
    return false;
  }

  if (!injectionToastShown.has(input.sessionID) && showToast) {
    injectionToastShown.add(input.sessionID);
    try {
      await showToast(buildInjectionToastMessage(injected.metrics));
    } catch {
      // best-effort only
    }
  }

  try {
    if (!Array.isArray(output.system)) {
      output.system = [];
    }
    output.system.push(injected.text);
  } catch (error) {
    if (injected.attemptId) {
      confirmDelivery?.(injected.attemptId, "failed");
    }
    throw error;
  }
  if (injected.attemptId) {
    confirmDelivery?.(injected.attemptId);
  }
  return true;
};

const isUserMessageEntry = (entry) => entry?.info?.role === "user";

const resolveEntryMessageId = (entry) => {
  const id = entry?.info?.id || entry?.parts?.find((part) => part?.messageID)?.messageID;
  return id ? String(id) : null;
};

const fallbackEntryMessageId = (entry, index = 0) => {
  const id = resolveEntryMessageId(entry);
  if (id) return id;
  const text = extractMessageText(entry);
  if (text) {
    return `message-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
  }
  return `message-${index}`;
};

const resolveEntrySessionID = (entry) => {
  const id = entry?.info?.sessionID || entry?.parts?.find((part) => part?.sessionID)?.sessionID;
  return id ? String(id) : null;
};

const isCodememContextPart = (part) =>
  part?.type === "text" && String(part?.id || "").startsWith(CODEMEM_CONTEXT_PART_ID_PREFIX);

const extractMessageText = (entry) => {
  if (!Array.isArray(entry?.parts)) {
    return "";
  }
  return entry.parts
    .filter((part) => part?.type === "text" && !isCodememContextPart(part))
    .map((part) => String(part?.text || "").trim())
    .filter(Boolean)
    .join("\n")
    .trim();
};

const findFirstUserMessage = (messages) => {
  for (let index = 0; index < messages.length; index += 1) {
    const entry = messages[index];
    if (isUserMessageEntry(entry)) {
      return { entry, index };
    }
  }
  return null;
};

const findLatestUserMessage = (messages) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (isUserMessageEntry(entry)) {
      return { entry, index };
    }
  }
  return null;
};

const markCompactionInjectionSkip = (compactionInjectionSkips, sessionID, now = Date.now()) => {
  if (!compactionInjectionSkips || !sessionID) return;
  compactionInjectionSkips.set(String(sessionID), now + COMPACTION_INJECTION_SKIP_TTL_MS);
};

const consumeCompactionInjectionSkip = (compactionInjectionSkips, sessionID, now = Date.now()) => {
  if (!compactionInjectionSkips || !sessionID) return false;
  const key = String(sessionID);
  const expiresAt = compactionInjectionSkips.get(key);
  if (!expiresAt) return false;
  compactionInjectionSkips.delete(key);
  return now <= expiresAt;
};

// OpenCode does not guarantee that synthetic message parts survive into the
// next transform call. Cache each message's injected block by message ID and
// re-append the exact same bytes on later turns: older prompts stay stable for
// provider prefix caching while only the newest user message triggers a fresh
// pack build. The replay cache only activates when OpenCode provides both a
// session ID and a real message ID; unidentified messages still receive current
// turn context, but are not cached because positional fallbacks can drift across
// turns or sessions. Do not "simplify" this into recomputing previous turns.
const getSessionMessageInjectionCache = (messageInjectionCache, sessionID) => {
  if (!sessionID) {
    return null;
  }
  const cacheKey = sessionID;
  let sessionCache = messageInjectionCache.get(cacheKey);
  if (sessionCache) {
    // Refresh recency so the bounded cache behaves like a small LRU.
    messageInjectionCache.delete(cacheKey);
  } else {
    sessionCache = new Map();
  }
  messageInjectionCache.set(cacheKey, sessionCache);
  while (messageInjectionCache.size > MAX_MESSAGE_INJECTION_CACHE_SESSIONS) {
    const oldestKey = messageInjectionCache.keys().next().value;
    if (!oldestKey) break;
    messageInjectionCache.delete(oldestKey);
  }
  return sessionCache;
};

const trimSessionMessageInjectionCache = (sessionCache) => {
  if (!sessionCache) return;
  while (sessionCache.size > MAX_MESSAGE_INJECTION_CACHE_MESSAGES) {
    const oldestKey = sessionCache.keys().next().value;
    if (!oldestKey) break;
    sessionCache.delete(oldestKey);
  }
};

const normalizeInjectedMessageParts = (messages, sessionCache) => {
  for (let index = 0; index < messages.length; index += 1) {
    const entry = messages[index];
    if (!isUserMessageEntry(entry) || !Array.isArray(entry.parts)) {
      continue;
    }

    const messageId = resolveEntryMessageId(entry);
    const retainedParts = [];
    let existingText = null;
    for (const part of entry.parts) {
      if (isCodememContextPart(part)) {
        const text = String(part?.text || "");
        if (text.trim()) {
          existingText = text;
        }
      } else {
        retainedParts.push(part);
      }
    }
    if (existingText && sessionCache && messageId && !sessionCache.has(messageId)) {
      sessionCache.set(messageId, { text: existingText, attemptId: null, reconstructed: true });
      trimSessionMessageInjectionCache(sessionCache);
    }
    if (retainedParts.length !== entry.parts.length) {
      entry.parts.splice(0, entry.parts.length, ...retainedParts);
    }
  }
};

const buildInjectedContextPart = (entry, index, text, options = {}) => {
  const messageId = options.messageId || fallbackEntryMessageId(entry, index);
  const sessionID = options.sessionID || resolveEntrySessionID(entry) || "unknown";
  return {
    id: `${CODEMEM_CONTEXT_PART_ID_PREFIX}${messageId}`,
    sessionID,
    messageID: messageId,
    type: "text",
    text,
    synthetic: true,
  };
};

const appendCachedInjectedContextParts = async (
  messages,
  sessionCache,
  sessionID = null,
  options = {},
) => {
  let appended = 0;
  for (let index = 0; index < messages.length; index += 1) {
    const entry = messages[index];
    if (!isUserMessageEntry(entry) || !Array.isArray(entry.parts)) {
      continue;
    }
    const messageId = resolveEntryMessageId(entry);
    if (!messageId) {
      continue;
    }
    const cached = sessionCache.get(messageId);
    const text = typeof cached === "string" ? cached : cached?.text;
    if (!text) {
      continue;
    }
    let attemptId = cached?.attemptId || null;
    let cacheReuseReady = null;
    if (
      messageId === options.latestMessageId
      && !options.latestWasBuilt
      && attemptId
      && options.recordCacheReuse
    ) {
      const reuse = options.recordCacheReuse(cached, {
        messageId,
        sessionID,
      });
      attemptId = typeof reuse === "string" ? reuse : reuse?.attemptId || null;
      cacheReuseReady = typeof reuse === "object" ? reuse?.ready : null;
    }
    try {
      entry.parts.push(buildInjectedContextPart(entry, index, text, { messageId, sessionID }));
    } catch (error) {
      if (messageId === options.latestMessageId && attemptId && options.confirmDelivery) {
        if (cacheReuseReady) {
          void Promise.resolve(cacheReuseReady)
            .then(() => options.confirmDelivery(attemptId, "failed"))
            .catch(() => {});
        } else {
          options.confirmDelivery(attemptId, "failed");
        }
      }
      throw error;
    }
    if (messageId === options.latestMessageId && attemptId && options.confirmDelivery) {
      if (cacheReuseReady) {
        void Promise.resolve(cacheReuseReady)
          .then(() => options.confirmDelivery(attemptId))
          .catch(() => {});
      } else {
        options.confirmDelivery(attemptId);
      }
    }
    appended += 1;
  }
  return appended;
};

const applyInjectedContextToMessages = async ({
  injectEnabled,
  input,
  output,
  injectionToastShown,
  showToast,
  resolveInjectQuery,
  buildInjectedContext,
  messageInjectionCache,
  compactionInjectionSkips,
  confirmDelivery,
  recordCacheReuse,
  recordSkipped,
}) => {
  const hasMessages = Array.isArray(output?.messages);
  const latestUser = hasMessages ? findLatestUserMessage(output.messages) : null;
  const sessionID = latestUser
    ? resolveEntrySessionID(latestUser.entry) || input?.sessionID || null
    : input?.sessionID || null;
  if (!injectEnabled) {
    recordSkipped?.("injection_disabled", sessionID);
    return false;
  }
  if (!hasMessages) {
    return false;
  }

  if (consumeCompactionInjectionSkip(compactionInjectionSkips, sessionID)) {
    normalizeInjectedMessageParts(output.messages, null);
    recordSkipped?.("compaction_skipped", sessionID);
    return false;
  }

  if (!latestUser) {
    return false;
  }

  const sessionCache = getSessionMessageInjectionCache(messageInjectionCache, sessionID);
  normalizeInjectedMessageParts(output.messages, sessionCache);

  const latestMessageId = resolveEntryMessageId(latestUser.entry);
  const canReplay = Boolean(sessionCache && latestMessageId);
  const latestCached = canReplay ? sessionCache.get(latestMessageId) : null;
  const latestWasCached = Boolean(latestCached) && latestCached?.reconstructed !== true;
  let latestWasBuilt = false;
  if (!latestWasCached) {
    const firstUser = findFirstUserMessage(output.messages);
    const query = resolveInjectQuery({
      firstPrompt: firstUser ? extractMessageText(firstUser.entry) : null,
      lastPromptText: extractMessageText(latestUser.entry),
    });
    const injected = await buildInjectedContext(query, {
      sessionID,
      requestKey: latestMessageId || fallbackEntryMessageId(latestUser.entry, latestUser.index),
      surface: "message",
    });
    if (injected?.text) {
      latestWasBuilt = true;
      if (canReplay) {
        sessionCache.set(latestMessageId, {
          text: injected.text,
          attemptId: injected.attemptId || null,
          requestId: injected.requestId || null,
          queryHash: injected.queryHash || null,
          promptNumber: injected.promptNumber || 0,
          reuseCount: 0,
        });
        trimSessionMessageInjectionCache(sessionCache);
      } else if (Array.isArray(latestUser.entry.parts)) {
        try {
          latestUser.entry.parts.push(
            buildInjectedContextPart(latestUser.entry, latestUser.index, injected.text, {
              messageId: latestMessageId || undefined,
              sessionID: sessionID || undefined,
            })
          );
        } catch (error) {
          if (injected.attemptId) {
            confirmDelivery?.(injected.attemptId, "failed");
          }
          throw error;
        }
        if (injected.attemptId) {
          confirmDelivery?.(injected.attemptId);
        }
      }

      const toastKey = sessionID || latestMessageId || "unknown";
      if (!injectionToastShown.has(toastKey) && showToast) {
        injectionToastShown.add(toastKey);
        try {
          await showToast(buildInjectionToastMessage(injected.metrics));
        } catch {
          // best-effort only
        }
      }
    } else if (canReplay && latestCached?.reconstructed === true) {
      sessionCache.delete(latestMessageId);
    }
  }

  if (!canReplay) {
    return Boolean(
      Array.isArray(latestUser.entry.parts)
      && latestUser.entry.parts.some(isCodememContextPart)
    );
  }

  const appended = await appendCachedInjectedContextParts(output.messages, sessionCache, sessionID, {
    latestMessageId,
    latestWasBuilt,
    confirmDelivery,
    recordCacheReuse,
  });
  return appended > 0;
};

const mapOpencodeEventTypeToAdapterType = (eventType) => {
  if (eventType === "user_prompt") {
    return "prompt";
  }
  if (eventType === "assistant_message") {
    return "assistant";
  }
  if (eventType === "tool.execute.after") {
    return "tool_result";
  }
  return null;
};

const buildOpencodeAdapterPayload = (event) => {
  const eventType = event?.type;
  if (eventType === "user_prompt") {
    const text = String(event?.prompt_text || "").trim();
    if (!text) {
      return null;
    }
    return {
      text,
      prompt_number:
        typeof event?.prompt_number === "number" ? event.prompt_number : null,
    };
  }

  if (eventType === "assistant_message") {
    const text = String(event?.assistant_text || "").trim();
    if (!text) {
      return null;
    }
    return { text };
  }

  if (eventType === "tool.execute.after") {
    const toolName = String(event?.tool || "unknown");
    return {
      tool_name: toolName,
      status: event?.error ? "error" : "ok",
      tool_input: event?.args || {},
      tool_output: event?.result ?? null,
      error: event?.error ?? null,
    };
  }

  return null;
};

const stableStringify = (value) => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
};

const stableDigest = (value) =>
  createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 20);

const sanitizeIdPart = (value, fallback, maxChars) => {
  const normalized = String(value || "")
    .replace(/[^A-Za-z0-9._:-]/g, "_")
    .slice(0, maxChars);
  return normalized || fallback;
};

const buildAdapterEventId = ({ sessionID, eventType, event, payload, ts }) => {
  const safeSessionID = sanitizeIdPart(sessionID, "unknown", 48);
  const safeType = sanitizeIdPart(eventType, "event", 24);
  const rawTimestamp =
    typeof event?.timestamp === "string" && event.timestamp.trim()
      ? event.timestamp.trim()
      : ts;
  const digest = stableDigest({
    session_id: String(sessionID || ""),
    event_type: String(eventType || ""),
    raw_event_type: String(event?.type || ""),
    timestamp: rawTimestamp,
    payload,
  });
  return `oc:${safeSessionID}:${safeType}:${digest}`.slice(0, 128);
};

const buildOpencodeAdapterEvent = ({ sessionID, event }) => {
  if (!sessionID || !event || typeof event !== "object") {
    return null;
  }
  const adapterType = mapOpencodeEventTypeToAdapterType(event.type);
  if (!adapterType) {
    return null;
  }
  const payload = buildOpencodeAdapterPayload(event);
  if (!payload) {
    return null;
  }
  const ts = typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();
  return {
    schema_version: "1.0",
    source: "opencode",
    session_id: String(sessionID),
    event_id: buildAdapterEventId({
      sessionID,
      eventType: adapterType,
      event,
      payload,
      ts,
    }),
    event_type: adapterType,
    ts,
    ordering_confidence: "low",
    payload,
    meta: {
      original_event_type: String(event.type || "unknown"),
    },
  };
};

const normalizeProjectLabel = (value) => {
  if (typeof value !== "string") {
    return null;
  }
  const cleaned = value.trim();
  if (!cleaned) {
    return null;
  }
  if (cleaned.includes("/") || cleaned.includes("\\")) {
    const normalized = cleaned.replaceAll("\\", "/").replace(/\/+$/, "");
    return basename(normalized) || null;
  }
  return cleaned;
};

const inferredProjectByCwd = new Map();

const inferProjectFromCwd = (cwd) => {
  if (typeof cwd !== "string") {
    return null;
  }
  const cleaned = cwd.trim();
  if (!cleaned) {
    return null;
  }
  if (inferredProjectByCwd.has(cleaned)) {
    return inferredProjectByCwd.get(cleaned);
  }

  let current = cleaned;
  while (true) {
    const gitPath = `${current}/.git`;
    if (existsSync(gitPath)) {
      try {
        const text = readFileSync(gitPath, "utf8").trim();
        if (text.startsWith("gitdir:")) {
          const normalized = resolve(current, text.slice("gitdir:".length).trim()).replaceAll(
            "\\",
            "/",
          );
          const worktreeMarker = "/.git/worktrees/";
          const worktreeIndex = normalized.indexOf(worktreeMarker);
          if (worktreeIndex >= 0) {
            const inferred = normalizeProjectLabel(normalized.slice(0, worktreeIndex));
            inferredProjectByCwd.set(cleaned, inferred);
            return inferred;
          }
        }
      } catch {
        // .git is a directory in normal repos; fall through to cwd basename.
      }
      const inferred = normalizeProjectLabel(current);
      inferredProjectByCwd.set(cleaned, inferred);
      return inferred;
    }
    const parent = dirname(current);
    if (parent === current) {
      const inferred = normalizeProjectLabel(cleaned);
      inferredProjectByCwd.set(cleaned, inferred);
      return inferred;
    }
    current = parent;
  }
};

const resolveProjectName = (project, cwd) =>
  normalizeProjectLabel(process.env.CODEMEM_PROJECT) ||
  normalizeProjectLabel(project?.name) ||
  normalizeProjectLabel(project?.root) ||
  inferProjectFromCwd(cwd) ||
  null;

const selectRawEventId = ({ payload, nextEventId }) => {
  const fromPayload =
    payload &&
    typeof payload === "object" &&
    payload._raw_event_id;
  return String(fromPayload || nextEventId());
};

const buildRawEventEnvelope = ({
  sessionID,
  type,
  payload,
  cwd,
  project,
  startedAt,
  nowMs,
  nowMono,
  nextEventId,
}) => ({
  session_stream_id: sessionID,
  session_id: sessionID,
  opencode_session_id: sessionID,
  event_id: selectRawEventId({ payload, nextEventId }),
  event_type: type,
  ts_wall_ms: nowMs,
  ts_mono_ms: nowMono,
  payload,
  cwd,
  project,
  started_at: startedAt,
});

const trimEventQueue = ({ events, maxEvents, hardMaxEvents, onUnsentPressure, onForcedDrop }) => {
  if (!Number.isFinite(maxEvents) || maxEvents <= 0) {
    return;
  }
  while (events.length > maxEvents) {
    const droppableIndex = events.findIndex(
      (queued) => queued && typeof queued === "object" && queued._raw_enqueued
    );
    if (droppableIndex >= 0) {
      events.splice(droppableIndex, 1);
      continue;
    }
    if (typeof onUnsentPressure === "function") {
      onUnsentPressure(events.length, maxEvents);
    }
    if (
      Number.isFinite(hardMaxEvents) &&
      hardMaxEvents > 0 &&
      events.length > hardMaxEvents
    ) {
      const dropped = events.shift();
      if (typeof onForcedDrop === "function") {
        onForcedDrop(dropped, events.length, hardMaxEvents);
      }
      continue;
    }
    break;
  }
};

const attachAdapterEvent = ({ sessionID, event }) => {
  if (!event || typeof event !== "object") {
    return event;
  }
  let adapterEvent = null;
  try {
    adapterEvent = buildOpencodeAdapterEvent({ sessionID, event });
  } catch (err) {
    return event;
  }
  if (!adapterEvent) {
    return event;
  }
  return {
    ...event,
    _adapter: adapterEvent,
  };
};

const asNonNegativeCount = (value) => {
  if (Array.isArray(value)) {
    return value.length;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  return null;
};

const asFiniteNonNegativeInt = (value) => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value < 0) {
    return null;
  }
  return Math.trunc(value);
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
};

export const buildInjectionToastMessage = (metrics) => {
  const items = asFiniteNonNegativeInt(metrics?.items) ?? asFiniteNonNegativeInt(metrics?.total_items);
  const packTokens = asFiniteNonNegativeInt(metrics?.pack_tokens);
  const avoided = asFiniteNonNegativeInt(metrics?.avoided_work_tokens);
  const avoidedUnknown = asNonNegativeCount(metrics?.avoided_work_unknown_items);
  const avoidedKnown = asNonNegativeCount(metrics?.avoided_work_known_items);
  const addedCount = asNonNegativeCount(metrics?.added_ids);
  const removedCount = asNonNegativeCount(metrics?.removed_ids);
  const deltaAvailable = metrics?.pack_delta_available === true;

  const messageParts = ["codemem injected"];
  if (items !== null) messageParts.push(`${items} items`);
  if (packTokens !== null) messageParts.push(`~${packTokens} tokens`);
  if (
    avoided !== null
    && avoided > 0
    && avoidedKnown !== null
    && avoidedUnknown !== null
    && avoidedKnown >= avoidedUnknown
  ) {
    messageParts.push(`avoided work ~${avoided} tokens`);
  }
  if (deltaAvailable && (addedCount !== null || removedCount !== null)) {
    messageParts.push(`delta +${addedCount || 0}/-${removedCount || 0}`);
  }
  return messageParts.join(" · ");
};

const detectRunner = ({ cwd, envRunner }) => {
  if (envRunner) {
    return envRunner;
  }
  // Prefer the TS codemem if installed globally, fall back to npx
  try {
    const versionOutput = execSync("codemem --version", {
      encoding: "utf-8",
      timeout: 3000,
      // Suppress shell "not found" noise when codemem is not on PATH; the
      // catch below falls back to npx. Without this, stderr leaks to the
      // terminal on every OpenCode startup for npx-only installs.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    // Accept any global codemem at or above the pinned backend version, so a
    // newer global install is used instead of silently downgrading to
    // `npx codemem@<pin>` (the old check only matched the exact pin or the
    // long-obsolete 0.2x series).
    // Accept a global codemem only when it is the EXACT pinned version, or a
    // clean (non-prerelease) release at least as new as the pin. isVersionAtLeast
    // ignores prerelease suffixes, so without this a prerelease like
    // "0.36.1-alpha.0" would wrongly compare >= the "0.36.1" release even though
    // SemVer orders it below. Requiring an exact match for prereleases also
    // handles a prerelease PIN correctly (the release script can set one): only
    // the identical prerelease is trusted, never an older/different one.
    const isPrerelease = versionOutput.includes("-");
    const matchesOrCleanNewer =
      versionOutput === PINNED_BACKEND_VERSION ||
      (!isPrerelease && isVersionAtLeast(versionOutput, PINNED_BACKEND_VERSION));
    if (matchesOrCleanNewer) {
      return "codemem";
    }
  } catch {
    // not on PATH or timed out
  }
  return "npx";
};

/**
 * Check if the TS CLI is available at the given path.
 * Used by the "node" runner to verify the built CLI exists.
 */
const tsCliAvailable = (cliPath) => {
  try {
    return require("fs").existsSync(cliPath);
  } catch {
    return false;
  }
};

const buildRunnerArgs = ({ runner, runnerFrom, runnerFromExplicit }) => {
  if (runner === "codemem") {
    return [];
  }
  if (runner === "npx") {
    const pkg = runnerFromExplicit ? runnerFrom : `codemem@${PINNED_BACKEND_VERSION}`;
    return ["-y", pkg];
  }
  if (runner === "node") {
    const cliPath = runnerFromExplicit
      ? runnerFrom
      : join(runnerFrom, "packages/cli/dist/index.js");
    return [cliPath];
  }
  // Custom runner via CODEMEM_RUNNER env — pass through as-is
  return runnerFromExplicit ? [runnerFrom] : [];
};

export const OpencodeMemPlugin = async ({
  project,
  client,
  directory,
  worktree,
}) => {
  const events = [];
  const maxEvents = parsePositiveInt(process.env.CODEMEM_PLUGIN_MAX_EVENTS, 200);
  const maxChars = Number.parseInt(
    process.env.CODEMEM_PLUGIN_MAX_EVENT_CHARS || "8000",
    10
  );
  const cwd = worktree || directory || process.cwd();
  const debug = envHasValue(process.env.CODEMEM_PLUGIN_DEBUG, TRUTHY_VALUES);
  const debugExtraction = envHasValue(
    process.env.CODEMEM_DEBUG_EXTRACTION,
    TRUTHY_VALUES
  );
  const logTimeoutMs = Number.parseInt(
    process.env.CODEMEM_PLUGIN_LOG_TIMEOUT_MS || "1500",
    10
  );
  const logPathEnvRaw = process.env.CODEMEM_PLUGIN_LOG || "";
  const logPath = resolveLogPath(logPathEnvRaw, cwd, process.env.HOME);
  const errorLogPath = resolveErrorLogPath(cwd, process.env.HOME);
  const logLine = createLogLine(logPath);
  const errorLogLine = createLogLine(errorLogPath);
  const log = createDebugLogger({
    debug,
    client,
    logTimeoutMs,
    getLogLine: () => logLine,
    getErrorLogLine: () => errorLogLine,
  });
  const pluginIgnored = envHasValue(
    process.env.CODEMEM_PLUGIN_IGNORE,
    TRUTHY_VALUES
  );
  if (pluginIgnored) {
    return {};
  }

  const runner = detectRunner({
    cwd,
    envRunner: process.env.CODEMEM_RUNNER,
  });
  const runnerFromExplicit = Boolean(String(process.env.CODEMEM_RUNNER_FROM || "").trim());
  const runnerFrom = process.env.CODEMEM_RUNNER_FROM || cwd;
  const runnerArgs = buildRunnerArgs({ runner, runnerFrom, runnerFromExplicit });
  const viewerEnabled = envNotDisabled(process.env.CODEMEM_VIEWER || "1");
  const viewerAutoStart = envNotDisabled(
    process.env.CODEMEM_VIEWER_AUTO || "1"
  );
  const viewerAutoStop = envNotDisabled(
    process.env.CODEMEM_VIEWER_AUTO_STOP || "1"
  );
  const viewerHost = process.env.CODEMEM_VIEWER_HOST || "127.0.0.1";
  const viewerPort = process.env.CODEMEM_VIEWER_PORT || "38888";
  const viewerDbPath = process.env.CODEMEM_DB || "";
  const expandedViewerDbPath = viewerDbPath.startsWith("~/")
    ? join(process.env.HOME?.trim() || homedir(), viewerDbPath.slice(2))
    : viewerDbPath;
  const promptPackDbPath = resolve(
    cwd,
    expandedViewerDbPath || join(homedir(), ".codemem", "mem.sqlite"),
  );
  const normalizeIdentityPath = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return null;
    const expanded = trimmed.startsWith("~/")
      ? join(process.env.HOME?.trim() || homedir(), trimmed.slice(2))
      : trimmed;
    return resolve(cwd, expanded);
  };
  const promptPackIdentityTarget = {
    device_id: process.env.CODEMEM_DEVICE_ID?.trim() || null,
    actor_id_present: Object.hasOwn(process.env, "CODEMEM_ACTOR_ID"),
    actor_id: process.env.CODEMEM_ACTOR_ID?.trim() || null,
    config_path: normalizeIdentityPath(process.env.CODEMEM_CONFIG),
    runtime_root: normalizeIdentityPath(process.env.CODEMEM_RUNTIME_ROOT),
    workspace_id: process.env.CODEMEM_WORKSPACE_ID?.trim() || null,
    home_dir: normalizeIdentityPath(process.env.HOME || homedir()),
    pack_compression: process.env.CODEMEM_PACK_COMPRESSION?.trim() || null,
    embedding_disabled: ["1", "true", "yes"].includes(
      String(process.env.CODEMEM_EMBEDDING_DISABLED || "").toLowerCase(),
    ),
    embedding_model: process.env.CODEMEM_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5",
  };
  const viewerConfigPath = process.env.CODEMEM_CONFIG || "";
  // A malformed value (e.g. "abc", "", "-1") falls back to the 20s default
  // instead of NaN, which would silently disable the timeout. An explicit "0"
  // is preserved as the intentional opt-out (disable the timeout, e.g. for slow
  // first-run npx installs/backend updates) — the `commandTimeout > 0` guard at
  // the call site skips installing the timer when it is 0.
  const rawCommandTimeout = String(process.env.CODEMEM_PLUGIN_CMD_TIMEOUT ?? "").trim();
  const commandTimeout =
    rawCommandTimeout === "0" ? 0 : parsePositiveInt(rawCommandTimeout, 20000);
  const promptPackHttpTimeout =
    parsePositiveInt(process.env.CODEMEM_INJECT_HTTP_MAX_TIME_S || "2", 2) * 1000;
  const backendUpdatePolicy = parseBackendUpdatePolicy(
    process.env.CODEMEM_BACKEND_UPDATE_POLICY || "notify"
  );

  const parseNumber = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const injectEnabled = envNotDisabled(
    process.env.CODEMEM_INJECT_CONTEXT || "1"
  );
  const injectSurface = resolveInjectSurface(process.env.CODEMEM_INJECT_SURFACE);
  // Only use env overrides if explicitly set; otherwise CLI uses config defaults
  const injectLimitEnv = process.env.CODEMEM_INJECT_LIMIT;
  const injectLimit = injectLimitEnv ? parseNumber(injectLimitEnv, null) : null;
  const injectTokenBudgetEnv = process.env.CODEMEM_INJECT_TOKEN_BUDGET;
  const injectTokenBudget = injectTokenBudgetEnv ? parseNumber(injectTokenBudgetEnv, null) : null;
  const injectionToastShown = new Set();
  const messageInjectionCache = new Map();
  const compactionInjectionSkips = new Map();
  const disabledInjectionRecorded = new Set();
  const attemptStartedAt = new Map();
  const promptPackRetryCounts = new Map();
  const successfulPromptPackArtifacts = new Map();
  let sessionStartedAt = null;
  let activeSessionID = null;
  let viewerStarted = false;
  let promptCounter = 0;
  let skippedAttemptCounter = 0;
  let lastPromptText = null;
  let lastAssistantText = null;
  const assistantUsageCaptured = new Set();

  // Track message roles and accumulated text by messageID
  const messageRoles = new Map();
  const messageTexts = new Map();
  let debugLogCount = 0;

  const rawEventsEnabled = envNotDisabled(
    process.env.CODEMEM_RAW_EVENTS || "1"
  );
  const viewerUrlHost = viewerHost.includes(":") && !viewerHost.startsWith("[")
    ? `[${viewerHost}]`
    : viewerHost;
  const rawEventsUrl = `http://${viewerUrlHost}:${viewerPort}/api/raw-events`;
  const rawEventsStatusUrl = `http://${viewerUrlHost}:${viewerPort}/api/raw-events/status?limit=1`;
  const packUrl = `http://${viewerUrlHost}:${viewerPort}/api/pack`;
  const promptPackProfileUrl = `http://${viewerUrlHost}:${viewerPort}/api/prompt-pack-profile`;
  const promptPackLedgerUrl = `http://${viewerUrlHost}:${viewerPort}/api/prompt-pack-ledger`;
  const viewerHealthUrl = `http://${viewerUrlHost}:${viewerPort}/api/health`;
  const rawEventsBackoffMs = parseNumber(
    process.env.CODEMEM_RAW_EVENTS_BACKOFF_MS || "10000",
    10000
  );
  const rawEventsStatusCheckMs = parseNumber(
    process.env.CODEMEM_RAW_EVENTS_STATUS_CHECK_MS || "30000",
    30000
  );
  const rawEventsHardMax = parseNumber(
    process.env.CODEMEM_RAW_EVENTS_HARD_MAX || "2000",
    2000
  );
  let streamUnavailableUntil = 0;
  let streamErrorNoted = false;
  let fallbackFailureNoted = false;
  let lastStatusCheckAt = 0;
  let lastStatusAvailable = true;
  let promptPackTransportUnavailableUntil = 0;

  const nextEventId = () => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random()}`;
  };

  const queueRawEventViaCli = async (body) => {
    const runFallback = () => runCli(["enqueue-raw-event"], {
      stdinText: JSON.stringify(body),
    });
    let result = await runFallback();
    let classification = classifyFallbackCommandResult(result);
    let attemptedRetry = false;
    if (result?.exitCode !== 0 && classification.retryable) {
      attemptedRetry = true;
      result = await runFallback();
      classification = classifyFallbackCommandResult(result);
    }
    if (result?.exitCode !== 0) {
      const retryExhausted = attemptedRetry && classification.retryable;
      const error = new Error(
        retryExhausted ? `${classification.cause} after retry` : classification.cause
      );
      error.retryable = classification.retryable && !attemptedRetry;
      throw error;
    }
    return true;
  };

  const lastToastAtBySession = new Map();
  const shouldToast = (sessionID) => {
    const now = Date.now();
    const last = lastToastAtBySession.get(sessionID) || 0;
    if (now - last < 60000) {
      return false;
    }
    lastToastAtBySession.set(sessionID, now);
    return true;
  };

  const buildViewerCliArgs = (action) => {
    const args = ["serve", action, "--host", viewerHost, "--port", viewerPort];
    if (String(viewerDbPath || "").trim()) {
      args.push("--db-path", viewerDbPath);
    }
    if (String(viewerConfigPath || "").trim()) {
      args.push("--config", viewerConfigPath);
    }
    return args;
  };

  const emitRawEvent = async ({ sessionID, type, payload }) => {
    if (!rawEventsEnabled) {
      return true;
    }
    if (!sessionID || !type) {
      return false;
    }
    const now = Date.now();
    const body = buildRawEventEnvelope({
      sessionID,
      type,
      payload,
      cwd,
      project: resolveProjectName(project, cwd),
      startedAt: sessionStartedAt,
      nowMs: now,
      nowMono:
        typeof performance !== "undefined" && performance.now
          ? performance.now()
          : null,
      nextEventId,
    });

    if (now < streamUnavailableUntil) {
      try {
        await queueRawEventViaCli(body);
        fallbackFailureNoted = false;
        if (payload && typeof payload === "object") {
          payload._raw_enqueued = true;
        }
        return true;
      } catch (fallbackErr) {
        if (payload && typeof payload === "object") {
          payload._raw_fallback_terminal = fallbackErr?.retryable !== true;
        }
        await logLine(
          `raw_events.fallback.error sessionID=${sessionID} type=${type} err=${String(
            fallbackErr
          ).slice(0, 200)}`
        );
        if (!fallbackFailureNoted) {
          fallbackFailureNoted = true;
          try {
            await client.app.log({
              service: "codemem",
              level: "error",
              message: "codemem fallback enqueue failed during stream backoff",
              extra: {
                sessionID,
                backoffMs: rawEventsBackoffMs,
              },
            });
          } catch (logErr) {
            // best-effort logging only
          }
          if (client.tui?.showToast && shouldToast(sessionID)) {
            try {
              await client.tui.showToast({
                body: {
                  message: "codemem: fallback enqueue failed while stream is down",
                  variant: "error",
                },
              });
            } catch (toastErr) {
              // best-effort only
            }
          }
        }
        return false;
      }
    }
    try {
      if (now - lastStatusCheckAt >= Math.max(1000, rawEventsStatusCheckMs)) {
        const statusResp = await fetchRawEventsStatus(rawEventsStatusUrl);
        if (!statusResp.ok) {
          // Release the unread body before bailing into the backoff path.
          discardResponseBody(statusResp);
          throw new Error(`raw-events status failed (${statusResp.status})`);
        }
        const statusJson = await statusResp.json();
        lastStatusAvailable = statusJson?.ingest?.available !== false;
        lastStatusCheckAt = now;
      }
      if (!lastStatusAvailable) {
        throw new Error("raw-events ingest unavailable");
      }

      const postResp = await fetch(rawEventsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!postResp.ok) {
        throw new Error(`raw-events post failed (${postResp.status})`);
      }
      streamUnavailableUntil = 0;
      streamErrorNoted = false;
      fallbackFailureNoted = false;
      lastStatusAvailable = true;
      if (payload && typeof payload === "object") {
        payload._raw_enqueued = true;
      }
      return true;
    } catch (err) {
      streamUnavailableUntil = Date.now() + Math.max(1000, rawEventsBackoffMs);
      await logLine(`raw_events.error sessionID=${sessionID} type=${type} err=${String(err).slice(0, 200)}`);
      try {
        await client.app.log({
          service: "codemem",
          level: "error",
          message: "Failed to stream raw events to codemem viewer",
          extra: {
            sessionID,
            type,
            viewerHost,
            viewerPort,
            error: String(err),
          },
        });
      } catch (logErr) {
        // best-effort logging only
      }

      let fallbackOk = false;
      try {
        await queueRawEventViaCli(body);
        fallbackOk = true;
      } catch (fallbackErr) {
        if (payload && typeof payload === "object") {
          payload._raw_fallback_terminal = fallbackErr?.retryable !== true;
        }
        await logLine(
          `raw_events.fallback.error sessionID=${sessionID} type=${type} err=${String(
            fallbackErr
          ).slice(0, 200)}`
        );
      }

      if (fallbackOk) {
        fallbackFailureNoted = false;
        if (payload && typeof payload === "object") {
          payload._raw_enqueued = true;
        }
        if (!streamErrorNoted) {
          streamErrorNoted = true;
          try {
            await client.app.log({
              service: "codemem",
              level: "warn",
              message: "codemem stream unavailable; queued raw event via CLI fallback",
              extra: {
                sessionID,
                backoffMs: rawEventsBackoffMs,
              },
            });
          } catch (logErr) {
            // best-effort logging only
          }
        }
        if (client.tui?.showToast && shouldToast(sessionID)) {
          try {
            await client.tui.showToast({
              body: {
                message: "codemem: viewer stream unavailable; queue fallback active",
                variant: "warning",
              },
            });
          } catch (toastErr) {
            // best-effort only
          }
        }
        return true;
      }

      if (!streamErrorNoted) {
        streamErrorNoted = true;
        fallbackFailureNoted = true;
        try {
          await client.app.log({
            service: "codemem",
            level: "error",
            message: "codemem stream unavailable; fallback enqueue failed",
            extra: {
              sessionID,
              backoffMs: rawEventsBackoffMs,
            },
          });
        } catch (logErr) {
          // best-effort logging only
        }
      }

      if (client.tui?.showToast && shouldToast(sessionID)) {
        try {
            await client.tui.showToast({
              body: {
                message: `codemem: stream unavailable (${viewerHost}:${viewerPort}); fallback failed`,
                variant: "error",
              },
            });
        } catch (toastErr) {
          // best-effort only
        }
      }
      return false;
    }
  };

  const extractSessionID = (event) => {
    if (!event) {
      return null;
    }
    return event?.properties?.sessionID || null;
  };

  const extractHookSessionID = (input) => {
    if (!input || typeof input !== "object") {
      return null;
    }
    return (
      input.sessionID ||
      input.sessionId ||
      input.session?.id ||
      input.session?.sessionID ||
      input.properties?.sessionID ||
      null
    );
  };

  // Session context tracking for comprehensive memories
  const sessionContext = {
    firstPrompt: null,
    promptCount: 0,
    toolCount: 0,
    startTime: null,
    filesModified: new Set(),
    filesRead: new Set(),
  };

  const resetSessionContext = () => {
    sessionContext.firstPrompt = null;
    sessionContext.promptCount = 0;
    sessionContext.toolCount = 0;
    sessionContext.startTime = null;
    sessionContext.filesModified = new Set();
    sessionContext.filesRead = new Set();
  };

  // Check if we should force flush immediately (threshold-based)
  const shouldForceFlush = () => {
    const { toolCount, promptCount } = sessionContext;
    // Force flush if we've accumulated a lot of work
    if (toolCount >= 50 || promptCount >= 15) {
      return true;
    }
    // Force flush if session has been running for 10+ minutes
    if (sessionContext.startTime) {
      const sessionDurationMs = Date.now() - sessionContext.startTime;
      if (sessionDurationMs >= 600000) { // 10 minutes
        return true;
      }
    }
    return false;
  };


  const updateActivity = () => {};

  const extractPromptText = (event) => {
    if (!event) {
      return null;
    }

    // For message.updated events, track the role and check if we have buffered text
    if (event.type === "message.updated" && event.properties?.info) {
      const info = event.properties.info;
      if (info.id && info.role) {
        messageRoles.set(info.id, info.role);

        // If we have buffered text for this message and it's a user message, return it
        if (info.role === "user" && messageTexts.has(info.id)) {
          const text = messageTexts.get(info.id);
          messageTexts.delete(info.id); // Clean up
          if (debugExtraction) {
            logLine(
              `user prompt captured from buffered text id=${info.id.slice(
                -8
              )} len=${text.length}`
            );
          }
          return text;
        }
      }
      return null;
    }

    // For message.part.updated events, accumulate or return text based on known role
    if (event.type === "message.part.updated" && event.properties?.part) {
      const part = event.properties.part;
      if (part.type !== "text" || !part.text) {
        return null;
      }

      const role = messageRoles.get(part.messageID);
      if (role === "user") {
        // We know it's a user message, return the text immediately
        if (debugExtraction) {
          logLine(
            `user prompt captured immediately id=${part.messageID.slice(
              -8
            )} len=${part.text.length}`
          );
        }
        return part.text.trim() || null;
      } else if (!role) {
        // Buffer this text until we know the role
        const existing = messageTexts.get(part.messageID) || "";
        messageTexts.set(part.messageID, existing + part.text);
        if (debugExtraction) {
          logLine(
            `buffering text for unknown role id=${part.messageID.slice(
              -8
            )} len=${(existing + part.text).length}`
          );
        }
      }
    }

    return null;
  };

  const extractAssistantText = (event) => {
    if (!event) {
      return null;
    }

    // Only capture assistant messages when complete (message.updated with finish)
    if (event.type === "message.updated" && event.properties?.info) {
      const info = event.properties.info;
      if (info.id && info.role) {
        messageRoles.set(info.id, info.role);

        // Log when we see an assistant message.updated (debug only)
        if (debugExtraction && info.role === "assistant") {
          logLine(
            `assistant message.updated id=${info.id.slice(
              -8
            )} finish=${!!info.finish} hasText=${messageTexts.has(
              info.id
            )} textLen=${messageTexts.get(info.id)?.length || 0}`
          );
        }

        // Only return assistant text when message is finished
        if (
          info.role === "assistant" &&
          info.finish &&
          messageTexts.has(info.id)
        ) {
          const text = messageTexts.get(info.id);
          messageTexts.delete(info.id); // Clean up
          return text.trim() || null;
        }
      }
      return null;
    }

    // For message.part.updated, store the latest text (don't capture yet)
    // Store for ALL messages regardless of role - role might not be known yet
    if (event.type === "message.part.updated" && event.properties?.part) {
      const part = event.properties.part;
      if (part.type === "text" && part.text) {
        // Store latest text, will be captured on finish (for assistant) or on role discovery (for user)
        if (debugExtraction) {
          const prevLen = messageTexts.get(part.messageID)?.length || 0;
          logLine(
            `text part stored id=${part.messageID.slice(
              -8
            )} prevLen=${prevLen} newLen=${part.text.length} role=${
              messageRoles.get(part.messageID) || "unknown"
            }`
          );
        }
        messageTexts.set(part.messageID, part.text);
      }
    }

    return null;
  };

  const normalizeUsage = (usage) => {
    if (!usage || typeof usage !== "object") {
      return null;
    }
    const inputTokens = Number(usage.input_tokens || 0);
    const outputTokens = Number(usage.output_tokens || 0);
    const cacheCreationTokens = Number(usage.cache_creation_input_tokens || 0);
    const cacheReadTokens = Number(usage.cache_read_input_tokens || 0);
    const total = inputTokens + outputTokens + cacheCreationTokens;
    if (!Number.isFinite(total) || total <= 0) {
      return null;
    }
    return {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreationTokens,
      cache_read_input_tokens: cacheReadTokens,
    };
  };

  const extractAssistantUsage = (event) => {
    if (!event || event.type !== "message.updated" || !event.properties?.info) {
      return null;
    }
    const info = event.properties.info;
    if (!info.id || info.role !== "assistant" || !info.finish) {
      return null;
    }
    if (assistantUsageCaptured.has(info.id)) {
      return null;
    }
    const usage = normalizeUsage(
      info.usage || event.properties?.usage || event.usage
    );
    if (!usage) {
      return null;
    }
    assistantUsageCaptured.add(info.id);
    return { usage, id: info.id };
  };

  const startViewer = () => {
    if (!viewerEnabled || !viewerAutoStart || viewerStarted) {
      if (viewerStarted) logLine("viewer already started, skipping auto-start").catch(() => {});
      return;
    }
    viewerStarted = true;
    const viewerArgs = buildViewerCliArgs("start");
    const cmd = [runner, ...runnerArgs, ...viewerArgs];
    logLine(`auto-starting viewer: ${cmd.join(" ")}`).catch(() => {});
    try {
      const child = nodeSpawn(cmd[0], cmd.slice(1), {
        cwd,
        env: process.env,
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => {
        logLine(`viewer spawn error: ${err.message}`).catch(() => {});
      });
      child.unref();
    } catch (err) {
      logLine(`viewer spawn failed: ${err}`).catch(() => {});
    }
    startHealthCheck();
  };

  const runCommand = async (cmd, options = {}) => {
    const { stdinText = null } = options;
    const [command, ...args] = cmd;
    return new Promise((resolve) => {
      const proc = nodeSpawn(command, args, {
        cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      // Guard stdio access: a hard spawn failure (ENOENT) can hand back null
      // streams, and a synchronous null-deref here would reject the promise
      // that callers await for a resolved { exitCode, stdout, stderr }.
      if (proc.stdout) proc.stdout.on("data", (chunk) => { stdout += chunk; });
      if (proc.stderr) proc.stderr.on("data", (chunk) => { stderr += chunk; });
      // Absorb async stream errors (e.g. EPIPE when the child exits mid-write,
      // or a spawn failure surfacing on a pipe). Without these handlers an
      // unhandled stream "error" event would crash the host process. The
      // child-level proc.once("error") below still resolves the promise.
      for (const stream of [proc.stdin, proc.stdout, proc.stderr]) {
        if (stream && typeof stream.on === "function") stream.on("error", () => {});
      }
      if (typeof stdinText === "string") {
        try {
          proc.stdin.write(stdinText);
        } catch (stdinErr) {
          try { proc.kill(); } catch { /* ignore */ }
          resolve({ exitCode: 1, stdout: "", stderr: `stdin write failed: ${String(stdinErr)}` });
          return;
        }
      }
      try {
        proc.stdin.end();
      } catch (stdinErr) {
        try { proc.kill(); } catch { /* ignore */ }
        resolve({ exitCode: 1, stdout: "", stderr: `stdin close failed: ${String(stdinErr)}` });
        return;
      }
      let timer = null;
      if (Number.isFinite(commandTimeout) && commandTimeout > 0) {
        timer = setTimeout(() => {
          try { proc.kill(); } catch { /* ignore */ }
          resolve({ exitCode: null, stdout, stderr: "timeout" });
        }, commandTimeout);
      }
      proc.once("exit", (exitCode) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode, stdout, stderr });
      });
      proc.once("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: 1, stdout: "", stderr: String(err) });
      });
    });
  };

  const runCli = async (args, options = {}) =>
    runCommand([runner, ...runnerArgs, ...args], options);

  const postViewerJson = async ({ url, operation, payload, validate }) => {
    if (!viewerEnabled) {
      return {
        ok: false,
        classification: {
          cause: `${operation} viewer transport disabled`,
          retryable: true,
        },
      };
    }
    if (Date.now() < promptPackTransportUnavailableUntil) {
      return {
        ok: false,
        classification: {
          cause: `${operation} viewer transport in backoff`,
          retryable: true,
        },
      };
    }

    let response;
    try {
      const profileResponse = await fetch(promptPackProfileUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(promptPackHttpTimeout),
      });
      let profileBody;
      try {
        profileBody = await profileResponse.json();
      } catch {
        profileBody = null;
      }
      if (!profileResponse.ok) {
        const classification = classifyViewerHttpFailure({
          operation: `${operation} profile`,
          status: profileResponse.status,
          body: profileBody,
        });
        if (classification.retryable) {
          promptPackTransportUnavailableUntil = Date.now() + Math.max(1000, rawEventsBackoffMs);
        }
        return { ok: false, classification };
      }
      if (
        !isRecord(profileBody)
        || profileBody.service !== "codemem-viewer"
        || profileBody.protocol_version !== 1
        || profileBody.db_path !== promptPackDbPath
        || canonicalJson(profileBody.identity_target) !== canonicalJson(promptPackIdentityTarget)
      ) {
        promptPackTransportUnavailableUntil = Date.now() + Math.max(1000, rawEventsBackoffMs);
        return {
          ok: false,
          classification: {
            cause: `${operation} viewer profile handshake mismatch`,
            retryable: true,
          },
        };
      }
      response = await fetch(url, {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(promptPackHttpTimeout),
      });
    } catch (error) {
      const classification = classifyViewerHttpFailure({ operation, error });
      promptPackTransportUnavailableUntil =
        Date.now() + Math.max(1000, rawEventsBackoffMs);
      return { ok: false, classification };
    }

    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const classification = classifyViewerHttpFailure({
        operation,
        status: response.status,
        body,
      });
      if (classification.retryable) {
        promptPackTransportUnavailableUntil =
          Date.now() + Math.max(1000, rawEventsBackoffMs);
      }
      return { ok: false, classification };
    }

    if (!validate(body)) {
      const classification = classifyViewerHttpFailure({ operation, malformed: true });
      promptPackTransportUnavailableUntil =
        Date.now() + Math.max(1000, rawEventsBackoffMs);
      return { ok: false, classification };
    }

    promptPackTransportUnavailableUntil = 0;
    return { ok: true, body };
  };

  const attemptMetadata = (identity, sessionID = null, promptNumber = promptCounter) => ({
    attempt_id: identity.attemptId,
    started_at: (() => {
      const existing = attemptStartedAt.get(identity.attemptId);
      if (existing) return existing;
      const created = new Date().toISOString();
      attemptStartedAt.set(identity.attemptId, created);
      while (attemptStartedAt.size > 2000) {
        const oldest = attemptStartedAt.keys().next().value;
        if (!oldest) break;
        attemptStartedAt.delete(oldest);
      }
      return created;
    })(),
    source: "opencode",
    ...(sessionID ? { stream_id: String(sessionID), source_session_id: String(sessionID) } : {}),
    ...(promptNumber > 0 ? { prompt_number: promptNumber } : {}),
    request_id: identity.requestId,
  });

  const runPromptPackLedger = async (payload) => {
    const viewerPayload = {
      ...payload,
      db_path: promptPackDbPath,
      identity_target: promptPackIdentityTarget,
    };
    const httpResult = await postViewerJson({
      url: promptPackLedgerUrl,
      operation: "prompt-pack-ledger",
      payload: viewerPayload,
      validate: isValidLedgerHttpPayload,
    });
    if (httpResult.ok) {
      return {
        exitCode: 0,
        stdout: JSON.stringify(httpResult.body),
        stderr: "",
        transport: "viewer",
      };
    }

    const { cause, retryable } = httpResult.classification;
    await logLine(
      `inject.ledger.http_error cause=${JSON.stringify(redactLog(cause, 200))} retryable=${retryable}`
    );
    if (!retryable) {
      return { exitCode: 1, stdout: "", stderr: cause, transport: "viewer" };
    }

    try {
      const result = await runCli(["prompt-pack-ledger"], {
        stdinText: JSON.stringify(payload),
      });
      return { ...result, transport: "cli" };
    } catch {
      return null;
    }
  };

  const skippedIdentity = (failureCode, sessionID, surface, eventKey) =>
    promptPackIdentity({
      sessionID: sessionID || "unknown",
      requestKey: `${failureCode}:${eventKey}`,
      surface,
      promptNumber: promptCounter,
      queryHash: hashPromptPackQuery(""),
    });

  const recordSkippedPromptPack = (failureCode, sessionID = null, surface = injectSurface) => {
    const sessionKey = String(sessionID || "unknown");
    const memoKey = `${surface}:${sessionKey}`;
    if (failureCode === "injection_disabled" && disabledInjectionRecorded.has(memoKey)) {
      return null;
    }
    if (failureCode === "injection_disabled") disabledInjectionRecorded.add(memoKey);
    const identity = skippedIdentity(
      failureCode,
      sessionID,
      surface,
      failureCode === "injection_disabled" ? "once" : `event-${++skippedAttemptCounter}`,
    );
    void runPromptPackLedger({
      action: "record",
      ...attemptMetadata(identity, sessionID),
      retrieval_status: "skipped",
      failure_code: failureCode,
      failure_stage: "policy",
    });
    return identity.attemptId;
  };

  const recordCachedPromptPack = (cached, { messageId, sessionID } = {}) => {
    cached.reuseCount = (cached.reuseCount || 0) + 1;
    const identity = promptPackIdentity({
      sessionID: sessionID || "unknown",
      requestKey: `${messageId || "unknown"}:cache:${cached.reuseCount}`,
      surface: "message",
      promptNumber: cached.promptNumber || promptCounter,
      queryHash: cached.queryHash || hashPromptPackQuery(""),
    });
    const ready = runPromptPackLedger({
      action: "cache_reuse",
      ...attemptMetadata(identity, sessionID, cached.promptNumber || promptCounter),
      original_attempt_id: cached.attemptId,
    });
    return { attemptId: identity.attemptId, ready };
  };

  const confirmPromptPackDelivery = (attemptId, deliveryStatus = "handed_off") => {
    void runPromptPackLedger({
      action: "delivery",
      attempt_id: attemptId,
      delivery_status: deliveryStatus,
    });
  };

  const showToast = async (message, variant = "warning") => {
    if (backendUpdatePolicy === "off") {
      return;
    }
    if (!client.tui?.showToast) {
      return;
    }
    try {
      await client.tui.showToast({
        body: {
          message,
          variant,
        },
      });
    } catch (toastErr) {
      // best-effort only
    }
  };

  const restartViewerAfterAutoUpdate = async () => {
    if (!viewerEnabled || !viewerAutoStart || !viewerStarted) {
      return { attempted: false, ok: false };
    }
    const restartResult = await runCli(buildViewerCliArgs("restart"));
    if (restartResult?.exitCode === 0) {
      await logLine("compat.auto_update_viewer_restart ok");
      return { attempted: true, ok: true };
    }
    await logLine(
      `compat.auto_update_viewer_restart_failed exit=${restartResult?.exitCode ?? "unknown"} stderr=${redactLog(
        (restartResult?.stderr || "").trim()
      )}`
    );
    return { attempted: true, ok: false };
  };

  const verifyCliCompatibility = async () => {
    const minVersion = process.env.CODEMEM_MIN_VERSION || "0.9.20";
    const cacheKey = resolveCompatCheckCacheKey({
      backendUpdatePolicy,
      minVersion,
      runner,
      runnerFrom,
    });
    const cachedVersion = readCompatCheckCache(cacheKey);
    if (cachedVersion && isVersionAtLeast(cachedVersion, minVersion)) {
      await logLine(`compat.version_check_cached current=${cachedVersion} required=${minVersion}`);
      return;
    }

    const versionResult = await runCli(["version"]);
    if (!versionResult || versionResult.exitCode !== 0) {
      await logLine(
        `compat.version_check_failed exit=${versionResult?.exitCode ?? "unknown"} stderr=${
          versionResult?.stderr ? redactLog(versionResult.stderr.trim()) : ""
        }`
      );
      return;
    }

    const currentVersion = (versionResult.stdout || "").trim();
    const parsedCurrent = parseSemver(currentVersion);
    const parsedMinimum = parseSemver(minVersion);
    if (!parsedCurrent || !parsedMinimum) {
      const guidance = resolveUpgradeGuidance({ runner, runnerFrom });
      await logLine(
        `compat.version_unparsed current=${redactLog(currentVersion || "")} required=${redactLog(minVersion)}`
      );
      await log("warn", "codemem compatibility check could not parse versions", {
        currentVersion,
        minVersion,
        runner,
        runnerFromSet: Boolean(String(runnerFrom || "").trim()),
        upgradeMode: guidance.mode,
      });
      await showToast(
        `codemem compatibility check could not parse versions (cli='${currentVersion || "unknown"}', required='${minVersion}'). Suggested action: ${guidance.action}`,
        "warning"
      );
      return;
    }

    if (isVersionAtLeast(currentVersion, minVersion)) {
      writeCompatCheckCache(cacheKey, currentVersion);
      return;
    }

    clearCompatCheckCache();

    const guidance = resolveUpgradeGuidance({ runner, runnerFrom });
    const message = `codemem CLI ${currentVersion || "unknown"} is older than required ${minVersion}`;
    await log("warn", message, {
      currentVersion,
      minVersion,
      runner,
      runnerFromSet: Boolean(String(runnerFrom || "").trim()),
      upgradeMode: guidance.mode,
      upgradeAction: guidance.action,
    });
    await logLine(
      `compat.version_mismatch current=${currentVersion} required=${minVersion} mode=${guidance.mode} note=${redactLog(guidance.note)}`
    );

    const autoPlan = resolveAutoUpdatePlan({ runner, runnerFrom });
    if (backendUpdatePolicy === "auto") {
      if (autoPlan.allowed && Array.isArray(autoPlan.command) && autoPlan.command.length > 0) {
        const commandText = autoPlan.commandText || autoPlan.command.join(" ");
        await logLine(`compat.auto_update_start cmd=${redactLog(commandText)}`);
        const updateResult = await runCommand(autoPlan.command);
        await logLine(
          `compat.auto_update_result exit=${updateResult?.exitCode ?? "unknown"} stderr=${redactLog(
            (updateResult?.stderr || "").trim()
          )}`
        );

        const refreshedResult = await runCli(["version"]);
        const refreshedVersion = (refreshedResult?.stdout || "").trim();
        if (
          updateResult?.exitCode === 0
          && refreshedResult?.exitCode === 0
          && isVersionAtLeast(refreshedVersion, minVersion)
        ) {
          writeCompatCheckCache(cacheKey, refreshedVersion);
          const viewerRestart = await restartViewerAfterAutoUpdate();
          await logLine(
            `compat.auto_update_success before=${currentVersion} after=${refreshedVersion}`
          );
          await showToast(
            `Updated codemem backend from ${currentVersion || "unknown"} to ${refreshedVersion}.`,
            "success"
          );
          if (viewerRestart.attempted && !viewerRestart.ok) {
            await showToast(
              "Backend updated, but viewer restart failed. Run `codemem serve restart`.",
              "warning"
            );
          }
          return;
        }

        await showToast(
          `${message}. Auto-update did not resolve it. Suggested action: ${guidance.action}`,
          "warning"
        );
        return;
      }

      await logLine(
        `compat.auto_update_skipped reason=${autoPlan.reason || "not-eligible"}`
      );
      await showToast(
        `${message}. Auto-update skipped (${autoPlan.reason || "not eligible"}). Suggested action: ${guidance.action}`,
        "warning"
      );
      return;
    }

    await showToast(`${message}. Suggested action: ${guidance.action}`, "warning");
  };

  const resolveInjectQuery = (overrides = {}) => {
    const firstPrompt = hasOwn(overrides, "firstPrompt")
      ? overrides.firstPrompt
      : sessionContext.firstPrompt;
    const resolvedLastPromptText = hasOwn(overrides, "lastPromptText")
      ? overrides.lastPromptText
      : lastPromptText;
    return buildInjectQuery({
      firstPrompt,
      lastPromptText: resolvedLastPromptText,
      projectName: resolveProjectName(project, cwd),
      filesModified: sessionContext.filesModified,
    });
  };

  const describeInjectQuery = (query, overrides = {}) => {
    const safeQuery = redactLog((query || "").trim(), 240);
    const projectName = resolveProjectName(project, cwd) || "";
    const firstPrompt = hasOwn(overrides, "firstPrompt")
      ? overrides.firstPrompt
      : sessionContext.firstPrompt;
    const resolvedLastPromptText = hasOwn(overrides, "lastPromptText")
      ? overrides.lastPromptText
      : lastPromptText;
    return {
      safeQuery,
      firstPromptLen: firstPrompt?.trim()?.length || 0,
      lastPromptLen: resolvedLastPromptText?.trim()?.length || 0,
      projectName,
      filesModifiedCount: sessionContext.filesModified.size,
    };
  };

  const redactLog = (value, limit = 400) => {
    if (!value) return "";
    const masked = String(value).replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]");
    return masked.length > limit ? `${masked.slice(0, limit)}…` : masked;
  };

  const advancePromptPackRetryIdentity = (attemptKey) => {
    promptPackRetryCounts.set(
      attemptKey,
      (promptPackRetryCounts.get(attemptKey) || 0) + 1
    );
    while (promptPackRetryCounts.size > 2000) {
      const oldest = promptPackRetryCounts.keys().next().value;
      if (!oldest) break;
      promptPackRetryCounts.delete(oldest);
    }
  };

  const rememberSuccessfulPromptPackArtifact = (
    attemptKey,
    retryCount,
    fingerprint
  ) => {
    successfulPromptPackArtifacts.delete(attemptKey);
    successfulPromptPackArtifacts.set(attemptKey, {
      retryCount,
      fingerprint,
    });
    while (successfulPromptPackArtifacts.size > 2000) {
      const oldest = successfulPromptPackArtifacts.keys().next().value;
      if (!oldest) break;
      successfulPromptPackArtifacts.delete(oldest);
    }
  };

  const buildInjectedContext = async (query, context = {}) => {
    const queryHash = hashPromptPackQuery(query);
    const sessionID = context.sessionID || activeSessionID || "unknown";
    const surface = context.surface || injectSurface;
    const requestKey = context.requestKey || "unknown";
    const attemptKey = JSON.stringify([
      sessionID,
      requestKey,
      surface,
      promptCounter,
      queryHash,
    ]);
    let retryCount = promptPackRetryCounts.get(attemptKey) || 0;
    const resolveIdentity = () => promptPackIdentity({
      sessionID,
      requestKey: retryCount > 0
        ? `${requestKey}:empty-retry:${retryCount}`
        : requestKey,
      surface,
      promptNumber: promptCounter,
      queryHash,
    });
    let identity = resolveIdentity();
    let metadata = attemptMetadata(
      identity,
      context.sessionID || activeSessionID || null,
    );
    const runPack = async () => {
      let packArgs = buildPackArgs({
        query,
        filesModified: sessionContext.filesModified,
        injectLimit,
        injectTokenBudget,
        internalLedger: true,
      });
      const httpResult = await postViewerJson({
        url: packUrl,
        operation: "pack",
        payload: buildPackHttpBody({
          query,
          filesModified: sessionContext.filesModified,
          injectLimit,
          injectTokenBudget,
          projectName: normalizeProjectLabel(process.env.CODEMEM_PROJECT),
          cwd,
          dbPath: promptPackDbPath,
          identityTarget: promptPackIdentityTarget,
          attempt: metadata,
        }),
        validate: isValidPackHttpPayload,
      });
      if (httpResult.ok) {
        return {
          packArgs,
          result: {
            exitCode: 0,
            stdout: JSON.stringify(httpResult.body),
            stderr: "",
            transport: "viewer",
          },
        };
      }

      const { cause, retryable } = httpResult.classification;
      await logLine(
        `inject.pack.http_error cause=${JSON.stringify(redactLog(cause, 200))} retryable=${retryable}`
      );
      if (!retryable) {
        return {
          packArgs,
          result: { exitCode: 1, stdout: "", stderr: cause, transport: "viewer" },
        };
      }

      let result = await runCli(packArgs, { stdinText: JSON.stringify(metadata) });
      if (rejectsInternalLedgerFlag(result)) {
        packArgs = packArgs.filter((arg) => arg !== "--internal-ledger");
        result = await runCli(packArgs);
      }
      return { packArgs, result: { ...result, transport: "cli" } };
    };
    let { packArgs, result } = await runPack();
    let { packText, conflictPackText, metrics, itemCount, ledgerConflict } = parsePackOutput(result);
    let artifactFingerprint = packText
      ? promptPackArtifactFingerprint(result.stdout, packText)
      : "";
    let injectedIdentity = identity;
    let repairFallbackUsed = false;
    if (ledgerConflict) {
      // A restarted plugin has no artifact cache to predict this conflict. The
      // ledger marker is authoritative: never attribute delivery to the stale
      // identity, and retry once with a fresh deterministic identity.
      await log("warn", "codemem prompt-pack ledger conflict; retrying with fresh identity", {
        sessionID,
        surface,
      });
      const fallback = conflictPackText
        ? {
            packArgs,
            result,
            packText: conflictPackText,
            metrics,
            itemCount,
            artifactFingerprint: promptPackArtifactFingerprint(result.stdout, conflictPackText),
            ledgerConflict,
          }
        : null;
      advancePromptPackRetryIdentity(attemptKey);
      retryCount = promptPackRetryCounts.get(attemptKey) || 0;
      identity = resolveIdentity();
      metadata = attemptMetadata(
        identity,
        context.sessionID || activeSessionID || null,
      );
      ({ packArgs, result } = await runPack());
      // Repair-conflict bytes are never preferred over the original preserved pack.
      ({ packText, metrics, itemCount, ledgerConflict } = parsePackOutput(result));
      artifactFingerprint = packText
        ? promptPackArtifactFingerprint(result.stdout, packText)
        : "";
      const repairFailed = ledgerConflict
        || !result
        || result.exitCode !== 0
        || (!packText && itemCount !== 0);
      if (fallback && repairFailed) {
        if (ledgerConflict) {
          await log("warn", "codemem prompt-pack fresh identity also conflicted", {
            sessionID,
            surface,
          });
        } else {
          const malformedSuccess = result?.exitCode === 0;
          const exitCode = result?.exitCode ?? "unknown";
          const stderr = redactLog(result?.stderr ? result.stderr.trim() : "");
          const cmd = redactPackCommand(runner, runnerArgs, packArgs);
          await logLine(
            `inject.pack.identity_repair_failed reason=${malformedSuccess ? "malformed_success" : "command_failed"} exit=${exitCode} cmd=${cmd}` +
              `${stderr ? ` stderr=${stderr}` : ""}`
          );
          await log("warn", "codemem prompt-pack identity repair failed", {
            reason: malformedSuccess ? "malformed_success" : "command_failed",
            exitCode,
          });
          void runPromptPackLedger({
            action: "record",
            ...metadata,
            retrieval_status: "failed",
            failure_code: malformedSuccess
              ? "pack_identity_repair_failed"
              : "pack_command_failed",
            failure_stage: malformedSuccess ? "decode" : "transport",
          });
        }
        advancePromptPackRetryIdentity(attemptKey);
        retryCount = promptPackRetryCounts.get(attemptKey) || 0;
        ({
          packArgs,
          result,
          packText,
          metrics,
          itemCount,
          artifactFingerprint,
          ledgerConflict,
        } = fallback);
        // Neither persisted identity represents fallback delivery: the first
        // conflicted and the fresh repair failed. Keep the bytes fail-open but
        // leave delivery and replay attribution empty.
        injectedIdentity = null;
        repairFallbackUsed = true;
      } else {
        injectedIdentity = identity;
      }
    }
    if (packText) {
      const previous = successfulPromptPackArtifacts.get(attemptKey);
      if (
        previous?.retryCount === retryCount
        && previous.fingerprint !== artifactFingerprint
      ) {
        // The in-memory fingerprint detected a changed artifact before handoff.
        // Defensively rebuild once with a fresh identity; older CLIs do not
        // expose the persisted conflict marker used by the restart path above.
        // Keep the usable changed bytes as a fail-open fallback: diagnostics
        // identity repair must never suppress context injection.
        const fallback = {
          packArgs,
          result,
          packText,
          metrics,
          itemCount,
          artifactFingerprint,
          ledgerConflict,
        };
        advancePromptPackRetryIdentity(attemptKey);
        retryCount = promptPackRetryCounts.get(attemptKey) || 0;
        identity = resolveIdentity();
        metadata = attemptMetadata(
          identity,
          context.sessionID || activeSessionID || null,
        );
        ({ packArgs, result } = await runPack());
        ({ packText, metrics, itemCount, ledgerConflict } = parsePackOutput(result));
        artifactFingerprint = packText
          ? promptPackArtifactFingerprint(result.stdout, packText)
          : "";

        if (ledgerConflict) {
          // The repair identity is also persisted with different artifacts.
          // Preserve the marker for the fail-closed return below; never use the
          // stale changed bytes as the transport-failure fallback.
          injectedIdentity = identity;
        } else if (result?.exitCode === 0 && itemCount === 0) {
          // A fresh identity can legitimately resolve to no results if the
          // underlying memory set changed between rebuilds. The CLI already
          // recorded that terminal outcome; do not misclassify it as a decode
          // failure or fall back to stale non-empty context.
          injectedIdentity = identity;
        } else if (!result || result.exitCode !== 0 || !packText) {
          const malformedSuccess = result?.exitCode === 0;
          const exitCode = result?.exitCode ?? "unknown";
          const stderr = redactLog(result?.stderr ? result.stderr.trim() : "");
          const cmd = redactPackCommand(runner, runnerArgs, packArgs);
          await logLine(
            `inject.pack.identity_repair_failed reason=${malformedSuccess ? "malformed_success" : "command_failed"} exit=${exitCode} cmd=${cmd}` +
              `${stderr ? ` stderr=${stderr}` : ""}`
          );
          await log("warn", "codemem prompt-pack identity repair failed", {
            reason: malformedSuccess ? "malformed_success" : "command_failed",
            exitCode,
          });
          void runPromptPackLedger({
            action: "record",
            ...metadata,
            retrieval_status: "failed",
            failure_code: malformedSuccess
              ? "pack_identity_repair_failed"
              : "pack_command_failed",
            failure_stage: malformedSuccess ? "decode" : "transport",
          });
          advancePromptPackRetryIdentity(attemptKey);

          ({
            packArgs,
            result,
            packText,
            metrics,
            itemCount,
            artifactFingerprint,
            ledgerConflict,
          } = fallback);
          // The stale attempt does not represent these changed bytes, and the
          // fresh repair attempt failed. Inject without delivery attribution
          // rather than falsely marking either ledger attempt handed off.
          injectedIdentity = null;
          repairFallbackUsed = true;
        } else {
          injectedIdentity = identity;
        }
      }
    }
    if (!result || result.exitCode !== 0) {
      const exitCode = result?.exitCode ?? "unknown";
      const stderr = redactLog(result?.stderr ? result.stderr.trim() : "");
      const stdout = redactLog(result?.stdout ? result.stdout.trim() : "");
      const cmd = redactPackCommand(runner, runnerArgs, packArgs);
      await logLine(
        `inject.pack.error ${exitCode} cmd=${cmd}` +
          `${stderr ? ` stderr=${stderr}` : ""}` +
          `${stdout ? ` stdout=${stdout}` : ""}`
      );
      void runPromptPackLedger({
        action: "record",
        ...metadata,
        retrieval_status: "failed",
        failure_code: "pack_command_failed",
        failure_stage: "transport",
      });
      advancePromptPackRetryIdentity(attemptKey);
      return {
        text: "",
        attemptId: identity.attemptId,
        requestId: identity.requestId,
        queryHash,
        promptNumber: promptCounter,
      };
    }
    if (ledgerConflict && !repairFallbackUsed) {
      await log("warn", "codemem prompt-pack fresh identity also conflicted", {
        sessionID,
        surface,
      });
      advancePromptPackRetryIdentity(attemptKey);
      return {
        text: "",
        attemptId: identity.attemptId,
        requestId: identity.requestId,
        queryHash,
        promptNumber: promptCounter,
      };
    }
    if (!packText) {
      if (itemCount === 0) {
        advancePromptPackRetryIdentity(attemptKey);
      }
      if (debug) {
        const { safeQuery, firstPromptLen, lastPromptLen, projectName, filesModifiedCount } =
          describeInjectQuery(query);
        await logLine(
          `inject.pack.empty query_len=${query ? query.length : 0} query=${JSON.stringify(safeQuery)} first_prompt_len=${firstPromptLen} last_prompt_len=${lastPromptLen} project=${JSON.stringify(projectName)} files_modified=${filesModifiedCount} stdout=${JSON.stringify(redactLog((result.stdout || "").trim(), 240))}`
        );
      }
      return {
        text: "",
        attemptId: identity.attemptId,
        requestId: identity.requestId,
        queryHash,
        promptNumber: promptCounter,
      };
    }
    // The pack JSON exposes the item count as `total_items`; `metrics.items`
    // does not exist on that payload, so reading it would always log 0.
    const packTokens = Number.isFinite(Number(metrics?.pack_tokens))
      ? Number(metrics.pack_tokens)
      : 0;
    await logLine(
      `inject.pack.ok source=opencode items=${itemCount ?? 0} pack_tokens=${packTokens} query_len=${query ? query.length : 0}`
    );
    if (!repairFallbackUsed) {
      rememberSuccessfulPromptPackArtifact(
        attemptKey,
        retryCount,
        artifactFingerprint || promptPackArtifactFingerprint(result.stdout, packText)
      );
    }
    if (metrics) {
      return {
        text: `[codemem context]\n${packText}`,
        metrics,
        attemptId: injectedIdentity?.attemptId || null,
        requestId: injectedIdentity?.requestId || null,
        queryHash,
        promptNumber: promptCounter,
      };
    }
    return {
      text: `[codemem context]\n${packText}`,
      attemptId: injectedIdentity?.attemptId || null,
      requestId: injectedIdentity?.requestId || null,
      queryHash,
      promptNumber: promptCounter,
    };
  };

  const stopViewer = async () => {
    if (!viewerEnabled || !viewerAutoStop || !viewerStarted) {
      return;
    }
    viewerStarted = false;
    stopHealthCheck();
    await logLine("viewer stop requested");
    await runCli(buildViewerCliArgs("stop"));
  };

  const viewerHealthMonitor = createViewerHealthMonitor({
    viewerHealthUrl,
    legacyStatusUrl: rawEventsStatusUrl,
    isActive: () => viewerStarted && viewerEnabled,
    restartViewer: () => runCli(buildViewerCliArgs("restart")),
    logLine,
  });
  const startHealthCheck = viewerHealthMonitor.start;
  const stopHealthCheck = viewerHealthMonitor.stop;

  // Get version info (commit hash) for debugging
  let version = "unknown";
  try {
    version = execSync("git rev-parse --short HEAD", {
      cwd: runnerFrom,
      timeout: 500,
      encoding: "utf-8",
      // Suppress "fatal: not a git repository" when the working directory is
      // not a git repo. The catch below leaves version as "unknown".
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    // Ignore - version will remain 'unknown'
  }

  await log("info", "codemem plugin initialized", { cwd, version });
  await logLine(`plugin initialized cwd=${cwd} version=${version}`);
  startViewer();
  const compatCheckTimer = setTimeout(() => {
    void verifyCliCompatibility().catch(async (err) => {
      await logLine(
        `compat.version_check_error message=${String(err?.message || err || "unknown")}`
      );
    });
  }, COMPAT_CHECK_DELAY_MS);
  if (compatCheckTimer.unref) compatCheckTimer.unref();

  const truncate = (value) => {
    if (value === undefined || value === null) {
      return null;
    }
    const text = String(value);
    if (Number.isNaN(maxChars) || maxChars <= 0) {
      return "";
    }
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)}\n[codemem] event truncated\n`;
  };

  const safeStringify = (value) => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === "string") {
      return value;
    }
    try {
      return JSON.stringify(value);
    } catch (err) {
      return String(value);
    }
  };

  const recordEvent = (event) => {
    events.push(event);
    trimEventQueue({
      events,
      maxEvents,
      hardMaxEvents: Math.max(maxEvents, rawEventsHardMax),
      onUnsentPressure: (queuedCount, cap) => {
        void logLine(`queue.pressure unsent_preserved queued=${queuedCount} max_events=${cap}`);
      },
      onForcedDrop: (dropped, queuedCount, hardCap) => {
        void logLine(
          `queue.drop hard_cap event_id=${dropped?._raw_event_id || "unknown"} queued=${queuedCount} hard_max=${hardCap}`
        );
      },
    });
  };

  const captureEvent = (sessionID, event) => {
    const normalizedSessionID =
      typeof sessionID === "string" && sessionID.trim() ? sessionID.trim() : null;
    if (normalizedSessionID) {
      activeSessionID = normalizedSessionID;
    }
    const effectiveSessionID = normalizedSessionID || activeSessionID;
    const resolvedSessionID =
      effectiveSessionID || `missing:${Date.now()}:${String(nextEventId()).slice(0, 8)}`;
    if (!effectiveSessionID) {
      activeSessionID = resolvedSessionID;
      void logLine(`capture.fallback_session_id ${resolvedSessionID}`);
    }
    const adapterAnnotatedEvent = attachAdapterEvent({
      sessionID: resolvedSessionID,
      event,
    });
    const rawEventId =
      adapterAnnotatedEvent?._adapter?.event_id ||
      (adapterAnnotatedEvent && adapterAnnotatedEvent._raw_event_id) ||
      nextEventId();
    const queuedEvent = {
      ...adapterAnnotatedEvent,
      _raw_event_id: rawEventId,
      _raw_session_id: resolvedSessionID,
      _raw_retry_count: 0,
    };
    recordEvent(queuedEvent);
    void emitRawEvent({
      sessionID: resolvedSessionID,
      type: queuedEvent?.type || "unknown",
      payload: queuedEvent,
    });
  };

  const flushEvents = async () => {
    if (!events.length) {
      await logLine("flush.skip empty");
      return;
    }

    const batch = events.splice(0, events.length);
    if (!batch.length) {
      await logLine("flush.skip empty");
      return;
    }

    const failed = [];
    let droppedCount = 0;
    for (const queuedEvent of batch) {
      if (queuedEvent && typeof queuedEvent === "object" && queuedEvent._raw_enqueued) {
        continue;
      }
      if (queuedEvent && typeof queuedEvent === "object" && queuedEvent._raw_fallback_terminal) {
        droppedCount += 1;
        await logLine(
          `flush.drop terminal_fallback event_id=${queuedEvent?._raw_event_id || "unknown"}`
        );
        continue;
      }
      const queuedSessionID =
        queuedEvent?._raw_session_id ||
        queuedEvent?.properties?.sessionID ||
        null;
      const ok = await emitRawEvent({
        sessionID: queuedSessionID,
        type: queuedEvent?.type || "unknown",
        payload: queuedEvent,
      });
      if (!ok) {
        if (queuedEvent?._raw_fallback_terminal) {
          droppedCount += 1;
          await logLine(
            `flush.drop terminal_fallback event_id=${queuedEvent?._raw_event_id || "unknown"}`
          );
          continue;
        }
        const currentRetry =
          typeof queuedEvent?._raw_retry_count === "number" && Number.isFinite(queuedEvent._raw_retry_count)
            ? queuedEvent._raw_retry_count
            : 0;
        const nextRetry = currentRetry + 1;
        failed.push({
          ...queuedEvent,
          _raw_retry_count: nextRetry,
        });
      }
    }
    if (failed.length) {
      events.unshift(...failed);
      await logLine(`flush.retry_deferred count=${failed.length}`);
      return;
    }

    // Calculate session duration
    const durationMs = sessionContext.startTime
      ? Date.now() - sessionContext.startTime
      : 0;
    await logLine(
      `flush.stream_only finalize count=${batch.length} tools=${sessionContext.toolCount} prompts=${sessionContext.promptCount} duration=${Math.round(durationMs / 1000)}s`
    );
    await logLine(`flush.ok count=${batch.length - droppedCount} dropped=${droppedCount}`);
    sessionStartedAt = null;
    resetSessionContext();
  };

  return {
    "experimental.session.compacting": async (input) => {
      const sessionID = extractHookSessionID(input) || activeSessionID;
      markCompactionInjectionSkip(compactionInjectionSkips, sessionID);
      if (debug) {
        await logLine(
          `inject.compaction_skip_marked sessionID=${sessionID || "unknown"}`
        );
      }
    },
    "experimental.chat.messages.transform": async (input, output) => {
      if (injectSurface === "system") {
        return;
      }
      const latestUser = Array.isArray(output?.messages)
        ? findLatestUserMessage(output.messages)
        : null;
      const sessionID = latestUser ? resolveEntrySessionID(latestUser.entry) : input?.sessionID;
      const latestPromptText = latestUser ? extractMessageText(latestUser.entry) : "";
      if (debug) {
        const query = resolveInjectQuery({ lastPromptText: latestPromptText });
        const { safeQuery, firstPromptLen, lastPromptLen, projectName, filesModifiedCount } =
          describeInjectQuery(query, { lastPromptText: latestPromptText });
        await logLine(
          `inject.messages_transform sessionID=${sessionID || "unknown"} query_len=${
            query ? query.length : 0
          } inject_enabled=${injectEnabled} tui_toast=${Boolean(client.tui?.showToast)} query=${JSON.stringify(safeQuery)} first_prompt_len=${firstPromptLen} last_prompt_len=${lastPromptLen} project=${JSON.stringify(projectName)} files_modified=${filesModifiedCount}`
        );
      }

      let applied = false;
      try {
        applied = await applyInjectedContextToMessages({
          injectEnabled,
          input,
          output,
          injectionToastShown,
          showToast: client.tui?.showToast
            ? async (message) => {
              await client.tui.showToast({
                body: {
                  message,
                  variant: "info",
                },
              });
            }
            : null,
          resolveInjectQuery,
          buildInjectedContext,
          messageInjectionCache,
          compactionInjectionSkips,
          confirmDelivery: confirmPromptPackDelivery,
          recordCacheReuse: recordCachedPromptPack,
          recordSkipped: recordSkippedPromptPack,
        });
      } catch (err) {
        await logLine(
          `inject.messages_transform.error sessionID=${sessionID || "unknown"} message=${JSON.stringify(err instanceof Error ? err.message : String(err))}`
        );
      }
      if (debug) {
        const partsCount = Array.isArray(output?.messages)
          ? output.messages.reduce(
            (count, entry) => count + (Array.isArray(entry?.parts) ? entry.parts.length : 0),
            0
          )
          : 0;
        await logLine(
          `inject.messages_transform.result sessionID=${sessionID || "unknown"} applied=${Boolean(applied)} messages=${Array.isArray(output?.messages) ? output.messages.length : 0} parts=${partsCount}`
        );
      }
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (injectSurface !== "system") {
        return;
      }
      const hookSessionID = input?.sessionID || activeSessionID;
      if (consumeCompactionInjectionSkip(compactionInjectionSkips, hookSessionID)) {
        recordSkippedPromptPack("compaction_skipped", hookSessionID, "system");
        if (debug) {
          await logLine(
            `inject.transform.skip_compaction sessionID=${hookSessionID || "unknown"}`
          );
        }
        return;
      }
      const query = resolveInjectQuery();
      if (debug) {
        const { safeQuery, firstPromptLen, lastPromptLen, projectName, filesModifiedCount } =
          describeInjectQuery(query);
        await logLine(
          `inject.transform sessionID=${input.sessionID} query_len=${
            query ? query.length : 0
          } inject_enabled=${injectEnabled} tui_toast=${Boolean(client.tui?.showToast)} query=${JSON.stringify(safeQuery)} first_prompt_len=${firstPromptLen} last_prompt_len=${lastPromptLen} project=${JSON.stringify(projectName)} files_modified=${filesModifiedCount}`
        );
      }
      // Without the old per-session cache, every transform call rebuilds the
      // pack. Swallow rejections here so a single failed build (viewer failure,
      // CLI fallback crash, sqlite lock, or network blip)
      // can't take down the chat path.
      let applied = false;
      try {
        applied = await applyInjectedContextToOutput({
          injectEnabled,
          input,
          output,
          injectionToastShown,
          showToast: client.tui?.showToast
            ? async (message) => {
              await client.tui.showToast({
                body: {
                  message,
                  variant: "info",
                },
              });
            }
            : null,
          resolveInjectQuery,
          buildInjectedContext,
          confirmDelivery: confirmPromptPackDelivery,
          recordSkipped: recordSkippedPromptPack,
        });
      } catch (err) {
        await logLine(
          `inject.transform.error sessionID=${input.sessionID} message=${JSON.stringify(err instanceof Error ? err.message : String(err))}`
        );
      }
      if (debug) {
        await logLine(
          `inject.transform.result sessionID=${input.sessionID} applied=${Boolean(applied)} system_entries=${Array.isArray(output.system) ? output.system.length : 0}`
        );
      }
    },
    event: async ({ event }) => {
      const eventType = event?.type || "unknown";
      const sessionID = extractSessionID(event);
       
      // Always log session-related events for debugging /new
      if (eventType.startsWith("session.")) {
        await logLine(`SESSION EVENT: ${eventType}`);
      }
      
      if (debugExtraction) {
        await logLine(`event ${eventType}`);
      }

      // Debug: log event structure for message events (only when debug enabled)
      if (
        debugExtraction &&
        [
          "message.updated",
          "message.created",
          "message.appended",
          "message.part.updated",
        ].includes(eventType)
      ) {
        // Log full event structure for debugging (only first few times per event type)
        if (!global.eventLogCount) global.eventLogCount = {};
        if (!global.eventLogCount[eventType])
          global.eventLogCount[eventType] = 0;
        if (global.eventLogCount[eventType] < 2) {
          global.eventLogCount[eventType]++;
          await logLine(
            `FULL EVENT (${eventType}): ${JSON.stringify(
              event,
              null,
              2
            ).substring(0, 3000)}`
          );
        }

        await logLine(
          `event payload keys: ${Object.keys(event || {}).join(", ")}`
        );
        if (event?.properties) {
          await logLine(
            `event properties keys: ${Object.keys(event.properties).join(", ")}`
          );
          if (event.properties.role) {
            await logLine(`event role: ${event.properties.role}`);
          }
          if (event.properties.message) {
            await logLine(`event has properties.message`);
          }
          if (event.properties.info) {
            const infoKeys = Object.keys(event.properties.info);
            await logLine(`event properties.info keys: ${infoKeys.join(", ")}`);
            if (event.properties.info.role) {
              await logLine(`event info.role: ${event.properties.info.role}`);
            }
          }
        }
      }

      if (
        [
          "message.updated",
          "message.created",
          "message.appended",
          "message.part.updated",
        ].includes(eventType)
      ) {
        const promptText = extractPromptText(event);
        if (promptText) {
          // Update activity tracking
          updateActivity();

          // Track session context
          if (!sessionContext.firstPrompt) {
            sessionContext.firstPrompt = promptText;
            sessionContext.startTime = Date.now();
          }
          sessionContext.promptCount++;

          // Check for /new command and flush before session reset
          if (
            promptText.trim() === "/new" ||
            promptText.trim().startsWith("/new ")
          ) {
            await logLine("detected /new command, flushing events");
            await flushEvents();
          }

          if (promptText !== lastPromptText) {
            promptCounter += 1;
          // promptCount incremented when capturing user_prompt

            lastPromptText = promptText;
            captureEvent(sessionID, {
              type: "user_prompt",
              prompt_number: promptCounter,
              prompt_text: promptText,
              timestamp: new Date().toISOString(),
            });
            await logLine(
              `user_prompt captured #${promptCounter}: ${promptText.substring(
                0,
                50
              )}`
            );
            
            // Check if we should force flush due to threshold
            if (shouldForceFlush()) {
              await logLine(`force flush triggered: tools=${sessionContext.toolCount}, prompts=${sessionContext.promptCount}, duration=${Math.round((Date.now() - (sessionContext.startTime || Date.now())) / 1000)}s`);
              await flushEvents();
            }
          }
        }

        const assistantText = extractAssistantText(event);
        if (assistantText && assistantText !== lastAssistantText) {
          updateActivity();
          lastAssistantText = assistantText;
          captureEvent(sessionID, {
            type: "assistant_message",
            assistant_text: assistantText,
            timestamp: new Date().toISOString(),
          });
          await logLine(
            `assistant_message captured: ${assistantText.substring(0, 50)}`
          );
        }

        const assistantUsage = extractAssistantUsage(event);
        if (assistantUsage) {
          updateActivity();
          captureEvent(sessionID, {
            type: "assistant_usage",
            message_id: assistantUsage.id,
            usage: assistantUsage.usage,
            timestamp: new Date().toISOString(),
          });
          await logLine(
            `assistant_usage captured id=${assistantUsage.id.slice(-8)}`
          );
        }
      }

      // NEW ACCUMULATION STRATEGY
      // Only flush on:
      // - session.error (immediate error boundary)
      // - session.idle AFTER delay (scheduled via timeout)
      // - /new command (handled above)
      // - session.created (session boundary)
      //
      // REMOVED: session.compacted, session.compacting (too frequent)
      if (eventType === "session.error") {
        await logLine("session.error detected, flushing immediately");
        await flushEvents();
      }
      
      if (eventType === "session.idle") {
        await logLine(
          `session.idle detected, flushing immediately (tools=${sessionContext.toolCount}, prompts=${sessionContext.promptCount})`
        );
        await flushEvents();
      }

      if (eventType === "session.created") {
        if (events.length) {
          await flushEvents();
        }
        activeSessionID = sessionID || null;
        sessionStartedAt = new Date().toISOString();
        promptCounter = 0;
        skippedAttemptCounter = 0;
        disabledInjectionRecorded.delete("message:unknown");
        disabledInjectionRecorded.delete("system:unknown");
        lastPromptText = null;
        lastAssistantText = null;
        resetSessionContext();
        startViewer();
      }
      if (eventType === "session.deleted") {
        activeSessionID = null;
        if (sessionID) {
          injectionToastShown.delete(sessionID);
          messageInjectionCache.delete(sessionID);
          compactionInjectionSkips.delete(sessionID);
          disabledInjectionRecorded.delete(`message:${sessionID}`);
          disabledInjectionRecorded.delete(`system:${sessionID}`);
        }
        await stopViewer();
      }
    },
    "tool.execute.after": async (input, output) => {
      const args = output?.args ?? input?.args ?? {};
      const result = output?.result ?? output?.output ?? output?.data ?? null;
      const error = output?.error ?? null;
      const toolName = input?.tool || output?.tool || "unknown";

      // Update activity and session context
      updateActivity();
      sessionContext.toolCount++;

      // Track files from tool events
      const filePath = args.filePath || args.path;
      if (filePath) {
        const lowerTool = toolName.toLowerCase();
        if (lowerTool === "edit" || lowerTool === "write") {
          addWorkingSetPath(sessionContext.filesModified, filePath, cwd);
        } else if (lowerTool === "read") {
          addWorkingSetPath(sessionContext.filesRead, filePath, cwd);
        }
      }
      if (toolName.toLowerCase() === "apply_patch") {
        const patchPaths = extractApplyPatchPaths(args.patchText);
        for (const path of patchPaths) {
          addWorkingSetPath(sessionContext.filesModified, path, cwd);
        }
      }

      captureEvent(input?.sessionID || null, {
        type: "tool.execute.after",
        tool: toolName,
        args,
        result: truncate(safeStringify(result)),
        error: truncate(safeStringify(error)),
        timestamp: new Date().toISOString(),
      });
      await logLine(`tool.execute.after ${toolName} queued=${events.length} tools=${sessionContext.toolCount}`);
      
      // Check if we should force flush due to threshold
      if (shouldForceFlush()) {
        await logLine(`force flush triggered: tools=${sessionContext.toolCount}, prompts=${sessionContext.promptCount}, duration=${Math.round((Date.now() - (sessionContext.startTime || Date.now())) / 1000)}s`);
        await flushEvents();
      }
    },
    tool: {
      "mem-status": tool({
        description: "Show codemem stats and recent entries",
        args: {},
        async execute() {
          const stats = await runCli(["stats"]);
          const recent = await runCli(["recent", "--limit", "5"]);
          const lines = [
            `viewer: http://${viewerUrlHost}:${viewerPort}`,
            `log: ${logPath || "disabled"}`,
          ];
          if (stats.exitCode === 0 && stats.stdout.trim()) {
            lines.push("", "stats:", stats.stdout.trim());
          }
          if (recent.exitCode === 0 && recent.stdout.trim()) {
            lines.push("", "recent:", recent.stdout.trim());
          }
          return lines.join("\n");
        },
      }),

      "mem-recent": tool({
        description: "Show recent codemem entries",
        args: {
          limit: tool.schema.number().optional(),
        },
        async execute({ limit }) {
          // Number.isFinite accepts floats and negatives; coerce to a positive
          // integer (default 5) before forwarding to the CLI.
          const safeLimit = String(parsePositiveInt(limit, 5));
          const recent = await runCli(["recent", "--limit", safeLimit]);
          if (recent.exitCode === 0) {
            return recent.stdout.trim() || "No recent memories.";
          }
          return `Failed to fetch recent: ${recent.stderr || recent.exitCode}`;
        },
      }),

      "mem-stats": tool({
        description: "Show codemem stats",
        args: {},
        async execute() {
          const stats = await runCli(["stats"]);
          if (stats.exitCode === 0) {
            return stats.stdout.trim() || "No stats yet.";
          }
          return `Failed to fetch stats: ${stats.stderr || stats.exitCode}`;
        },
      }),
    },
  };
};

export default OpencodeMemPlugin;
export const __testUtils = {
  PINNED_BACKEND_VERSION,
  fetchRawEventsStatus,
  inferProjectFromCwd,
  normalizeProjectLabel,
  resolveProjectName,
  buildInjectQuery,
  buildPackArgs,
  deterministicUuid,
  promptPackIdentity,
  hashPromptPackQuery,
  redactPackCommand,
  rejectsInternalLedgerFlag,
  classifyFallbackCommandResult,
  classifyViewerHttpFailure,
  isValidPackHttpPayload,
  isValidLedgerHttpPayload,
  buildPackHttpBody,
  parsePackText,
  parsePackMetrics,
  resolveInjectSurface,
  applyInjectedContextToOutput,
  applyInjectedContextToMessages,
  extractMessageText,
  isCodememContextPart,
  buildRunnerArgs,
  appendWorkingSetFileArgs,
  extractApplyPatchPaths,
  normalizeWorkingSetPath,
  addWorkingSetPath,
  mapOpencodeEventTypeToAdapterType,
  buildOpencodeAdapterPayload,
  buildOpencodeAdapterEvent,
  attachAdapterEvent,
  selectRawEventId,
  buildRawEventEnvelope,
  trimEventQueue,
  parsePositiveInt,
  createViewerHealthMonitor,
};
