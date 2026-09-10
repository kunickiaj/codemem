import { createRuntimeHost, createRuntimeLocation } from "./host-contract.js";
import { createCodememRuntime } from "./runtime.js";

const DEFAULT_EVENT_TASK_TIMEOUT_MS = 250;
const FAILED_TOOL_ERROR = Object.freeze({
  name: "CodememToolCaptureError",
  message: "OpenCode reported a failed tool without error details",
});

const asRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const canonicalEvent = (event, overrides) => ({
  type: overrides.type,
  sessionID: overrides.sessionID,
  messageInfo: overrides.messageInfo || null,
  part: overrides.part || null,
  usage: overrides.usage || null,
  raw: event,
});

const tokenCount = (value) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

const addTokens = (left = {}, right = {}) => ({
  input: tokenCount(left.input) + tokenCount(right.input),
  output: tokenCount(left.output) + tokenCount(right.output),
  cache: {
    read: tokenCount(left.cache?.read) + tokenCount(right.cache?.read),
    write: tokenCount(left.cache?.write) + tokenCount(right.cache?.write),
  },
});

const usageKey = (sessionID, messageID) => `${sessionID}:${messageID}`;

export const createV2EventTranslator = () => {
  const usageByMessage = new Map();
  const textByMessage = new Map();

  const clearSession = (sessionID) => {
    for (const key of usageByMessage.keys()) {
      if (key.startsWith(`${sessionID}:`)) usageByMessage.delete(key);
    }
    for (const key of textByMessage.keys()) {
      if (key.startsWith(`${sessionID}:`)) textByMessage.delete(key);
    }
  };

  const translateInbox = (event, data, sessionID) => {
    if (data.item?.type !== "user") return [];
    const messageID = data.inboxID;
    const text = data.item.payload?.text;
    if (typeof messageID !== "string" || typeof text !== "string") return [];
    return [
      canonicalEvent(event, {
        type: "message.updated",
        sessionID,
        messageInfo: { id: messageID, role: "user", sessionID },
      }),
      canonicalEvent(event, {
        type: "message.part.updated",
        sessionID,
        part: { id: event.id, messageID, sessionID, type: "text", text },
      }),
    ];
  };

  const translateText = (event, data, sessionID) => {
    const messageID = data.assistantMessageID;
    if (!sessionID || typeof messageID !== "string" || typeof data.text !== "string") return [];
    const key = usageKey(sessionID, messageID);
    const text = `${textByMessage.get(key) || ""}${data.text}`;
    textByMessage.set(key, text);
    return [
      canonicalEvent(event, {
        type: "message.part.updated",
        sessionID,
        part: { id: event.id, messageID, sessionID, type: "text", text },
      }),
    ];
  };

  const translateStep = (event, data, sessionID) => {
    const messageID = data.assistantMessageID;
    if (!sessionID || typeof messageID !== "string") return [];
    const key = usageKey(sessionID, messageID);
    const tokens = addTokens(usageByMessage.get(key), asRecord(data.tokens));
    usageByMessage.set(key, tokens);
    if (data.finish === "tool-calls") return [];
    usageByMessage.delete(key);
    textByMessage.delete(key);
    return [canonicalEvent(event, {
      type: "message.updated",
      sessionID,
      messageInfo: { id: messageID, role: "assistant", sessionID, finish: true, tokens },
      usage: tokens,
    })];
  };

  const translate = (event) => {
    const data = asRecord(event?.data);
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : null;
    if (event?.type === "session.inbox.enqueued") return translateInbox(event, data, sessionID);
    if (event?.type === "session.text.ended") return translateText(event, data, sessionID);
    if (event?.type === "session.step.ended") return translateStep(event, data, sessionID);
    if (event?.type === "session.created") {
      return [canonicalEvent(event, { type: "session.created", sessionID })];
    }
    if (event?.type === "session.deleted") {
      if (sessionID) clearSession(sessionID);
      return [canonicalEvent(event, { type: "session.deleted", sessionID })];
    }
    if (event?.type === "session.execution.failed") {
      if (sessionID) clearSession(sessionID);
      return [canonicalEvent(event, { type: "session.error", sessionID })];
    }
    if (
      event?.type === "session.execution.succeeded"
      || event?.type === "session.execution.interrupted"
    ) {
      if (sessionID) clearSession(sessionID);
      return [canonicalEvent(event, { type: "session.idle", sessionID })];
    }
    return [];
  };

  return {
    clear: () => {
      usageByMessage.clear();
      textByMessage.clear();
    },
    translate,
  };
};

export const translateV2Event = (event) => createV2EventTranslator().translate(event);

export const translateV2ToolResult = (input) => {
  const failed = input?.status === "error";
  const result = asRecord(input?.result);
  let output = null;
  if (!failed) output = result.output ?? result.content ?? input?.result ?? null;
  return {
    input: {
      id: typeof input?.id === "string" ? input.id : null,
      sessionID: typeof input?.sessionID === "string" ? input.sessionID : null,
      tool: typeof input?.tool === "string" ? input.tool : "unknown",
      args: asRecord(input?.input),
    },
    output: {
      output,
      error: failed ? input.error || FAILED_TOOL_ERROR : null,
    },
  };
};

const disposeAll = async (registrations) => {
  let firstError;
  for (const registration of [...registrations].reverse()) {
    try {
      await registration.dispose();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;
};

const defaultWaitForEventTask = (eventTask, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    eventTask.then(() => finish(true), () => finish(true));
  });

const waitForRegistrationDisposal = async (registrations, waitForTask, timeoutMs) => {
  let disposalError;
  const disposalTask = disposeAll(registrations).catch((error) => {
    disposalError = error;
  });
  try {
    const completed = await waitForTask(disposalTask, timeoutMs);
    return { completed, error: disposalError };
  } catch (error) {
    return { completed: false, error };
  }
};

const waitForRuntimeDisposal = (runtime, waitForTask, timeoutMs) =>
  waitForRegistrationDisposal(
    [{ dispose: () => runtime.dispose() }],
    waitForTask,
    timeoutMs,
  );

const reportDiagnosticSafely = async (runtime, code) => {
  try {
    await runtime.reportDiagnostic?.(code);
  } catch {
    // Diagnostics must never alter host behavior.
  }
};

const reportDiagnosticWithinTimeout = async (runtime, code, waitForTask, timeoutMs) => {
  const diagnosticTask = reportDiagnosticSafely(runtime, code);
  try {
    await waitForTask(diagnosticTask, timeoutMs);
  } catch {
    // Diagnostics must never delay or alter cleanup.
  }
};

const createCaptureScheduler = () => {
  let captureTail = Promise.resolve();
  return (run) => {
    const task = captureTail.then(run);
    captureTail = task.catch(() => {});
    return task;
  };
};

const waitForCaptureOrAbort = (task, signal) => new Promise((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    signal.removeEventListener("abort", finish);
    resolve();
  };
  signal.addEventListener("abort", finish, { once: true });
  task.then(finish, finish);
  if (signal.aborted) finish();
});

const captureRuntimeTaskWithinTimeout = async ({
  runtime,
  run,
  scheduleCapture = (capture) => Promise.resolve().then(capture),
  diagnosticCode,
  timeoutMs,
  waitForCaptureTask,
  waitForDiagnosticTask,
}) => {
  let failed = false;
  const task = scheduleCapture(run).catch(() => {
    failed = true;
  });
  let completed = false;
  try {
    completed = await waitForCaptureTask(task, timeoutMs);
  } catch {
    failed = true;
  }
  if (completed && !failed) return { completed, task };
  await reportDiagnosticWithinTimeout(
    runtime,
    diagnosticCode,
    waitForDiagnosticTask,
    timeoutMs,
  );
  return { completed, task };
};

const consumeEvents = async (
  context,
  signal,
  runtime,
  translator,
  { eventTaskTimeoutMs, scheduleCapture, waitForCaptureTask, waitForDiagnosticTask },
) => {
  try {
    for await (const event of context.event.subscribe({ signal })) {
      if (signal.aborted) break;
      for (const translated of translator.translate(event)) {
        const capture = await captureRuntimeTaskWithinTimeout({
          runtime,
          run: () => runtime.handleEvent(translated),
          scheduleCapture,
          diagnosticCode: "v2_event_capture_failed",
          timeoutMs: eventTaskTimeoutMs,
          waitForCaptureTask,
          waitForDiagnosticTask,
        });
        if (!capture.completed) {
          await waitForCaptureOrAbort(capture.task, signal);
          if (signal.aborted) return;
        }
      }
    }
    if (!signal.aborted) {
      await reportDiagnosticWithinTimeout(
        runtime,
        "v2_event_stream_ended_unexpectedly",
        waitForDiagnosticTask,
        eventTaskTimeoutMs,
      );
    }
  } catch (error) {
    if (signal.aborted && error instanceof Error && error.name === "AbortError") return;
    await reportDiagnosticWithinTimeout(
      runtime,
      "v2_event_stream_failed",
      waitForDiagnosticTask,
      eventTaskTimeoutMs,
    );
  }
};

const cleanupAdapter = async ({
  abortController,
  eventTask,
  eventTaskTimeoutMs,
  registrations,
  runtime,
  translator,
  waitForDiagnosticTask,
  waitForEventTask,
  waitForRegistrationTask,
  waitForRuntimeDisposalTask,
}) => {
  runtime.deactivate?.();
  abortController.abort();
  const registrationCleanup = await waitForRegistrationDisposal(
    registrations,
    waitForRegistrationTask,
    eventTaskTimeoutMs,
  );
  let firstError = registrationCleanup.error;
  if (!registrationCleanup.completed) {
    await reportDiagnosticWithinTimeout(
      runtime,
      "v2_registration_cleanup_timeout",
      waitForDiagnosticTask,
      eventTaskTimeoutMs,
    );
  }
  let completed = false;
  try {
    completed = await waitForEventTask(eventTask, eventTaskTimeoutMs);
  } catch (error) {
    firstError ??= error;
  }
  translator.clear();
  if (!completed) {
    await reportDiagnosticWithinTimeout(
      runtime,
      "v2_event_stream_cleanup_timeout",
      waitForDiagnosticTask,
      eventTaskTimeoutMs,
    );
  }
  const runtimeCleanup = await waitForRuntimeDisposal(
    runtime,
    waitForRuntimeDisposalTask,
    eventTaskTimeoutMs,
  );
  firstError ??= runtimeCleanup.error;
  if (!runtimeCleanup.completed) {
    await reportDiagnosticWithinTimeout(
      runtime,
      "v2_runtime_cleanup_timeout",
      waitForDiagnosticTask,
      eventTaskTimeoutMs,
    );
  }
  if (firstError) throw firstError;
};

export const createOpenCodeV2Adapter = ({
  createRuntime = createCodememRuntime,
  eventTaskTimeoutMs = DEFAULT_EVENT_TASK_TIMEOUT_MS,
  waitForCaptureTask = defaultWaitForEventTask,
  waitForDiagnosticTask = defaultWaitForEventTask,
  waitForEventTask = defaultWaitForEventTask,
  waitForRegistrationTask = defaultWaitForEventTask,
  waitForRuntimeDisposalTask = defaultWaitForEventTask,
} = {}) => async (context) => {
  const location = context.location;
  // beta-19296 exposes neither app logging nor toast APIs, so V2 uses local diagnostics only.
  const runtime = await createRuntime({
    location: createRuntimeLocation({
      project: { ...location.project, root: location.project.canonical },
      directory: location.directory,
      worktree: location.project.directory,
    }),
    host: createRuntimeHost({ log: async () => {}, notify: null }),
  });
  if (!runtime) return undefined;

  const abortController = new AbortController();
  const registrations = [];
  const translator = createV2EventTranslator();
  const scheduleCapture = createCaptureScheduler();
  let active = true;
  let eventTask;
  try {
    registrations.push(await context.tool.hook("execute.after", async (input) => {
      if (!active) return;
      const translated = translateV2ToolResult(input);
      await captureRuntimeTaskWithinTimeout({
        runtime,
        run: () => runtime.handleToolResult(translated.input, translated.output),
        scheduleCapture,
        diagnosticCode: "v2_tool_capture_failed",
        timeoutMs: eventTaskTimeoutMs,
        waitForCaptureTask,
        waitForDiagnosticTask,
      });
    }));
    eventTask = consumeEvents(context, abortController.signal, runtime, translator, {
      eventTaskTimeoutMs,
      scheduleCapture,
      waitForCaptureTask,
      waitForDiagnosticTask,
    });
  } catch (error) {
    active = false;
    runtime.deactivate?.();
    abortController.abort();
    translator.clear();
    await disposeAll(registrations).catch(() => {});
    const runtimeCleanup = await waitForRuntimeDisposal(
      runtime,
      waitForRuntimeDisposalTask,
      eventTaskTimeoutMs,
    );
    if (!runtimeCleanup.completed) {
      await reportDiagnosticWithinTimeout(
        runtime,
        "v2_runtime_cleanup_timeout",
        waitForDiagnosticTask,
        eventTaskTimeoutMs,
      );
    }
    // Preserve the setup error that explains why activation failed.
    throw error;
  }

  let cleanupTask;
  return () => {
    if (!cleanupTask) {
      active = false;
      cleanupTask = cleanupAdapter({
        abortController,
        eventTask,
        eventTaskTimeoutMs,
        registrations,
        runtime,
        translator,
        waitForDiagnosticTask,
        waitForEventTask,
        waitForRegistrationTask,
        waitForRuntimeDisposalTask,
      });
    }
    return cleanupTask;
  };
};

export const setupOpenCodeV2 = createOpenCodeV2Adapter();
