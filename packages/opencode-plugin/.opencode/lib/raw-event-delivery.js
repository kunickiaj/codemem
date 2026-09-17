import { homedir } from "node:os";
import {
  DEFAULT_DRAIN_LIMIT,
  DEFAULT_MAX_ENTRIES,
  loadRawEventSpoolEntries,
  RAW_EVENT_SPOOL_FULL_CODE,
  removeRawEventSpoolEntry,
  resolveSpoolDirectory,
  writeRawEventSpoolEntry,
} from "./raw-event-spool.js";

const rawEventSpoolDrainsInFlight = new Map();

export const classifyRawEventTransportCause = (error) => {
  const diagnostic = [
    error?.name,
    error?.code,
    error?.cause?.code,
    error?.message,
  ].filter(Boolean).join(" ");
  return /AbortError|TimeoutError|timeout|timed out|ETIMEDOUT/i.test(diagnostic)
    ? "timeout"
    : "connection";
};

export const describeRawEventViewerFailure = (failure) => {
  if (!failure) return "viewer delivery failed";
  if (failure.stage === "backoff") {
    return `viewer transport remained in backoff after ${failure.triggerStage || "request"} ${failure.cause}`;
  }
  if (failure.cause === "http_status") {
    return `viewer ${failure.stage} returned ${failure.status}`;
  }
  if (failure.cause === "ingest_unavailable") {
    return "viewer status reported ingest unavailable";
  }
  return `viewer ${failure.stage} ${failure.cause}`;
};

const createDeliveryState = (options) => ({
  abortController: new AbortController(),
  captureContexts: new WeakMap(),
  envelopes: new WeakMap(),
  lastStatusAvailable: true,
  lastStatusCheckAt: 0,
  latestViewerFailure: null,
  lastToastAtBySession: new Map(),
  options,
  spoolDirectory: resolveSpoolDirectory(options.spoolHome),
  spoolLoadFailureNoted: false,
  spoolPersistenceFailureNoted: null,
  startedAts: new WeakMap(),
  streamUnavailableUntil: 0,
});

const runCliFallback = async (state, serialized) => {
  const { classifyFallbackResult, queueViaCli } = state.options;
  const startedAt = Date.now();
  let result = await queueViaCli(serialized);
  let classification = classifyFallbackResult(result);
  let attempts = 1;
  if (result?.exitCode !== 0 && classification.retryable) {
    attempts += 1;
    result = await queueViaCli(serialized);
    classification = classifyFallbackResult(result);
  }
  const diagnostics = {
    attempts,
    elapsedMs: Math.max(0, Date.now() - startedAt),
    cause: result?.exitCode === 0 ? null : classification.cause,
  };
  if (result?.exitCode === 0) return diagnostics;
  const retryExhausted = attempts > 1 && classification.retryable;
  const error = new Error(retryExhausted ? `${classification.cause} after retry` : classification.cause);
  error.retryable = classification.retryable;
  error.cliDiagnostics = diagnostics;
  throw error;
};

const shouldToast = (state, sessionID, category = "general") => {
  const now = Date.now();
  const key = `${sessionID || "unknown"}:${category}`;
  const last = state.lastToastAtBySession.get(key) || 0;
  if (now - last < 60000) return false;
  state.lastToastAtBySession.set(key, now);
  return true;
};

const bestEffortHostLog = async (state, input) => {
  try {
    await state.options.hostLog(input);
  } catch {
    // Best-effort app logging only.
  }
};

const bestEffortNotify = async (state, input) => {
  try {
    await state.options.hostNotify(input);
  } catch {
    // Best-effort toast only.
  }
};

const warnSpoolPersistenceFailure = async (state, sessionID, reason) => {
  const message = reason === "spool_full"
    ? "codemem raw-event retry spool is full; repair Codemem, then archive retained entries"
    : "codemem could not save a raw event for retry; it remains queued in memory";
  await bestEffortHostLog(state, {
    service: "codemem",
    level: "error",
    message,
    extra: { category: "persistence", reason },
  });
  if (state.spoolPersistenceFailureNoted === reason) return;
  state.spoolPersistenceFailureNoted = reason;
  if (!state.options.hostNotify || !shouldToast(state, sessionID, `persistence:${reason}`)) return;
  await bestEffortNotify(state, { message: `codemem: ${message}`, variant: "error" });
};

const persistForRetry = async (state, { body, serialized, payload, sessionID }) => {
  try {
    await writeRawEventSpoolEntry({
      envelope: body,
      serialized,
      homeDir: state.options.spoolHome,
      maxEntries: state.options.spoolMaxEntries,
    });
    state.spoolPersistenceFailureNoted = null;
    if (payload && typeof payload === "object") payload._raw_spooled = true;
    return true;
  } catch (error) {
    const reason = error?.code === RAW_EVENT_SPOOL_FULL_CODE ? "spool_full" : "write_failed";
    await state.options.logLine(`raw_events.spool.${reason} category=persistence`);
    await warnSpoolPersistenceFailure(state, sessionID, reason);
    return false;
  }
};

const removeFromSpool = async (state, { eventId, payload }) => {
  try {
    await removeRawEventSpoolEntry({ eventId, homeDir: state.options.spoolHome });
    if (payload && typeof payload === "object") payload._raw_spooled = false;
  } catch {
    await state.options.logLine("raw_events.spool.cleanup_failed category=persistence");
  }
};

const deliveryKind = ({ delivered, durable }) => {
  if (delivered) return "cli";
  if (durable) return "spool";
  return "memory";
};

const deliveryOutcome = ({ delivered, durable }) => {
  if (delivered) return "was queued via CLI";
  if (!durable) return "was not saved for retry; still queued in memory";
  return "was saved for retry";
};

const deliveryExtra = ({ category, delivery, viewerFailure, cliDiagnostics }) => ({
  category,
  delivery,
  viewer_stage: viewerFailure?.stage || "unknown",
  viewer_cause: viewerFailure?.cause || "unknown",
  ...(Number.isInteger(viewerFailure?.status) ? { viewer_status: viewerFailure.status } : {}),
  ...(viewerFailure?.triggerStage ? { viewer_trigger_stage: viewerFailure.triggerStage } : {}),
  viewer_elapsed_ms: Math.max(0, viewerFailure?.elapsedMs || 0),
  cli_attempts: Math.max(0, cliDiagnostics?.attempts || 0),
  cli_elapsed_ms: Math.max(0, cliDiagnostics?.elapsedMs || 0),
  ...(cliDiagnostics?.cause ? { cli_cause: cliDiagnostics.cause } : {}),
});

const viewerFailureLogFields = (failure) =>
  `viewer_stage=${failure.stage} viewer_cause=${failure.cause}`
  + `${Number.isInteger(failure.status) ? ` viewer_status=${failure.status}` : ""}`
  + ` viewer_elapsed_ms=${failure.elapsedMs}`;

const cliFailureLogFields = (diagnostics) =>
  `cli_attempts=${diagnostics?.attempts || 0}`
  + ` cli_elapsed_ms=${diagnostics?.elapsedMs || 0}`
  + ` cli_cause=${JSON.stringify(diagnostics?.cause || "unknown")}`;

const backoffFailure = (latestFailure) => ({
  ...(latestFailure || { cause: "active" }),
  stage: "backoff",
  ...(latestFailure?.stage ? { triggerStage: latestFailure.stage } : {}),
  elapsedMs: 0,
});

const failureFromError = ({ error, stage, startedAt }) => ({
  ...(error?.rawEventFailure || {
    stage,
    cause: classifyRawEventTransportCause(error),
  }),
  elapsedMs: Math.max(0, Date.now() - startedAt),
});

const notifyDelivery = async (state, input) => {
  const { category, cliDiagnostics, delivered, sessionID, viewerFailure } = input;
  const action = state.options.failureActions[category] || state.options.failureActions.connection;
  const message = `codemem raw event ${deliveryOutcome(input)} after ${describeRawEventViewerFailure(viewerFailure)}; ${action}`;
  const delivery = deliveryKind(input);
  await bestEffortHostLog(state, {
    service: "codemem",
    level: delivered ? "warn" : "error",
    message,
    extra: deliveryExtra({ category, delivery, viewerFailure, cliDiagnostics }),
  });
  if (!state.options.hostNotify || !shouldToast(state, sessionID, `${category}:${delivery}`)) return;
  await bestEffortNotify(state, {
    message: `codemem: ${message}`,
    variant: delivered ? "warning" : "error",
  });
};

const notifySpoolLoadFailure = async (state) => {
  await state.options.logLine("raw_events.spool.load_failed category=persistence");
  const message = "codemem could not read saved raw events; spool entries were left untouched";
  await bestEffortHostLog(state, {
    service: "codemem",
    level: "error",
    message,
    extra: { category: "persistence", delivery: "load" },
  });
  if (state.spoolLoadFailureNoted) return;
  state.spoolLoadFailureNoted = true;
  if (!state.options.hostNotify || !shouldToast(state, null, "persistence:load")) return;
  await bestEffortNotify(state, { message: `codemem: ${message}`, variant: "error" });
};

const loadSpool = async (state) => {
  try {
    const loaded = await loadRawEventSpoolEntries({
      homeDir: state.options.spoolHome,
      limit: state.options.spoolDrainLimit,
    });
    state.spoolLoadFailureNoted = false;
    return loaded;
  } catch {
    await notifySpoolLoadFailure(state);
    return null;
  }
};

const drainLoadedEntries = async (state, loaded) => {
  if (loaded.corruptCount > 0) {
    await state.options.logLine(`raw_events.spool.corrupt_retained count=${loaded.corruptCount}`);
  }
  for (const entry of loaded.entries) {
    try {
      await runCliFallback(state, entry.serialized);
      await removeFromSpool(state, { eventId: entry.eventId });
    } catch (error) {
      await state.options.logLine("raw_events.spool.drain_deferred category=fallback");
      if (error?.retryable === true) break;
    }
  }
};

const runSpoolDrain = async (state) => {
  const loaded = await loadSpool(state);
  if (loaded) await drainLoadedEntries(state, loaded);
};

const drainSpool = (state) => {
  if (!state.options.enabled) return Promise.resolve();
  const existingDrain = rawEventSpoolDrainsInFlight.get(state.spoolDirectory);
  if (existingDrain) return existingDrain;
  const drainPromise = runSpoolDrain(state);
  const trackedDrain = drainPromise
    .catch(async () => state.options.logLine("raw_events.spool.drain_failed category=persistence"))
    .finally(() => {
      if (rawEventSpoolDrainsInFlight.get(state.spoolDirectory) === trackedDrain) {
        rawEventSpoolDrainsInFlight.delete(state.spoolDirectory);
      }
    });
  rawEventSpoolDrainsInFlight.set(state.spoolDirectory, trackedDrain);
  return trackedDrain;
};

const cachedEnvelope = (state, sessionID, type, payload, now) => {
  const cached = payload && typeof payload === "object" ? state.envelopes.get(payload) : null;
  if (cached) return cached;
  const options = state.options;
  const envelope = options.buildEnvelope({
    sessionID,
    type,
    payload,
    cwd: options.cwd,
    project: options.projectName,
    startedAt: state.startedAts.has(payload) ? state.startedAts.get(payload) : options.sessionStartedAt(),
    nowMs: now,
    nowMono: typeof performance !== "undefined" && performance.now ? performance.now() : null,
    nextEventId: options.nextEventId,
    captureContext: state.captureContexts.get(payload),
  });
  const serialized = JSON.stringify(envelope);
  const value = { body: JSON.parse(serialized), serialized };
  if (payload && typeof payload === "object") state.envelopes.set(payload, value);
  return value;
};

const deliverDuringBackoff = async (state, input) => {
  const viewerFailure = backoffFailure(state.latestViewerFailure);
  const durable = await persistForRetry(state, input);
  try {
    const cliDiagnostics = await runCliFallback(state, input.serialized);
    await removeFromSpool(state, { eventId: input.body.event_id, payload: input.payload });
    if (input.payload && typeof input.payload === "object") input.payload._raw_enqueued = true;
    await notifyDelivery(state, {
      category: "connection",
      cliDiagnostics,
      delivered: true,
      durable,
      sessionID: input.sessionID,
      viewerFailure,
    });
    return true;
  } catch (error) {
    const cliDiagnostics = error?.cliDiagnostics || null;
    await state.options.logLine(
      `raw_events.fallback.error category=connection ${viewerFailureLogFields(viewerFailure)}`
      + ` ${cliFailureLogFields(cliDiagnostics)}`
    );
    await notifyDelivery(state, {
      category: "connection",
      cliDiagnostics,
      delivered: false,
      durable,
      sessionID: input.sessionID,
      viewerFailure,
    });
    return false;
  }
};

const ingestUnavailableError = () => {
  const error = new Error("raw-events ingest unavailable");
  error.rawEventFailure = { stage: "status", cause: "ingest_unavailable" };
  return error;
};

const checkViewerAvailability = async (state, now) => {
  if (now - state.lastStatusCheckAt < Math.max(1000, state.options.statusCheckMs)) {
    if (!state.lastStatusAvailable) throw ingestUnavailableError();
    return;
  }
  const response = await state.options.fetchRawEventsStatus(state.options.rawEventsStatusUrl);
  if (!response.ok) {
    state.options.discardResponseBody(response);
    const error = new Error(`raw-events status failed (${response.status})`);
    error.rawEventFailure = {
      stage: "status",
      cause: "http_status",
      status: response.status,
    };
    throw error;
  }
  const body = await response.json();
  state.lastStatusAvailable = body?.ingest?.available !== false;
  state.lastStatusCheckAt = now;
  if (!state.lastStatusAvailable) throw ingestUnavailableError();
};

const postToViewer = async (state, body) => {
  const options = state.options;
  const response = await fetch(options.rawEventsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.any([
      state.abortController.signal,
      AbortSignal.timeout(options.rawEventsStatusTimeoutMs),
    ]),
    body: JSON.stringify({ ...body, db_path: options.promptPackDbPath, identity_target: options.identityTarget }),
  });
  if (response.ok) return;
  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    // Generic connection guidance remains the safe fallback.
  }
  const error = new Error(`raw-events post failed (${response.status})`);
  error.rawEventFailureCategory = options.classifyViewerFailure(responseBody);
  error.rawEventFailure = {
    stage: "post",
    cause: "http_status",
    status: response.status,
  };
  throw error;
};

const handleViewerFailure = async (state, input, error, timing) => {
  if (!state.options.isActive()) return persistForRetry(state, input);
  const category = error?.rawEventFailureCategory || "connection";
  const viewerFailure = failureFromError({
    error,
    stage: timing.stage,
    startedAt: timing.startedAt,
  });
  state.latestViewerFailure = viewerFailure;
  state.streamUnavailableUntil = Date.now() + Math.max(1000, state.options.backoffMs);
  await state.options.logLine(
    `raw_events.error category=${category} ${viewerFailureLogFields(viewerFailure)}`
  );
  const durable = await persistForRetry(state, input);
  let delivered = false;
  let cliDiagnostics = null;
  try {
    cliDiagnostics = await runCliFallback(state, input.serialized);
    await removeFromSpool(state, { eventId: input.body.event_id, payload: input.payload });
    delivered = true;
  } catch (fallbackError) {
    cliDiagnostics = fallbackError?.cliDiagnostics || null;
    await state.options.logLine(
      `raw_events.fallback.error category=${category} ${viewerFailureLogFields(viewerFailure)}`
      + ` ${cliFailureLogFields(cliDiagnostics)}`
    );
  }
  if (delivered && input.payload && typeof input.payload === "object") {
    input.payload._raw_enqueued = true;
  }
  await notifyDelivery(state, {
    category,
    cliDiagnostics,
    delivered,
    durable,
    sessionID: input.sessionID,
    viewerFailure,
  });
  return delivered;
};

const deliver = async (state, { sessionID, type, payload }) => {
  if (!state.options.enabled) return true;
  if (!sessionID || !type) return false;
  if (payload?._raw_enqueued) return true;
  const now = Date.now();
  const envelope = cachedEnvelope(state, sessionID, type, payload, now);
  const input = { ...envelope, payload, sessionID };
  if (!state.options.isActive()) return persistForRetry(state, input);
  if (now < state.streamUnavailableUntil) return deliverDuringBackoff(state, input);
  const viewerStartedAt = Date.now();
  let viewerStage = "status";
  try {
    await checkViewerAvailability(state, now);
    viewerStage = "post";
    await postToViewer(state, envelope.body);
    state.streamUnavailableUntil = 0;
    state.latestViewerFailure = null;
    state.lastStatusAvailable = true;
    await removeFromSpool(state, { eventId: envelope.body.event_id, payload });
    if (payload && typeof payload === "object") payload._raw_enqueued = true;
    return true;
  } catch (error) {
    return handleViewerFailure(state, input, error, {
      stage: viewerStage,
      startedAt: viewerStartedAt,
    });
  }
};

export const createRawEventDelivery = (options) => {
  const state = createDeliveryState({
    ...options,
    spoolDrainLimit: options.spoolDrainLimit ?? DEFAULT_DRAIN_LIMIT,
    spoolHome: options.spoolHome ?? homedir(),
    spoolMaxEntries: options.spoolMaxEntries ?? DEFAULT_MAX_ENTRIES,
  });
  return {
    abort: () => state.abortController.abort(),
    clearSession: (sessionID) => {
      for (const key of state.lastToastAtBySession.keys()) {
        if (key.startsWith(`${sessionID}:`)) state.lastToastAtBySession.delete(key);
      }
    },
    deliver: (input) => deliver(state, input),
    drainSpool: () => drainSpool(state),
    setCaptureContext: (payload, context) => state.captureContexts.set(payload, context),
    setStartedAt: (payload, startedAt) => state.startedAts.set(payload, startedAt),
  };
};
