import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DRAIN_LIMIT,
  DEFAULT_MAX_ENTRIES,
  loadRawEventSpoolEntries,
  RAW_EVENT_SPOOL_CONFLICT_CODE,
  RAW_EVENT_SPOOL_FULL_CODE,
  removeRawEventSpoolEntry,
  resolveSpoolDirectory,
  retainRejectedRawEventSpoolEntry,
  writeRawEventSpoolEntry,
} from "./raw-event-spool.js";

const rawEventSpoolDrainsInFlight = new Map();

// Mirror the Viewer's explicit validation responses without importing server code.
const TERMINAL_VALIDATION_MESSAGES = new Set([
  "source must be string",
  "source is required",
  "source must use 1-64 letters, digits, dots, underscores, or hyphens",
  "session_stream_id must be string",
  "session_id must be string",
  "stream_id must be string",
  "opencode_session_id must be string",
  "conflicting session id fields",
  "invalid session id",
  "event source conflicts with request source",
  "session id required",
  "event_type must be string",
  "event_type required",
  "event_type has invalid syntax",
  "event_id must be string",
  "event_id required",
  "event_id has invalid syntax",
  "event_seq must be int",
  "ts_wall_ms must be number",
  "ts_mono_ms must be number",
  "payload must be an object",
  "cwd must be string",
  "project must be string",
  "started_at must be string",
  "events must be a list",
  "event must be an object",
]);

export const classifyRawEventTerminalRejection = ({ status, responseBody, outgoingBytes }) => {
  if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) return null;
  if (status === 400 && TERMINAL_VALIDATION_MESSAGES.has(responseBody.error)) {
    return { status: 400, reason: "invalid_payload" };
  }
  if (status === 413 && responseBody.error === "payload too large"
    && Number.isFinite(responseBody.max_bytes) && responseBody.max_bytes > 0
    && Number.isFinite(outgoingBytes) && outgoingBytes > responseBody.max_bytes) {
    return { status: 413, reason: "payload_too_large" };
  }
  return null;
};

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
  retainedPayloads: new WeakSet(),
  spoolDirectory: resolveSpoolDirectory(options.spoolHome),
  spoolCorruptionNoted: false,
  spoolLoadFailureNoted: false,
  spoolPersistenceFailureNoted: null,
  startedAts: new WeakMap(),
  streamUnavailableUntil: 0,
});

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

const SPOOL_STAGES = new Set(["directory", "existing_entry", "capacity", "temporary_write", "publish", "directory_sync"]);
const SPOOL_ERRNOS = new Set(["EACCES", "EPERM", "ENOSPC", "EROFS", "ENOTDIR", "EEXIST", "EIO", "EINVAL", "EMFILE", "ENFILE"]);
const SPOOL_CONFLICT_BRANCHES = ["active_comparison", "rejected_comparison", "rejected_identity", "publish_comparison"];
const SPOOL_CONFLICT_REASONS = ["invalid_json", "invalid_shape", "field_mismatch", "identity_mismatch"];
const SPOOL_CONFLICT_FIELDS = [
  "started_at", "host_generation", "capture_context", "session_stream_id", "session_id",
  "stream_id", "opencode_session_id", "cwd", "project", "source", "event_type",
  "payload", "payload.timestamp", "payload._adapter", "payload._adapter.ts", "payload._raw_spooled", "payload.args",
];

const spoolConflictDiagnostic = (error) => {
  try {
    const diagnostic = error?.spoolConflict;
    // Rebuild from literals at the logging boundary, including for foreign errors.
    const branch = SPOOL_CONFLICT_BRANCHES.find((value) => value === diagnostic?.branch);
    const reason = SPOOL_CONFLICT_REASONS.find((value) => value === diagnostic?.reason);
    if (!branch || !reason) return "";
    const fields = diagnostic.fields;
    const changed = Array.isArray(fields)
      ? SPOOL_CONFLICT_FIELDS.filter((field) => fields.includes(field))
      : [];
    let suffix = ` branch=${branch} reason=${reason}`;
    if (changed.length) suffix += ` fields=${changed.join(",")}`;
    if (diagnostic.other === true) suffix += " other=true";
    return suffix;
  } catch {
    return "";
  }
};

const spoolFailureDiagnostic = (error) => {
  const stage = SPOOL_STAGES.has(error?.spoolStage) ? error.spoolStage : "unknown";
  let code = "other";
  if (error?.code === RAW_EVENT_SPOOL_CONFLICT_CODE) code = "conflict";
  else if (error?.code === RAW_EVENT_SPOOL_FULL_CODE) code = "full";
  else if (SPOOL_ERRNOS.has(error?.code)) code = error.code;
  return `raw_events.spool.failure stage=${stage} code=${code} category=persistence`
    + spoolConflictDiagnostic(error);
};

const persistSafeSpoolDiagnostic = async (state, line) => {
  const directory = join(state.options.spoolHome, ".codemem");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await appendFile(join(directory, "plugin.log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
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
    const diagnostic = spoolFailureDiagnostic(error);
    try {
      await persistSafeSpoolDiagnostic(state, diagnostic);
    } catch {
      // The same disk/permission failure can block the local log. Keep the
      // category visible in the host's stderr without exposing event content.
      console.error(`codemem: ${diagnostic}`);
    }
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
  const durable = input.durable === true;
  await bestEffortHostLog(state, {
    service: "codemem",
    level: delivered || durable ? "warn" : "error",
    message,
    extra: deliveryExtra({ category, delivery, viewerFailure, cliDiagnostics }),
  });
  if (durable) return;
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

const notifySpoolCorruption = async (state, count) => {
  const message = `codemem raw-event retry spool contains ${count} corrupt retained ${count === 1 ? "entry" : "entries"}; repair or archive the retained entries`;
  await bestEffortHostLog(state, {
    service: "codemem",
    level: "error",
    message,
    extra: { category: "persistence", delivery: "corrupt", count },
  });
  if (state.spoolCorruptionNoted) return;
  state.spoolCorruptionNoted = true;
  if (!state.options.hostNotify || !shouldToast(state, null, "persistence:corrupt")) return;
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

const armViewerBackoff = (state, error, timing) => {
  const viewerFailure = failureFromError({ error, ...timing });
  state.latestViewerFailure = viewerFailure;
  state.streamUnavailableUntil = Date.now() + Math.max(1000, state.options.backoffMs);
  return viewerFailure;
};

const warnRejectedEntry = async (state, { rejection, outcome, sessionID }) => {
  const messages = {
    retained: "codemem retained a rejected raw event; inspect it with codemem capture list-rejected",
    retain_failed: "codemem could not retain a rejected raw event outside retries; inspect saved events before retrying",
    lock_release_failed: "codemem could not release a rejected-event lock; stop capture and inspect saved events before repairing the lock",
  };
  const message = messages[outcome];
  await state.options.logLine(
    `raw_events.spool.${outcome} status=${rejection.status} reason=${rejection.reason}`
  );
  await bestEffortHostLog(state, {
    service: "codemem",
    level: outcome === "retained" ? "warn" : "error",
    message,
    extra: { category: "rejection", status: rejection.status, reason: rejection.reason, outcome },
  });
  if (!state.options.hostNotify || !shouldToast(state, sessionID, `rejection:${outcome}`)) return;
  await bestEffortNotify(state, { message, variant: outcome === "retained" ? "warning" : "error" });
};

const retainRejectedEntry = async (state, { eventId, rejection, sessionID, payload }) => {
  let retained;
  try {
    retained = await retainRejectedRawEventSpoolEntry({
      eventId,
      ...rejection,
      homeDir: state.options.spoolHome,
    });
  } catch (error) {
    await warnRejectedEntry(state, { rejection, sessionID, outcome: "retain_failed" });
    if (error?.lock === "release_failed") {
      await warnRejectedEntry(state, { rejection, sessionID, outcome: "lock_release_failed" });
    }
    return;
  }
  if (payload && typeof payload === "object") state.retainedPayloads.add(payload);
  await warnRejectedEntry(state, { rejection, sessionID, outcome: "retained" });
  if (retained.lock === "release_failed") {
    await warnRejectedEntry(state, { rejection, sessionID, outcome: "lock_release_failed" });
  }
};

const drainLoadedEntries = async (state, loaded) => {
  if (loaded.corruptCount > 0) {
    await state.options.logLine(`raw_events.spool.corrupt_retained count=${loaded.corruptCount}`);
    await notifySpoolCorruption(state, loaded.corruptCount);
  } else {
    state.spoolCorruptionNoted = false;
  }
  for (const entry of loaded.entries) {
    const viewerStartedAt = Date.now();
    try {
      await postToViewer(state, entry.envelope);
      await removeFromSpool(state, { eventId: entry.eventId });
    } catch (error) {
      if (error?.rawEventTerminalRejection) {
        await retainRejectedEntry(state, { eventId: entry.eventId, rejection: error.rawEventTerminalRejection });
        continue;
      }
      await state.options.logLine("raw_events.spool.drain_deferred category=fallback");
      const status = error?.rawEventFailure?.status;
      if (!Number.isInteger(status) || status >= 500 || status === 409) {
        armViewerBackoff(state, error, { stage: "post", startedAt: viewerStartedAt });
        break;
      }
    }
  }
};

const runSpoolDrain = async (state) => {
  const loaded = await loadSpool(state);
  if (loaded) await drainLoadedEntries(state, loaded);
};

const drainSpool = (state) => {
  if (!state.options.enabled) return Promise.resolve();
  if (Date.now() < state.streamUnavailableUntil) return Promise.resolve();
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
  if (durable && input.payload && typeof input.payload === "object") {
    input.payload._raw_spooled = true;
  }
  await notifyDelivery(state, {
    category: "connection",
    cliDiagnostics: null,
    delivered: false,
    durable,
    sessionID: input.sessionID,
    viewerFailure,
  });
  return durable;
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
  const outgoing = JSON.stringify({ ...body, db_path: options.promptPackDbPath, identity_target: options.identityTarget });
  const response = await fetch(options.rawEventsUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.any([
      state.abortController.signal,
      AbortSignal.timeout(options.rawEventsStatusTimeoutMs),
    ]),
    body: outgoing,
  });
  if (response.ok) return response;
  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    // Generic connection guidance remains the safe fallback.
  }
  const error = new Error(`raw-events post failed (${response.status})`);
  error.rawEventTerminalRejection = classifyRawEventTerminalRejection({
    status: response.status,
    responseBody,
    outgoingBytes: Buffer.byteLength(outgoing, "utf8"),
  });
  error.rawEventFailureCategory = options.classifyViewerFailure(responseBody);
  error.rawEventFailure = {
    stage: "post",
    cause: "http_status",
    status: response.status,
  };
  throw error;
};

const handleViewerFailure = async (state, input, error, timing) => {
  if (error?.rawEventTerminalRejection) {
    const durable = await persistForRetry(state, input);
    if (durable) {
      await retainRejectedEntry(state, {
        eventId: input.body.event_id,
        rejection: error.rawEventTerminalRejection,
        sessionID: input.sessionID,
        payload: input.payload,
      });
    }
    return durable;
  }
  if (!state.options.isActive()) return persistForRetry(state, input);
  const category = error?.rawEventFailureCategory || "connection";
  const viewerFailure = armViewerBackoff(state, error, timing);
  await state.options.logLine(
    `raw_events.error category=${category} ${viewerFailureLogFields(viewerFailure)}`
  );
  const durable = await persistForRetry(state, input);
  if (durable && input.payload && typeof input.payload === "object") {
    input.payload._raw_spooled = true;
  }
  await notifyDelivery(state, {
    category,
    cliDiagnostics: null,
    delivered: false,
    durable,
    sessionID: input.sessionID,
    viewerFailure,
  });
  return durable;
};

const deliver = async (state, { sessionID, type, payload }) => {
  if (!state.options.enabled) return true;
  if (!sessionID || !type) return false;
  if (payload?._raw_enqueued) return true;
  if (payload && typeof payload === "object" && state.retainedPayloads.has(payload)) return true;
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
