import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { tool } from "@opencode-ai/plugin";

const TRUTHY_VALUES = ["1", "true", "yes"];
const ENABLE_VALUES = ["1", "true", "on"];
const DISABLED_VALUES = ["0", "false", "off"];

const normalizeEnvValue = (value) => (value || "").toLowerCase();
const envHasValue = (value, truthyValues) =>
  truthyValues.includes(normalizeEnvValue(value));
const envNotDisabled = (value) =>
  !DISABLED_VALUES.includes(normalizeEnvValue(value));

const resolveLogPath = (logPathEnvRaw, cwd, homeDir) => {
  const logPathEnv = normalizeEnvValue(logPathEnvRaw);
  const logEnabled = !!logPathEnvRaw && !DISABLED_VALUES.includes(logPathEnv);
  if (!logEnabled) {
    return null;
  }
  if (["true", "yes", "1"].includes(logPathEnv)) {
    return `${homeDir || cwd}/.codemem/plugin.log`;
  }
  return logPathEnvRaw;
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

const createDebugLogger = ({ debug, client, logTimeoutMs, getLogLine }) =>
  async (level, message, extra = {}) => {
    if (!debug) {
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

const detectRunner = ({ cwd, envRunner }) => {
  if (envRunner) {
    return envRunner;
  }
  // Check if we're in the codemem repo (dev mode)
  try {
    const pyproject = Bun.file(`${cwd}/pyproject.toml`);
    if (pyproject.size > 0) {
      const content = require("fs").readFileSync(
        `${cwd}/pyproject.toml`,
        "utf-8"
      );
      if (content.includes('name = "codemem"')) {
        return "uv";
      }
    }
  } catch (err) {
    // Not in dev mode
  }
  return "uvx";
};

export const OpencodeMemPlugin = async ({
  project,
  client,
  directory,
  worktree,
}) => {
  const events = [];
  const maxEvents = Number.parseInt(
    process.env.CODEMEM_PLUGIN_MAX_EVENTS || "200",
    10
  );
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
  const logLine = createLogLine(logPath);
  const log = createDebugLogger({
    debug,
    client,
    logTimeoutMs,
    getLogLine: () => logLine,
  });
  const pluginIgnored = envHasValue(
    process.env.CODEMEM_PLUGIN_IGNORE,
    TRUTHY_VALUES
  );
  if (pluginIgnored) {
    return {};
  }

  // Determine runner mode:
  // - If CODEMEM_RUNNER is set, use that
  // - If we're in a directory with pyproject.toml containing codemem, use "uv" (dev mode)
  // - Otherwise, use "uvx" with SSH git URL (installed mode)
  const runner = detectRunner({
    cwd,
    envRunner: process.env.CODEMEM_RUNNER,
  });
  const defaultRunnerFrom = runner === "uvx"
    ? "git+https://github.com/kunickiaj/codemem.git"
    : cwd;
  const runnerFrom = process.env.CODEMEM_RUNNER_FROM || defaultRunnerFrom;
  const buildRunnerArgs = () => {
    if (runner === "uvx") {
      return ["--from", runnerFrom, "codemem"];
    }
    if (runner === "uv") {
      return ["run", "--directory", runnerFrom, "codemem"];
    }
    // For other runners (e.g., direct 'codemem' binary), no extra args
    return [];
  };
  const runnerArgs = buildRunnerArgs();
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
  const enableCliIngest = envHasValue(
    process.env.CODEMEM_ENABLE_CLI_INGEST || "0",
    ENABLE_VALUES
  );
  const disableCliIngest = !enableCliIngest;
  const nextEventId = () => {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random()}`;
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
    if (!rawEventsEnabled || !sessionID || !type) {
      return;
    }
    try {
      const body = {
        opencode_session_id: sessionID,
        event_id: nextEventId(),
        event_type: type,
        ts_wall_ms: Date.now(),
        ts_mono_ms:
          typeof performance !== "undefined" && performance.now
            ? performance.now()
            : null,
        payload,
        cwd,
        project: project?.name || (project?.root ? String(project.root).split(/[/\\]/).filter(Boolean).pop() : null) || null,
        started_at: sessionStartedAt,
      };
      await fetch(rawEventsUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      await logLine(`raw_events.error sessionID=${sessionID} type=${type} err=${String(err).slice(0, 200)}`);
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

      if (client.tui?.showToast && shouldToast(sessionID)) {
        try {
          await client.tui.showToast({
            body: {
              message: `codemem: failed to stream events to viewer (${viewerHost}:${viewerPort})`,
              variant: "error",
            },
          });
        } catch (toastErr) {
          // best-effort only
        }
      }
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
      return;
    }
    viewerStarted = true;
    log("info", "starting codemem viewer", { cwd });
    Bun.spawn({
      cmd: [runner, ...runnerArgs, "serve", "--background"],
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
  };

  const runCli = async (args) => {
    const proc = Bun.spawn({
      cmd: [runner, ...runnerArgs, ...args],
      cwd,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const resultPromise = Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
    if (!Number.isFinite(commandTimeout) || commandTimeout <= 0) {
      return resultPromise;
    }
    let timer = null;
    const timeoutPromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill();
        } catch (err) {
          // ignore
        }
        resolve({ exitCode: null, stdout: "", stderr: "timeout" });
      }, commandTimeout);
    });
    const result = await Promise.race([resultPromise, timeoutPromise]);
    if (timer) {
      clearTimeout(timer);
    }
    return result;
  };

  const parseSemver = (value) => {
    const match = String(value || "").trim().match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const isVersionAtLeast = (currentVersion, minVersion) => {
    const current = parseSemver(currentVersion);
    const minimum = parseSemver(minVersion);
    if (!current || !minimum) return true;
    for (let i = 0; i < 3; i += 1) {
      if (current[i] > minimum[i]) return true;
      if (current[i] < minimum[i]) return false;
    }
    return true;
  };

  const verifyCliCompatibility = async () => {
    const minVersion = process.env.CODEMEM_MIN_VERSION || "0.9.20";
    const versionResult = await runCli(["--version"]);
    if (!versionResult || versionResult.exitCode !== 0) {
      await logLine(
        `compat.version_check_failed exit=${versionResult?.exitCode ?? "unknown"} stderr=${
          versionResult?.stderr ? redactLog(versionResult.stderr.trim()) : ""
        }`
      );
      return;
    }
    const currentVersion = (versionResult.stdout || "").trim();
    if (isVersionAtLeast(currentVersion, minVersion)) {
      return;
    }

    const message = `codemem CLI ${currentVersion || "unknown"} is older than required ${minVersion}`;
    await log("warn", message, { currentVersion, minVersion });
    await logLine(`compat.version_mismatch current=${currentVersion} required=${minVersion}`);
    if (client.tui?.showToast) {
      try {
        await client.tui.showToast({
          body: {
            message: `${message}. Upgrade: uv tool install --upgrade codemem`,
            variant: "warning",
          },
        });
      } catch (toastErr) {
        // best-effort only
      }
    }
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
    const projectName =
      project?.name ||
      (project?.root
        ? String(project.root).split(/[/\\]/).filter(Boolean).pop()
        : null);
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
    const args = ["pack", query];
    if (injectLimit !== null && Number.isFinite(injectLimit) && injectLimit > 0) {
      args.push("--limit", String(injectLimit));
    }
    if (injectTokenBudget !== null && Number.isFinite(injectTokenBudget) && injectTokenBudget > 0) {
      args.push("--token-budget", String(injectTokenBudget));
    }
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
    await runCli(["serve", "--stop"]);
  };

  // Get version info (commit hash) for debugging
  let version = "unknown";
  try {
    const gitProc = Bun.spawn({
      cmd: ["git", "rev-parse", "--short", "HEAD"],
      cwd: runnerFrom,
      stdout: "pipe",
      stderr: "pipe",
    });
    const gitResult = await Promise.race([
      new Response(gitProc.stdout).text(),
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 500)),
    ]);
    if (typeof gitResult === "string" && gitResult !== "timeout") {
      version = gitResult.trim();
    }
  } catch (err) {
    // Ignore - version will remain 'unknown'
  }

  await log("info", "codemem plugin initialized", { cwd, version });
  await logLine(`plugin initialized cwd=${cwd} version=${version}`);
  await verifyCliCompatibility();

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
    if (
      Number.isFinite(maxEvents) &&
      maxEvents > 0 &&
      events.length > maxEvents
    ) {
      events.splice(0, events.length - maxEvents);
    }
  };

  const captureEvent = (sessionID, event) => {
    recordEvent(event);
    void emitRawEvent({ sessionID, type: event?.type || "unknown", payload: event });
  };

  const flushEvents = async () => {
    if (!events.length) {
      await logLine("flush.skip empty");
      return;
    }

    if (disableCliIngest) {
      await logLine(`flush.skip cli_ingest_disabled count=${events.length}`);
      events.length = 0;
      sessionStartedAt = null;
      resetSessionContext();
      return;
    }

    // Calculate session duration
    const durationMs = sessionContext.startTime
      ? Date.now() - sessionContext.startTime
      : 0;

    const payload = {
      cwd,
      project: project?.name || (project?.root ? String(project.root).split(/[/\\]/).filter(Boolean).pop() : null) || null,
      started_at: sessionStartedAt || new Date().toISOString(),
      events: [...events],
      // Session context for comprehensive memories
      session_context: {
        first_prompt: sessionContext.firstPrompt,
        prompt_count: sessionContext.promptCount,
        tool_count: sessionContext.toolCount,
        duration_ms: durationMs,
        files_modified: Array.from(sessionContext.filesModified),
        files_read: Array.from(sessionContext.filesRead),
      },
    };
    await logLine(
      `flush.start count=${events.length} tools=${sessionContext.toolCount} prompts=${sessionContext.promptCount} duration=${Math.round(durationMs / 1000)}s`
    );
    const input = JSON.stringify(payload);
    const proc = Bun.spawn({
      cmd: [runner, ...runnerArgs, "ingest"],
      cwd,
      env: process.env,
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      await logLine(`flush.error exitCode=${exitCode} stderr=${stderr}`);
      await client.app.log({
        service: "codemem",
        level: "error",
        message: "Failed to ingest codemem plugin events",
        extra: { exitCode, stdout, stderr },
      });
      return;
    }
    await logLine(`flush.ok count=${events.length}`);
    events.length = 0;
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
              const items = injected.metrics?.items;
              const packTokens = injected.metrics?.pack_tokens;
              const avoided = injected.metrics?.avoided_work_tokens;
              const avoidedUnknown = injected.metrics?.avoided_work_unknown_items || 0;
              const avoidedKnown = injected.metrics?.avoided_work_known_items || 0;
              const messageParts = ["codemem injected"];
              if (typeof items === "number") messageParts.push(`${items} items`);
              if (typeof packTokens === "number") messageParts.push(`~${packTokens} tokens`);
              if (typeof avoided === "number" && avoided > 0 && avoidedKnown >= avoidedUnknown)
                messageParts.push(`avoided work ~${avoided} tokens`);
              await client.tui.showToast({
                body: {
                  message: messageParts.join(" · "),
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
        sessionStartedAt = new Date().toISOString();
        promptCounter = 0;
        lastPromptText = null;
        lastAssistantText = null;
        resetSessionContext();
        startViewer();
      }
      if (eventType === "session.deleted") {
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
