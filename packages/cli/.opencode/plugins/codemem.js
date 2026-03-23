import { appendFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
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
const PINNED_BACKEND_VERSION = "0.20.0-alpha.6";

const normalizeEnvValue = (value) => (value || "").toLowerCase();
const envHasValue = (value, truthyValues) =>
  truthyValues.includes(normalizeEnvValue(value));
const envNotDisabled = (value) =>
  !DISABLED_VALUES.includes(normalizeEnvValue(value));

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

const appendWorkingSetFileArgs = (args, workingSetFiles) => {
  if (!Array.isArray(workingSetFiles) || workingSetFiles.length === 0) {
    return args;
  }
  for (const file of workingSetFiles) {
    const normalized = String(file || "").trim();
    if (!normalized) {
      continue;
    }
    args.push("--working-set-file", normalized.slice(0, 400));
  }
  return args;
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
  const items = asFiniteNonNegativeInt(metrics?.items);
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
    const versionOutput = execSync("codemem --version", { encoding: "utf-8", timeout: 3000 }).trim();
    if (versionOutput === PINNED_BACKEND_VERSION || versionOutput.startsWith("0.2")) {
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
  const commandTimeout = Number.parseInt(
    process.env.CODEMEM_PLUGIN_CMD_TIMEOUT || "20000",
    10
  );
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
  // Only use env overrides if explicitly set; otherwise CLI uses config defaults
  const injectLimitEnv = process.env.CODEMEM_INJECT_LIMIT;
  const injectLimit = injectLimitEnv ? parseNumber(injectLimitEnv, null) : null;
  const injectTokenBudgetEnv = process.env.CODEMEM_INJECT_TOKEN_BUDGET;
  const injectTokenBudget = injectTokenBudgetEnv ? parseNumber(injectTokenBudgetEnv, null) : null;
  const injectedSessions = new Map();
  const injectionToastShown = new Set();
  let sessionStartedAt = null;
  let activeSessionID = null;
  let viewerStarted = false;
  let promptCounter = 0;
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
  const rawEventsUrl = `http://${viewerHost}:${viewerPort}/api/raw-events`;
  const rawEventsStatusUrl = `http://${viewerHost}:${viewerPort}/api/raw-events/status?limit=1`;
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
  const nextEventId = () => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random()}`;
  };

  const queueRawEventViaCli = async (body) => {
    const result = await runCli(["enqueue-raw-event"], {
      stdinText: JSON.stringify(body),
    });
    if (result?.exitCode !== 0) {
      throw new Error(
        `enqueue-raw-event failed (${result?.exitCode ?? "unknown"})`
      );
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
        const statusResp = await fetch(rawEventsStatusUrl, { method: "GET" });
        if (!statusResp.ok) {
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
    const cmd = [runner, ...runnerArgs, "serve", "start"];
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
      proc.stdout.on("data", (chunk) => { stdout += chunk; });
      proc.stderr.on("data", (chunk) => { stderr += chunk; });
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
    const restartResult = await runCli(["serve", "restart"]);
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
      return;
    }

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

  const resolveInjectQuery = () => {
    const parts = [];

    // First prompt captures session intent (most stable signal)
    if (sessionContext.firstPrompt && sessionContext.firstPrompt.trim()) {
      parts.push(sessionContext.firstPrompt.trim());
    }

    // Latest prompt adds current focus (skip if same as first, or trivial)
    if (
      lastPromptText &&
      lastPromptText.trim() &&
      lastPromptText.trim() !== (sessionContext.firstPrompt || "").trim() &&
      lastPromptText.trim().length > 5
    ) {
      parts.push(lastPromptText.trim());
    }

    // Project name for scoping
    const projectName = resolveProjectName(project, cwd);
    if (projectName) {
      parts.push(projectName);
    }

    // Recently modified files signal what area of the codebase we're in
    if (sessionContext.filesModified.size > 0) {
      const recentFiles = Array.from(sessionContext.filesModified)
        .slice(-5)
        .map((f) => f.split("/").pop())
        .join(" ");
      parts.push(recentFiles);
    }

    if (parts.length === 0) {
      return "recent work";
    }

    // Cap total length to avoid overly long CLI args
    const query = parts.join(" ");
    return query.length > 500 ? query.slice(0, 500) : query;
  };

  const buildPackArgs = (query) => {
    const workingSetFiles = Array.from(sessionContext.filesModified)
      .slice(-8)
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const args = ["pack", query];
    if (injectLimit !== null && Number.isFinite(injectLimit) && injectLimit > 0) {
      args.push("--limit", String(injectLimit));
    }
    if (injectTokenBudget !== null && Number.isFinite(injectTokenBudget) && injectTokenBudget > 0) {
      args.push("--token-budget", String(injectTokenBudget));
    }
    appendWorkingSetFileArgs(args, workingSetFiles);
    return args;
  };

  const parsePackText = (stdout) => {
    if (!stdout || !stdout.trim()) {
      return "";
    }
    try {
      const payload = JSON.parse(stdout);
      return (payload?.pack_text || "").trim();
    } catch (err) {
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
    } catch (err) {
      return null;
    }
  };

  const redactLog = (value, limit = 400) => {
    if (!value) return "";
    const masked = String(value).replace(/(Bearer\s+)[^\s]+/gi, "$1[redacted]");
    return masked.length > limit ? `${masked.slice(0, limit)}…` : masked;
  };

  const buildInjectedContext = async (query) => {
    const packArgs = buildPackArgs(query);
    const result = await runCli(packArgs);
    if (!result || result.exitCode !== 0) {
      const exitCode = result?.exitCode ?? "unknown";
      const stderr = redactLog(result?.stderr ? result.stderr.trim() : "");
      const stdout = redactLog(result?.stdout ? result.stdout.trim() : "");
      const cmd = [runner, ...runnerArgs, ...packArgs].join(" ");
      await logLine(
        `inject.pack.error ${exitCode} cmd=${cmd}` +
          `${stderr ? ` stderr=${stderr}` : ""}` +
          `${stdout ? ` stdout=${stdout}` : ""}`
      );
      return "";
    }
    const packText = parsePackText(result.stdout);
    if (!packText) {
      return "";
    }
    const metrics = parsePackMetrics(result.stdout);
    if (metrics) {
      return {
        text: `[codemem context]\n${packText}`,
        metrics,
      };
    }
    return { text: `[codemem context]\n${packText}` };
  };

  const stopViewer = async () => {
    if (!viewerEnabled || !viewerAutoStop || !viewerStarted) {
      return;
    }
    viewerStarted = false;
    await logLine("viewer stop requested");
    await runCli(["serve", "stop"]);
  };

  // Get version info (commit hash) for debugging
  let version = "unknown";
  try {
    version = execSync("git rev-parse --short HEAD", {
      cwd: runnerFrom,
      timeout: 500,
      encoding: "utf-8",
    }).trim();
  } catch (err) {
    // Ignore - version will remain 'unknown'
  }

  await log("info", "codemem plugin initialized", { cwd, version });
  await logLine(`plugin initialized cwd=${cwd} version=${version}`);
  startViewer();
  void verifyCliCompatibility().catch(async (err) => {
    await logLine(
      `compat.version_check_error message=${String(err?.message || err || "unknown")}`
    );
  });

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
    for (const queuedEvent of batch) {
      if (queuedEvent && typeof queuedEvent === "object" && queuedEvent._raw_enqueued) {
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
    await logLine(`flush.ok count=${batch.length}`);
    sessionStartedAt = null;
    resetSessionContext();
  };

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!injectEnabled) {
        return;
      }
      const query = resolveInjectQuery();
      if (debug) {
        await logLine(
          `inject.transform sessionID=${input.sessionID} query_len=${
            query ? query.length : 0
          } tui_toast=${Boolean(client.tui?.showToast)}`
        );
      }
      const cached = injectedSessions.get(input.sessionID);
      let contextText = cached?.text || "";
      if (!contextText || cached?.query !== query) {
        const injected = await buildInjectedContext(query);
        if (injected?.text) {
          injectedSessions.set(input.sessionID, {
            query,
            text: injected.text,
            metrics: injected.metrics || null,
          });
          contextText = injected.text;

            if (!injectionToastShown.has(input.sessionID) && client.tui?.showToast) {
              injectionToastShown.add(input.sessionID);
              try {
                await client.tui.showToast({
                  body: {
                    message: buildInjectionToastMessage(injected.metrics),
                    variant: "info",
                  },
                });
            } catch (toastErr) {
              // best-effort only
            }
          }
        }
      }
      if (!contextText) {
        return;
      }
      if (!Array.isArray(output.system)) {
        output.system = [];
      }
      output.system.push(contextText);
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
        lastPromptText = null;
        lastAssistantText = null;
        resetSessionContext();
        startViewer();
      }
      if (eventType === "session.deleted") {
        activeSessionID = null;
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
          sessionContext.filesModified.add(filePath);
        } else if (lowerTool === "read") {
          sessionContext.filesRead.add(filePath);
        }
      }
      if (toolName.toLowerCase() === "apply_patch") {
        const patchPaths = extractApplyPatchPaths(args.patchText);
        for (const path of patchPaths) {
          sessionContext.filesModified.add(path);
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
            `viewer: http://${viewerHost}:${viewerPort}`,
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
          const safeLimit = Number.isFinite(limit) ? String(limit) : "5";
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
  inferProjectFromCwd,
  normalizeProjectLabel,
  resolveProjectName,
  buildRunnerArgs,
  appendWorkingSetFileArgs,
  extractApplyPatchPaths,
  mapOpencodeEventTypeToAdapterType,
  buildOpencodeAdapterPayload,
  buildOpencodeAdapterEvent,
  attachAdapterEvent,
  selectRawEventId,
  buildRawEventEnvelope,
  trimEventQueue,
  parsePositiveInt,
};
