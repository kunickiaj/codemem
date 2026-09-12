import {
  V2_ADAPTER_DIAGNOSTICS,
  createRuntimeHost,
  createRuntimeLocation,
} from "./host-contract.js";
import { createCodememRuntime } from "./runtime.js";

const DEFAULT_EVENT_TASK_TIMEOUT_MS = 250;
const FAILED_TOOL_ERROR = Object.freeze({
  name: "CodememToolCaptureError",
  message: "OpenCode reported a failed tool without error details",
});
const CODEMEM_CONTEXT_PART_ID_PREFIX = "codemem-context-";
const CODEMEM_RECALL_METADATA_VERSION = 1;
const CODEMEM_V2_PART_METADATA_KEY = "codememPart";

const asRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};

const hasV2CodememMarker = (part) => {
  const candidate = asRecord(part);
  const metadata = asRecord(candidate.metadata);
  const marker = asRecord(metadata[CODEMEM_V2_PART_METADATA_KEY]);
  const markerID = String(marker.id || "");
  return candidate.type === "text"
    && marker.v === CODEMEM_RECALL_METADATA_VERSION
    && marker.synthetic === true
    && markerID.startsWith(CODEMEM_CONTEXT_PART_ID_PREFIX);
};

const isV2CodememTextPart = (part, messageID = null) => {
  if (!hasV2CodememMarker(part)) return false;
  const marker = asRecord(asRecord(part).metadata)[CODEMEM_V2_PART_METADATA_KEY];
  return !messageID || marker.id === `${CODEMEM_CONTEXT_PART_ID_PREFIX}${messageID}`;
};

const translateV2MessagePart = (part, { messageID, sessionID }) => {
  const candidate = asRecord(part);
  if (messageID && hasV2CodememMarker(candidate) && !isV2CodememTextPart(candidate, messageID)) {
    return null;
  }
  if (!messageID || !isV2CodememTextPart(candidate, messageID)) {
    // Keep null explicit: V2 must never synthesize identity for an unidentified message.
    return { ...candidate, messageID, sessionID };
  }
  const metadata = asRecord(candidate.metadata);
  const marker = asRecord(metadata[CODEMEM_V2_PART_METADATA_KEY]);
  const canonicalMetadata = { ...metadata };
  delete canonicalMetadata[CODEMEM_V2_PART_METADATA_KEY];
  return {
    ...candidate,
    id: marker.id,
    messageID,
    sessionID,
    synthetic: true,
    metadata: canonicalMetadata,
  };
};

export const translateV2Messages = (messages, sessionID) => {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    const candidate = asRecord(message);
    const messageID = typeof candidate.id === "string" ? candidate.id : null;
    const content = Array.isArray(candidate.content) ? candidate.content : [];
    return {
      info: {
        ...(messageID ? { id: messageID } : {}),
        role: candidate.role,
        sessionID,
      },
      parts: content
        .map((part) => translateV2MessagePart(part, { messageID, sessionID }))
        .filter(Boolean),
    };
  });
};

const isCanonicalCodememTextPart = (part) =>
  part?.type === "text"
  && part?.synthetic === true
  && String(part?.id || "").startsWith(CODEMEM_CONTEXT_PART_ID_PREFIX);

const toV2CodememTextPart = (part) => {
  const metadata = asRecord(part.metadata);
  return {
    type: "text",
    text: part.text,
    metadata: {
      ...metadata,
      [CODEMEM_V2_PART_METADATA_KEY]: {
        v: CODEMEM_RECALL_METADATA_VERSION,
        synthetic: true,
        id: part.id,
      },
    },
  };
};

const copyInjectedContextToV2Messages = (messages, canonicalMessages) =>
  messages.map((original, index) => {
    const message = asRecord(original);
    const content = Array.isArray(message.content) ? message.content : [];
    const injected = canonicalMessages[index]?.parts
      ?.filter(isCanonicalCodememTextPart)
      .map(toV2CodememTextPart) || [];
    return {
      ...message,
      content: [
        ...content.filter((part) => !hasV2CodememMarker(part)),
        ...injected,
      ],
    };
  });

const copyLatestInjectedContextToV2System = (system, canonicalMessages) => {
  for (let index = canonicalMessages.length - 1; index >= 0; index -= 1) {
    const message = canonicalMessages[index];
    if (message?.info?.role !== "user") continue;
    const injected = message.parts?.find(isCanonicalCodememTextPart);
    if (!injected) return null;
    return [
      ...system.filter((part) => !hasV2CodememMarker(part)),
      toV2CodememTextPart(injected),
    ];
  }
  return null;
};

export const transformV2Context = async (runtime, input) => {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const canonicalMessages = translateV2Messages(messages, input?.sessionID || null);
  const result = await runtime.transformMessages(
    { sessionID: input?.sessionID || null },
    { messages: canonicalMessages },
    {
      deferDeliveryConfirmation: true,
      enableSystemSurface: true,
      pruneAbsentCacheEntries: false,
      requireLatestUserMessageID: true,
    },
  );
  try {
    if (result?.surface === "system") {
      const system = Array.isArray(input?.system) ? input.system : [];
      const transformed = copyLatestInjectedContextToV2System(system, canonicalMessages);
      if (transformed && !Array.isArray(input?.system)) {
        throw new TypeError("OpenCode V2 context input omitted the mutable system array");
      }
      if (transformed) {
        input.system.splice(0, input.system.length, ...transformed);
      }
      result?.completeDelivery?.("handed_off");
      return;
    }
    if (!Array.isArray(input?.messages)) {
      if (result?.applied) {
        throw new TypeError("OpenCode V2 context input omitted the mutable messages array");
      }
      result?.completeDelivery?.("handed_off");
      return;
    }
    const transformed = copyInjectedContextToV2Messages(messages, canonicalMessages);
    input.messages.splice(0, input.messages.length, ...transformed);
    result?.completeDelivery?.("handed_off");
  } catch (error) {
    result?.completeDelivery?.("failed");
    throw error;
  }
};

const createContextScheduler = () => {
  const tails = new Map();
  const schedule = async (key, run) => {
    const previous = tails.get(key) || Promise.resolve();
    // Serialize retries of one turn without blocking independent turns or sessions.
    const task = previous.catch(() => {}).then(run);
    tails.set(key, task);
    try {
      await task;
    } finally {
      if (tails.get(key) === task) tails.delete(key);
    }
  };
  return {
    schedule,
    waitForIdle: () => Promise.allSettled([...tails.values()]),
  };
};

const contextScheduleKey = (input) => {
  const messages = Array.isArray(input?.messages) ? input.messages : [];
  const latestUser = messages.findLast((message) => message?.role === "user");
  const messageID = typeof latestUser?.id === "string" ? latestUser.id : "missing";
  return `${input?.sessionID || "unknown"}:${messageID}`;
};

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

export const createV2Tool = (name, definition, { isActive = () => true } = {}) => {
  const properties = {};
  const required = [];
  for (const [argumentName, argument] of Object.entries(definition.args)) {
    if (argument.type !== "number") {
      throw new Error(`Unsupported OpenCode 2 tool argument: ${argumentName}:${argument.type}`);
    }
    properties[argumentName] = { type: "number" };
    if (!argument.optional) required.push(argumentName);
  }
  const input = {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
  return {
    name,
    description: definition.description,
    input,
    options: { codemode: false },
    execute: async (args) => {
      if (!isActive()) throw new Error("Codemem tool is unavailable after adapter cleanup");
      return { content: await definition.execute(asRecord(args)) };
    },
  };
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
  const outcomes = await Promise.all([...registrations].reverse().map(async (registration) => {
    let disposalError;
    const disposalTask = Promise.resolve().then(() => registration.dispose()).catch((error) => {
      disposalError = error;
    });
    try {
      const completed = await waitForTask(disposalTask, timeoutMs);
      return { completed, error: disposalError };
    } catch (error) {
      return { completed: false, error };
    }
  }));
  return {
    completed: outcomes.every((outcome) => outcome.completed),
    error: outcomes.find((outcome) => outcome.error)?.error,
  };
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
          diagnosticCode: V2_ADAPTER_DIAGNOSTICS.eventCaptureFailed,
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
        V2_ADAPTER_DIAGNOSTICS.eventStreamEndedUnexpectedly,
        waitForDiagnosticTask,
        eventTaskTimeoutMs,
      );
    }
  } catch (error) {
    if (signal.aborted && error instanceof Error && error.name === "AbortError") return;
    await reportDiagnosticWithinTimeout(
      runtime,
      V2_ADAPTER_DIAGNOSTICS.eventStreamFailed,
      waitForDiagnosticTask,
      eventTaskTimeoutMs,
    );
  }
};

const cleanupAdapter = async ({
  abortController,
  eventTask,
  eventTaskTimeoutMs,
  contextTask,
  registrations,
  runtime,
  translator,
  waitForDiagnosticTask,
  waitForContextTask,
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
      V2_ADAPTER_DIAGNOSTICS.registrationCleanupTimeout,
      waitForDiagnosticTask,
      eventTaskTimeoutMs,
    );
  }
  let contextCompleted = false;
  try {
    contextCompleted = await waitForContextTask(contextTask, eventTaskTimeoutMs);
  } catch (error) {
    firstError ??= error;
  }
  if (!contextCompleted) {
    await reportDiagnosticWithinTimeout(
      runtime,
      V2_ADAPTER_DIAGNOSTICS.contextCleanupTimeout,
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
      V2_ADAPTER_DIAGNOSTICS.eventStreamCleanupTimeout,
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
      V2_ADAPTER_DIAGNOSTICS.runtimeCleanupTimeout,
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
  waitForContextTask = defaultWaitForEventTask,
  waitForDiagnosticTask = defaultWaitForEventTask,
  waitForEventTask = defaultWaitForEventTask,
  waitForRegistrationTask = defaultWaitForEventTask,
  waitForRuntimeDisposalTask = defaultWaitForEventTask,
} = {}) => async (context) => {
  const location = context.location;
  // OpenCode 2.0.2 exposes neither app logging nor toast APIs, so V2 uses local diagnostics only.
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
  const scheduleContext = createContextScheduler();
  let active = true;
  let eventTask;
  try {
    registrations.push(await context.session.hook("context", async (input) => {
      if (!active) return;
      try {
        await scheduleContext.schedule(contextScheduleKey(input), async () => {
          if (active) await transformV2Context(runtime, input);
        });
      } catch {
        await reportDiagnosticWithinTimeout(
          runtime,
          V2_ADAPTER_DIAGNOSTICS.contextRecallFailed,
          waitForDiagnosticTask,
          eventTaskTimeoutMs,
        );
      }
    }));
    registrations.push(await context.tool.hook("execute.after", async (input) => {
      if (!active) return;
      const translated = translateV2ToolResult(input);
      await captureRuntimeTaskWithinTimeout({
        runtime,
        run: () => runtime.handleToolResult(translated.input, translated.output),
        scheduleCapture,
        diagnosticCode: V2_ADAPTER_DIAGNOSTICS.toolCaptureFailed,
        timeoutMs: eventTaskTimeoutMs,
        waitForCaptureTask,
        waitForDiagnosticTask,
      });
    }));
    registrations.push(await context.tool.transform((editor) => {
      if (!active) return;
      for (const [name, definition] of Object.entries(runtime.tools)) {
        editor.add(createV2Tool(name, definition, { isActive: () => active }));
      }
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
    const registrationCleanup = await waitForRegistrationDisposal(
      registrations,
      waitForRegistrationTask,
      eventTaskTimeoutMs,
    );
    if (!registrationCleanup.completed) {
      await reportDiagnosticWithinTimeout(
        runtime,
        V2_ADAPTER_DIAGNOSTICS.registrationCleanupTimeout,
        waitForDiagnosticTask,
        eventTaskTimeoutMs,
      );
    }
    const runtimeCleanup = await waitForRuntimeDisposal(
      runtime,
      waitForRuntimeDisposalTask,
      eventTaskTimeoutMs,
    );
    if (!runtimeCleanup.completed) {
      await reportDiagnosticWithinTimeout(
        runtime,
        V2_ADAPTER_DIAGNOSTICS.runtimeCleanupTimeout,
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
        contextTask: scheduleContext.waitForIdle(),
        eventTask,
        eventTaskTimeoutMs,
        registrations,
        runtime,
        translator,
        waitForDiagnosticTask,
        waitForContextTask,
        waitForEventTask,
        waitForRegistrationTask,
        waitForRuntimeDisposalTask,
      });
    }
    return cleanupTask;
  };
};

export const setupOpenCodeV2 = createOpenCodeV2Adapter();
