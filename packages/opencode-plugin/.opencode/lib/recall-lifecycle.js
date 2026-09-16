export const MAX_MESSAGE_INJECTION_CACHE_SESSIONS = 20;
export const MAX_MESSAGE_INJECTION_CACHE_ENTRIES = 100;

const MAX_ATTEMPT_ENTRIES = 2000;

const trimOldest = (entries, maximum) => {
  while (entries.size > maximum) {
    const oldest = entries.keys().next().value;
    if (!oldest) break;
    entries.delete(oldest);
  }
};

export const getSessionMessageInjectionCache = (messageInjectionCache, sessionID) => {
  if (!sessionID) return null;
  const cacheKey = sessionID;
  let sessionCache = messageInjectionCache.get(cacheKey);
  if (sessionCache) messageInjectionCache.delete(cacheKey);
  else sessionCache = new Map();
  messageInjectionCache.set(cacheKey, sessionCache);
  trimOldest(messageInjectionCache, MAX_MESSAGE_INJECTION_CACHE_SESSIONS);
  return sessionCache;
};

export const setSessionMessageInjectionCacheEntry = (
  sessionCache,
  messageID,
  value,
  { preserveMessageIDs = new Set(), evictionSnapshot = null } = {},
) => {
  sessionCache.delete(messageID);
  sessionCache.set(messageID, value);
  while (sessionCache.size > MAX_MESSAGE_INJECTION_CACHE_ENTRIES) {
    const oldestMessageID = [...sessionCache.keys()].find((id) =>
      !preserveMessageIDs.has(id)
      && (!evictionSnapshot || (evictionSnapshot.has(id) && evictionSnapshot.get(id) === sessionCache.get(id))),
    );
    if (!oldestMessageID) break;
    sessionCache.delete(oldestMessageID);
  }
};

const createSessionFinalizationMutex = () => {
  const tails = new Map();
  return async (sessionID) => {
    if (!sessionID) return () => {};
    const key = String(sessionID);
    const previous = tails.get(key) || Promise.resolve();
    let releaseOwner = () => {};
    const owner = new Promise((resolve) => { releaseOwner = resolve; });
    tails.set(key, owner);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseOwner();
      if (tails.get(key) === owner) tails.delete(key);
    };
  };
};

const createAttemptMetadata = (getPromptCounter) => {
  const attemptStartedAt = new Map();
  return (identity, sessionID = null, promptNumber = getPromptCounter()) => ({
    attempt_id: identity.attemptId,
    started_at: (() => {
      const existing = attemptStartedAt.get(identity.attemptId);
      if (existing) return existing;
      const created = new Date().toISOString();
      attemptStartedAt.set(identity.attemptId, created);
      trimOldest(attemptStartedAt, MAX_ATTEMPT_ENTRIES);
      return created;
    })(),
    source: "opencode",
    ...(sessionID ? { stream_id: String(sessionID), source_session_id: String(sessionID) } : {}),
    ...(promptNumber > 0 ? { prompt_number: promptNumber } : {}),
    request_id: identity.requestId,
  });
};

const createSkipRecorder = ({
  createIdentity,
  emptyQueryHash,
  runPromptPackLedger,
  attemptMetadata,
  getPromptCounter,
  defaultSurface,
}) => {
  const disabledInjectionRecorded = new Set();
  const latestPolicySkips = new Map();
  let skippedAttemptCounter = 0;
  const record = (failureCode, sessionID = null, surface = defaultSurface, requestKey = null) => {
    const memoKey = `${surface}:${String(sessionID || "unknown")}`;
    if (requestKey) {
      const signature = `${requestKey}:${failureCode}`;
      if (latestPolicySkips.get(memoKey) === signature) return null;
      latestPolicySkips.delete(memoKey);
      latestPolicySkips.set(memoKey, signature);
      trimOldest(latestPolicySkips, MAX_MESSAGE_INJECTION_CACHE_SESSIONS);
    }
    if (failureCode === "injection_disabled" && disabledInjectionRecorded.has(memoKey)) return null;
    if (failureCode === "injection_disabled") disabledInjectionRecorded.add(memoKey);
    const eventKey = requestKey
      || (failureCode === "injection_disabled" ? "once" : `event-${++skippedAttemptCounter}`);
    const identity = createIdentity({
      sessionID: sessionID || "unknown",
      requestKey: `${failureCode}:${eventKey}`,
      surface,
      promptNumber: getPromptCounter(),
      queryHash: emptyQueryHash,
    });
    void runPromptPackLedger({
      action: "record",
      ...attemptMetadata(identity, sessionID),
      retrieval_status: "skipped",
      failure_code: failureCode,
      failure_stage: "policy",
    });
    return identity.attemptId;
  };
  return {
    record,
    startSession: () => {
      disabledInjectionRecorded.delete("message:unknown");
      disabledInjectionRecorded.delete("system:unknown");
      skippedAttemptCounter = 0;
    },
    clearSession: (sessionID) => {
      disabledInjectionRecorded.delete(`message:${sessionID}`);
      disabledInjectionRecorded.delete(`system:${sessionID}`);
      latestPolicySkips.delete(`message:${sessionID}`);
      latestPolicySkips.delete(`system:${sessionID}`);
    },
  };
};

const createCacheReuseRecorder = ({
  createIdentity,
  emptyQueryHash,
  runPromptPackLedger,
  attemptMetadata,
  getPromptCounter,
}) => (cached, { messageId, sessionID, surface = "message" } = {}) => {
  cached.reuseCount = (cached.reuseCount || 0) + 1;
  const promptNumber = cached.promptNumber || getPromptCounter();
  const identity = createIdentity({
    sessionID: sessionID || "unknown",
    requestKey: `${messageId || "unknown"}:cache:${cached.reuseCount}`,
    surface,
    promptNumber,
    queryHash: cached.queryHash || emptyQueryHash,
  });
  const ready = runPromptPackLedger({
    action: "cache_reuse",
    ...attemptMetadata(identity, sessionID, promptNumber),
    original_attempt_id: cached.attemptId,
  });
  return { attemptId: identity.attemptId, ready };
};

const createDeliveryConfirmer = (runPromptPackLedger) =>
  (attemptId, deliveryStatus = "handed_off", evaluation) => {
    const delivery = { action: "delivery", attempt_id: attemptId, delivery_status: deliveryStatus };
    void runPromptPackLedger({ ...delivery, ...evaluation }).then((result) => {
      if (
        evaluation
        && result?.transport === "viewer"
        && result.failureKind === "viewer_contract_unsupported"
      ) {
        return runPromptPackLedger(delivery, { viewerOnly: true });
      }
      if (evaluation && result?.transport === "cli" && result.exitCode !== 0) {
        return runPromptPackLedger(delivery);
      }
    }).catch(() => {});
  };

const completeDeferredDelivery = async ({
  status,
  commits,
  pending,
  measurements,
  dispatch,
  recordMeasurement,
}) => {
  const tasks = [];
  for (const commit of commits.splice(0)) {
    if (status === "handed_off") tasks.push(commit());
  }
  for (const confirmation of pending.splice(0)) dispatch(confirmation);
  for (const measurement of measurements.splice(0)) {
    const finalized = status === "handed_off" ? measurement : {
      ...measurement, reason: "delivery_failed", new_tokens: 0, retained_tokens: 0,
    };
    tasks.push(recordMeasurement(finalized));
  }
  await Promise.all(tasks);
};

const createDeferredTransformDelivery = ({
  confirmPromptPackDelivery,
  recordMeasurement,
  acquireSessionFinalization,
}) => {
  let completion = null;
  let finalizationReady = null;
  let releaseFinalization = null;
  const pending = [];
  const commits = [];
  const measurements = [];
  const dispatch = ([attemptId, status, evaluation]) => {
    const deliveryStatus = completion === "failed" && (!status || status === "handed_off")
      ? "failed"
      : status;
    confirmPromptPackDelivery(attemptId, deliveryStatus, evaluation);
  };
  const beginFinalization = async (sessionID) => {
    if (!finalizationReady) {
      finalizationReady = acquireSessionFinalization(sessionID).then((release) => {
        releaseFinalization = release;
      });
    }
    await finalizationReady;
  };
  const finish = async (status = "handed_off") => {
    if (completion) return;
    completion = status;
    try {
      await completeDeferredDelivery({
        status, commits, pending, measurements, dispatch, recordMeasurement,
      });
    } finally {
      releaseFinalization?.();
      releaseFinalization = null;
    }
  };
  return {
    commit: (commit) => { commits.push(commit); },
    recordMeasurement: (measurement) => { measurements.push(measurement); },
    beginFinalization,
    finish,
    complete: finish,
    confirm: (...confirmation) => {
      if (completion) dispatch(confirmation);
      else pending.push(confirmation);
    },
  };
};

const createTransformDeliveryFactory = ({ confirmPromptPackDelivery, logLine }) => {
  const acquireSessionFinalization = createSessionFinalizationMutex();
  const recordMeasurement = (measurement) => logLine(`inject.recall ${JSON.stringify(measurement)}`);
  return (deferred) => {
    if (!deferred) {
      return {
        complete: undefined,
        finish: async () => {},
        beginFinalization: async () => {},
        confirm: confirmPromptPackDelivery,
        recordMeasurement,
      };
    }
    return createDeferredTransformDelivery({
      confirmPromptPackDelivery, recordMeasurement, acquireSessionFinalization,
    });
  };
};

const createRetryArtifactState = () => {
  const promptPackRetryCounts = new Map();
  const successfulPromptPackArtifacts = new Map();
  return {
    advancePromptPackRetryIdentity: (attemptKey) => {
      promptPackRetryCounts.set(attemptKey, (promptPackRetryCounts.get(attemptKey) || 0) + 1);
      trimOldest(promptPackRetryCounts, MAX_ATTEMPT_ENTRIES);
    },
    getPromptPackRetryCount: (attemptKey) => promptPackRetryCounts.get(attemptKey) || 0,
    getSuccessfulPromptPackArtifact: (attemptKey) => successfulPromptPackArtifacts.get(attemptKey),
    rememberSuccessfulPromptPackArtifact: (attemptKey, retryCount, fingerprint) => {
      successfulPromptPackArtifacts.delete(attemptKey);
      successfulPromptPackArtifacts.set(attemptKey, { retryCount, fingerprint });
      trimOldest(successfulPromptPackArtifacts, MAX_ATTEMPT_ENTRIES);
    },
  };
};

export const createRecallLifecycle = ({
  createIdentity,
  emptyQueryHash,
  runPromptPackLedger,
  logLine,
  getPromptCounter,
  defaultSurface,
}) => {
  const injectionToastShown = new Set();
  const messageInjectionCache = new Map();
  const emptyRecallCache = new Map();
  const attemptMetadata = createAttemptMetadata(getPromptCounter);
  const shared = {
    createIdentity, emptyQueryHash, runPromptPackLedger, attemptMetadata, getPromptCounter,
  };
  const skipRecorder = createSkipRecorder({ ...shared, defaultSurface });
  const confirmPromptPackDelivery = createDeliveryConfirmer(runPromptPackLedger);
  const retryArtifacts = createRetryArtifactState();
  return {
    injectionToastShown,
    messageInjectionCache,
    emptyRecallCache,
    attemptMetadata,
    recordSkippedPromptPack: skipRecorder.record,
    recordCachedPromptPack: createCacheReuseRecorder(shared),
    confirmPromptPackDelivery,
    createTransformDelivery: createTransformDeliveryFactory({ confirmPromptPackDelivery, logLine }),
    ...retryArtifacts,
    startSession: skipRecorder.startSession,
    clearSession: (sessionID) => {
      injectionToastShown.delete(sessionID);
      messageInjectionCache.delete(sessionID);
      emptyRecallCache.delete(sessionID);
      skipRecorder.clearSession(sessionID);
    },
  };
};
