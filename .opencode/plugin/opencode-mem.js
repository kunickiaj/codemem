import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tool } from '@opencode-ai/plugin';

export const OpencodeMemPlugin = async ({
  project,
  client,
  directory,
  worktree,
}) => {
  const events = [];
  const maxEvents = Number.parseInt(
    process.env.OPENCODE_MEM_PLUGIN_MAX_EVENTS || '200',
    10
  );
  const maxChars = Number.parseInt(
    process.env.OPENCODE_MEM_PLUGIN_MAX_EVENT_CHARS || '8000',
    10
  );
  const cwd = worktree || directory || process.cwd();
  const debug = ['1', 'true', 'yes'].includes(
    (process.env.OPENCODE_MEM_PLUGIN_DEBUG || '').toLowerCase()
  );
  const log = async (level, message, extra = {}) => {
    if (!debug) {
      return;
    }
    await client.app.log({
      service: 'opencode-mem',
      level,
      message,
      extra,
    });
  };
  const logPathEnv = (process.env.OPENCODE_MEM_PLUGIN_LOG || '').toLowerCase();
  const logEnabled = !['0', 'false', 'off'].includes(logPathEnv);
  const logPath = logEnabled
    ? process.env.OPENCODE_MEM_PLUGIN_LOG ||
      `${process.env.HOME || cwd}/.opencode-mem/plugin.log`
    : null;
  const logLine = async (line) => {
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
  const pluginIgnored = ['1', 'true', 'yes'].includes(
    (process.env.OPENCODE_MEM_PLUGIN_IGNORE || '').toLowerCase()
  );
  if (pluginIgnored) {
    return {};
  }
  const runner = process.env.OPENCODE_MEM_RUNNER || 'uv';
  const runnerFrom = process.env.OPENCODE_MEM_RUNNER_FROM || cwd;
  const buildRunnerArgs = () => {
    if (runner === 'uvx') {
      return ['--from', runnerFrom, 'opencode-mem'];
    }
    if (runner === 'uv') {
      return ['run', '--directory', runnerFrom, 'opencode-mem'];
    }
    // For other runners (e.g., direct 'opencode-mem' binary), no extra args
    return [];
  };
  const runnerArgs = buildRunnerArgs();
  const viewerEnabled = !['0', 'false', 'off'].includes(
    (process.env.OPENCODE_MEM_VIEWER || '1').toLowerCase()
  );
  const viewerAutoStart = !['0', 'false', 'off'].includes(
    (process.env.OPENCODE_MEM_VIEWER_AUTO || '1').toLowerCase()
  );
  const viewerAutoStop = !['0', 'false', 'off'].includes(
    (process.env.OPENCODE_MEM_VIEWER_AUTO_STOP || '1').toLowerCase()
  );
  const viewerHost = process.env.OPENCODE_MEM_VIEWER_HOST || '127.0.0.1';
  const viewerPort = process.env.OPENCODE_MEM_VIEWER_PORT || '38888';
  const commandTimeout = Number.parseInt(
    process.env.OPENCODE_MEM_PLUGIN_CMD_TIMEOUT || '1500',
    10
  );
  const parseNumber = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const injectEnabled = !['0', 'false', 'off'].includes(
    (process.env.OPENCODE_MEM_INJECT_CONTEXT || '1').toLowerCase()
  );
  const injectLimit = parseNumber(process.env.OPENCODE_MEM_INJECT_LIMIT || '8', 8);
  const injectTokenBudget = parseNumber(
    process.env.OPENCODE_MEM_INJECT_TOKEN_BUDGET || '800',
    800
  );
  const injectedSessions = new Map();
  let sessionStartedAt = null;
  let viewerStarted = false;
  let promptCounter = 0;
  let lastPromptText = null;
  let lastAssistantText = null;

  const extractPromptText = (event) => {
    if (!event) {
      return null;
    }
    const message = event.message || event.payload?.message || event.content || null;
    const role = message?.role || event.role || null;
    if (role && role !== 'user') {
      return null;
    }
    if (typeof message === 'string') {
      return message.trim() || null;
    }
    const content = message?.content || event.content;
    if (typeof content === 'string') {
      return content.trim() || null;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = part?.text || part?.content;
        if (typeof text === 'string' && text.trim()) {
          return text.trim();
        }
      }
    }
    const text = message?.text || event.text;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
    return null;
  };

  const extractAssistantText = (event) => {
    if (!event) {
      return null;
    }
    const message = event.message || event.payload?.message || event.content || null;
    const role = message?.role || event.role || null;
    if (role && role !== 'assistant') {
      return null;
    }
    if (typeof message === 'string') {
      return message.trim() || null;
    }
    const content = message?.content || event.content;
    if (typeof content === 'string') {
      return content.trim() || null;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        const text = part?.text || part?.content;
        if (typeof text === 'string' && text.trim()) {
          return text.trim();
        }
      }
    }
    const text = message?.text || event.text;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }
    return null;
  };

  const startViewer = () => {
    if (!viewerEnabled || !viewerAutoStart || viewerStarted) {
      return;
    }
    viewerStarted = true;
    log('info', 'starting opencode-mem viewer', { cwd });
    Bun.spawn({
      cmd: [runner, ...runnerArgs, 'serve', '--background'],
      cwd,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
  };

  const runCli = async (args) => {
    const proc = Bun.spawn({
      cmd: [runner, ...runnerArgs, ...args],
      cwd,
      env: process.env,
      stdout: 'pipe',
      stderr: 'pipe',
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
        resolve({ exitCode: null, stdout: '', stderr: 'timeout' });
      }, commandTimeout);
    });
    const result = await Promise.race([resultPromise, timeoutPromise]);
    if (timer) {
      clearTimeout(timer);
    }
    return result;
  };

  const resolveInjectQuery = () => {
    if (lastPromptText && lastPromptText.trim()) {
      return lastPromptText.trim();
    }
    return 'recent work';
  };

  const buildPackArgs = (query) => {
    const args = ['pack', query, '--limit', String(injectLimit)];
    if (Number.isFinite(injectTokenBudget) && injectTokenBudget > 0) {
      args.push('--token-budget', String(injectTokenBudget));
    }
    const projectRoot = project?.root || project?.name;
    if (projectRoot) {
      args.push('--project', projectRoot);
    }
    return args;
  };

  const parsePackText = (stdout) => {
    if (!stdout || !stdout.trim()) {
      return '';
    }
    try {
      const payload = JSON.parse(stdout);
      return (payload?.pack_text || '').trim();
    } catch (err) {
      return '';
    }
  };

  const buildInjectedContext = async (query) => {
    const result = await runCli(buildPackArgs(query));
    if (!result || result.exitCode !== 0) {
      await logLine(`inject.pack.error ${result?.exitCode ?? 'unknown'}`);
      return '';
    }
    const packText = parsePackText(result.stdout);
    if (!packText) {
      return '';
    }
    return `[opencode-mem context]\n${packText}`;
  };

  const stopViewer = async () => {
    if (!viewerEnabled || !viewerAutoStop || !viewerStarted) {
      return;
    }
    viewerStarted = false;
    await logLine('viewer stop requested');
    await runCli(['serve', '--stop']);
  };

  await log('info', 'opencode-mem plugin initialized', { cwd });
  await logLine(`plugin initialized cwd=${cwd}`);

  const truncate = (value) => {
    if (value === undefined || value === null) {
      return null;
    }
    const text = String(value);
    if (Number.isNaN(maxChars) || maxChars <= 0) {
      return '';
    }
    if (text.length <= maxChars) {
      return text;
    }
    return `${text.slice(0, maxChars)}\n[opencode-mem] event truncated\n`;
  };

  const safeStringify = (value) => {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value === 'string') {
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

  const flushEvents = async () => {
    if (!events.length) {
      await logLine('flush.skip empty');
      return;
    }
    const payload = {
      cwd,
      project: project?.root || project?.name || null,
      started_at: sessionStartedAt || new Date().toISOString(),
      events: [...events],
    };
    await logLine(`flush.start count=${events.length}`);
    const input = JSON.stringify(payload);
    const proc = Bun.spawn({
      cmd: [runner, ...runnerArgs, 'ingest'],
      cwd,
      env: process.env,
      stdin: new Blob([input]),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (exitCode !== 0) {
      await logLine(`flush.error exitCode=${exitCode} stderr=${stderr}`);
      await client.app.log({
        service: 'opencode-mem',
        level: 'error',
        message: 'Failed to ingest opencode-mem plugin events',
        extra: { exitCode, stdout, stderr },
      });
      return;
    }
    await logLine(`flush.ok count=${events.length}`);
    events.length = 0;
    sessionStartedAt = null;
  };

  return {
    'experimental.chat.system.transform': async (input, output) => {
      if (!injectEnabled) {
        return;
      }
      const query = resolveInjectQuery();
      const cached = injectedSessions.get(input.sessionID);
      let contextText = cached?.text || '';
      if (!contextText || cached?.query !== query) {
        const injected = await buildInjectedContext(query);
        if (injected) {
          injectedSessions.set(input.sessionID, { query, text: injected });
          contextText = injected;
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
      const eventType = event?.type || 'unknown';
      await logLine(`event ${eventType}`);
      if (
        ['message.updated', 'message.created', 'message.appended'].includes(
          eventType
        )
      ) {
        const promptText = extractPromptText(event);
        if (promptText && promptText !== lastPromptText) {
          promptCounter += 1;
          lastPromptText = promptText;
          events.push({
            type: 'user_prompt',
            prompt_number: promptCounter,
            prompt_text: promptText,
            timestamp: new Date().toISOString(),
          });
          await logLine(`user_prompt captured #${promptCounter}`);
        }
        const assistantText = extractAssistantText(event);
        if (assistantText && assistantText !== lastAssistantText) {
          lastAssistantText = assistantText;
          events.push({
            type: 'assistant_message',
            assistant_text: assistantText,
            timestamp: new Date().toISOString(),
          });
          await logLine('assistant_message captured');
        }
      }
      if (
        [
          'session.idle',
          'session.error',
          'session.compacted',
          'session.compacting',
          'experimental.session.compacting',
        ].includes(eventType)
      ) {
        await flushEvents();
      }
      if (eventType === 'session.created') {
        if (events.length) {
          await flushEvents();
        }
        sessionStartedAt = new Date().toISOString();
        promptCounter = 0;
        lastPromptText = null;
        lastAssistantText = null;
        startViewer();
      }
      if (eventType === 'session.deleted') {
        await stopViewer();
      }
    },
    'tool.execute.after': async (input, output) => {
      const args = output?.args ?? input?.args ?? {};
      const result = output?.result ?? output?.output ?? output?.data ?? null;
      const error = output?.error ?? null;
      const toolName = input?.tool || output?.tool || 'unknown';
      recordEvent({
        type: 'tool.execute.after',
        tool: toolName,
        args,
        result: truncate(safeStringify(result)),
        error: truncate(safeStringify(error)),
        timestamp: new Date().toISOString(),
      });
      await logLine(`tool.execute.after ${toolName} queued=${events.length}`);
    },
    tool: {
      'mem-status': tool({
        description: 'Show opencode-mem stats and recent entries',
        args: {},
        async execute() {
          const stats = await runCli(['stats']);
          const recent = await runCli(['recent', '--limit', '5']);
          const lines = [
            `viewer: http://${viewerHost}:${viewerPort}`,
            `log: ${logPath || 'disabled'}`,
          ];
          if (stats.exitCode === 0 && stats.stdout.trim()) {
            lines.push('', 'stats:', stats.stdout.trim());
          }
          if (recent.exitCode === 0 && recent.stdout.trim()) {
            lines.push('', 'recent:', recent.stdout.trim());
          }
          return lines.join('\n');
        },
      }),

      'mem-recent': tool({
        description: 'Show recent opencode-mem entries',
        args: {
          limit: tool.schema.number().optional(),
        },
        async execute({ limit }) {
          const safeLimit = Number.isFinite(limit) ? String(limit) : '5';
          const recent = await runCli(['recent', '--limit', safeLimit]);
          if (recent.exitCode === 0) {
            return recent.stdout.trim() || 'No recent memories.';
          }
          return `Failed to fetch recent: ${recent.stderr || recent.exitCode}`;
        },
      }),

      'mem-stats': tool({
        description: 'Show opencode-mem stats',
        args: {},
        async execute() {
          const stats = await runCli(['stats']);
          if (stats.exitCode === 0) {
            return stats.stdout.trim() || 'No stats yet.';
          }
          return `Failed to fetch stats: ${stats.stderr || stats.exitCode}`;
        },
      }),

    },
  };
};

export default OpencodeMemPlugin;
