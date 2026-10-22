const REASONS = [
  "success", "disabled", "backoff", "profile_malformed", "protocol_mismatch",
  "database_mismatch", "identity_mismatch", "contract_unsupported",
  "request_rejected", "authorization_failure", "policy_failure",
  "endpoint_unavailable", "server_failure", "unexpected_status",
  "malformed_response", "timeout", "connection_failure", "unknown",
];
const OPERATIONS = ["pack", "prompt-pack-ledger"];
const RUNNERS = ["viewer", "none", "codemem", "npx", "node", "uvx", "uv", "custom"];
const STAGES = ["skipped", "profile", "request"];
const MAX_COUNT = 1_000_000;
const MAX_ELAPSED_MS = 86_400_000;
const LOG_INTERVAL_MS = 30_000;

const increment = (count) => Math.min(MAX_COUNT, count + 1);
const boundedElapsed = (value) => Number.isFinite(value)
  ? Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(value)))
  : 0;

const safeFields = (input) => ({
  stage: STAGES.includes(input.stage) ? input.stage : "skipped",
  elapsed_ms: boundedElapsed(input.elapsed_ms),
  runner: RUNNERS.includes(input.runner) ? input.runner : "custom",
  disposition: ["fallback", "local_fallback", "terminal"].includes(input.disposition)
    ? input.disposition : "unknown",
  status_class: ["2xx", "3xx", "4xx", "5xx"].includes(input.status_class)
    ? input.status_class : "none",
});

// Only fixed categories and bounded numbers cross this boundary. No request,
// response, error, runner path, or identity is retained, even in suppressed logs.
export const createPromptTransportDiagnostics = ({ logLine, now = () => performance.now() }) => {
  const counters = Object.fromEntries(OPERATIONS.map((operation) => [
    operation, Object.fromEntries(REASONS.map((reason) => [reason, 0])),
  ]));
  let suppressed = 0;
  let nextLogAt = -Infinity;
  let writing = false;

  const snapshot = () => ({
    counters: Object.fromEntries(OPERATIONS.map((operation) => [operation, { ...counters[operation] }])),
    suppressed,
  });

  const record = (input) => {
    if (!OPERATIONS.includes(input.operation)) return;
    const reason = REASONS.includes(input.reason) ? input.reason : "unknown";
    const counts = counters[input.operation];
    counts[reason] = increment(counts[reason]);
    if (reason === "success") return;
    const timestamp = now();
    if (writing || timestamp < nextLogAt) {
      suppressed = increment(suppressed);
      return;
    }
    nextLogAt = timestamp + LOG_INTERVAL_MS;
    const entry = {
      operation: input.operation,
      reason,
      ...safeFields(input),
      ...snapshot(),
    };
    suppressed = 0;
    writing = true;
    try {
      void Promise.resolve(logLine(`inject.transport ${JSON.stringify(entry)}`))
        .catch(() => {})
        .finally(() => { writing = false; });
    } catch {
      writing = false;
    }
  };

  return { record, snapshot };
};
