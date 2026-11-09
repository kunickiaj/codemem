import { randomUUID } from "node:crypto";
import { PROMPT_TRANSPORT_REASONS } from "./prompt-transport-diagnostics.js";

const STAGES = ["profile", "request_headers", "response_body", "fallback_total", "cli_resolve", "cli_execute"];
const EXECUTIONS = ["viewer", "cached_node", "codemem", "npx", "node", "uv", "uvx", "custom", "none"];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const noop = () => {};
const milliseconds = (value) => Number.isFinite(value)
  ? Math.round(Math.min(86_400_000, Math.max(0, value)) * 1000) / 1000 : 0;

// Diagnostics must never delay execution or turn a reporter rejection into an
// unhandled rejection. Neither errors nor caller-supplied objects enter reports.
const safely = (callback) => {
  try { void Promise.resolve(callback()).catch(noop); } catch { /* best effort */ }
};

const createClock = (now) => () => {
  try {
    const value = now();
    if (typeof value === "number" && Number.isFinite(value)) return value;
    safely(() => value);
  } catch { /* A broken clock cannot affect the request. */ }
  return null;
};

const createSpans = (readClock) => {
  const timings = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  const active = new Set();
  const incomplete = new Set();
  let finished = false;
  let transitionEnd = noop;
  const start = (stage) => {
    if (finished || !STAGES.includes(stage)) return noop;
    const began = readClock();
    const span = { stage, end: null };
    const end = () => {
      if (finished || !active.delete(span)) return;
      const ended = readClock();
      if (began !== null && ended !== null) timings[stage] += milliseconds(ended - began);
    };
    span.end = end;
    active.add(span);
    return end;
  };
  const transition = (stage) => {
    if (finished) return;
    transitionEnd();
    transitionEnd = start(stage);
  };
  const finish = () => {
    if (finished) return;
    for (const span of [...active]) {
      incomplete.add(span.stage);
      span.end();
    }
    finished = true;
  };
  return { start, transition, finish, timings, incomplete };
};

const createLagWatcher = (readClock, startedAt) => {
  let lag = 0;
  let lastTick = startedAt;
  let finished = false;
  let watcher;
  const sample = (tick) => {
    if (tick !== null && lastTick !== null) lag = Math.max(lag, tick - lastTick - 25);
    lastTick = tick;
  };
  try {
    watcher = setInterval(() => { if (!finished) sample(readClock()); }, 25);
    watcher.unref?.();
  } catch { /* Timer availability is optional. */ }
  return (endedAt) => {
    finished = true;
    try { clearInterval(watcher); } catch { /* best effort */ }
    // Include a blocked interval even if its timer has not run yet.
    sample(endedAt);
    return milliseconds(lag);
  };
};

export const createPromptPackTiming = ({ enabled, logLine, now = () => performance.now(), newId = randomUUID }) => {
  if (!enabled) return undefined;
  let requestId;
  try {
    requestId = newId();
    if (typeof requestId !== "string" || !UUID_V4.test(requestId)) {
      safely(() => requestId);
      return undefined;
    }
  } catch { return undefined; }
  const readClock = createClock(now);
  const startedAt = readClock();
  const spans = createSpans(readClock);
  const stopLag = createLagWatcher(readClock, startedAt);
  let finished = false;
  let httpReason = "unknown";
  let execution = "none";
  const finish = ({ outcome, transport } = {}) => {
    if (finished) return;
    finished = true;
    const endedAt = readClock();
    spans.finish();
    const row = {
      schema_version: 1,
      side: "client",
      operation: "pack",
      request_id: requestId.toLowerCase(),
      outcome: ["completed", "failed", "terminal"].includes(outcome) ? outcome : "failed",
      transport: ["viewer", "cli", "none"].includes(transport) ? transport : "none",
      http_reason: httpReason,
      execution,
      elapsed_ms: milliseconds(startedAt === null || endedAt === null ? 0 : endedAt - startedAt),
      event_loop_lag_ms: stopLag(endedAt),
      timings_ms: Object.fromEntries(STAGES.map((stage) => [stage, milliseconds(spans.timings[stage])])),
      incomplete_stages: STAGES.filter((stage) => spans.incomplete.has(stage)),
    };
    safely(() => logLine(`prompt.pack.timing ${JSON.stringify(row)}`));
  };
  return {
    requestId: requestId.toLowerCase(), start: spans.start, transition: spans.transition, finish,
    setHttpReason: (reason) => {
      if (finished) return;
      spans.transition(null);
      httpReason = PROMPT_TRANSPORT_REASONS.includes(reason) ? reason : "unknown";
    },
    setExecution: (category) => {
      if (!finished) execution = EXECUTIONS.includes(category) ? category : "none";
    },
  };
};
