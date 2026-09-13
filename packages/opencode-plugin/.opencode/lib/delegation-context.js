import { createHash } from "node:crypto";

const MAX_BINDINGS = 128;
const MAX_BRIEF_CHARS = 64_000;
const BINDING_TTL_MS = 10 * 60_000;
const LOOKUP_TIMEOUT_MS = 200;
const digest = (text) => createHash("sha256").update(text).digest("hex");
const validId = (value) => typeof value === "string" && value.length > 0 && value.length <= 256;
const normalizedPromptText = (value) => typeof value === "string" ? value.trim() : null;

// Only this V1 adapter consumes the verified task metadata contract. A session's
// parent alone says nothing about who authored a particular user-role message.
// SDK-only callers must supply a complete message snapshot. The V1 adapter also
// requires the chat hook because its SDK can expose partially persisted parts.
export const createDelegationContext = ({
  readSession, readMessage, now = Date.now, requirePromptSnapshot = false,
}) => {
  const bindings = new Map();
  const activeLookups = new Map();
  const initializedAt = now();
  let disposed = false;
  const prune = () => {
    for (const [key, binding] of bindings) {
      if (now() - binding.observedAt > BINDING_TTL_MS) bindings.delete(key);
    }
  };
  const observe = (event) => {
    if (disposed) return;
    prune();
    if (event?.type === "session.deleted") {
      const id = event.properties?.info?.id;
      for (const binding of bindings.values()) {
        if (binding.child === id || binding.parent === id) binding.closed = true;
      }
      return;
    }
    const part = event?.properties?.part;
    if (event?.type !== "message.part.updated" || part?.type !== "tool" || part.tool !== "task") return;
    const state = part.state;
    const metadata = state?.metadata;
    const input = state?.input;
    const brief = normalizedPromptText(input?.prompt);
    if (!validId(part.callID) || !validId(part.sessionID)) return;
    const key = JSON.stringify([part.sessionID, part.callID]);
    const previous = bindings.get(key);
    if (["completed", "error"].includes(state?.status)) {
      if (previous) previous.closed = true;
      else if (bindings.size < MAX_BINDINGS) bindings.set(key, { observedAt: now(), closed: true });
      return;
    }
    if (state?.status !== "running") return;
    if (!validId(metadata?.sessionId) || metadata.parentSessionId !== part.sessionID
      || metadata.sessionId === part.sessionID || !validId(input?.subagent_type)
      || !brief || input.prompt.length > MAX_BRIEF_CHARS
      || typeof input.description !== "string" || !Number.isFinite(state.time?.start)) {
      if (previous) previous.ambiguous = true;
      return;
    }
    const fingerprint = digest(JSON.stringify([metadata.sessionId, input.subagent_type, brief, state.time.start]));
    if (previous) {
      // A mutated/reused call is ambiguous; never reset its consumed message.
      if (previous.fingerprint !== fingerprint) previous.ambiguous = true;
      return;
    }
    // Do not evict a consumed call and then accept its replay as a fresh binding.
    if (bindings.size >= MAX_BINDINGS || state.time.start < initializedAt
      || now() - state.time.start > BINDING_TTL_MS) return;
    bindings.set(key, {
      fingerprint, parent: part.sessionID, child: metadata.sessionId, call: part.callID,
      agent: input.subagent_type, brief, startedAt: state.time.start,
      observedAt: now(), messageID: null, ambiguous: false,
    });
  };
  const matchSnapshot = (snapshot, { sessionID, messageID, text }, candidates) => {
    if (!snapshot || disposed) return null;
    const [session, message] = snapshot;
    const info = message?.info;
    const parts = message?.parts;
    if (session?.id !== sessionID || info?.id !== messageID || info.sessionID !== sessionID
      || info.role !== "user" || !validId(info.agent) || !Number.isFinite(info.time?.created)
      || !Array.isArray(parts) || parts.length !== 1) return null;
    const part = parts[0];
    const partText = normalizedPromptText(part?.text);
    if (part?.type !== "text" || part.synthetic || part.ignored || typeof part.text !== "string"
      || part.sessionID !== sessionID || part.messageID !== messageID || partText !== text) return null;
    prune();
    const reservedCandidates = new Set(candidates);
    const hasNewMatch = [...bindings.values()].some((binding) => !reservedCandidates.has(binding)
      && !binding.closed && binding.child === sessionID && binding.parent === session.parentID
      && binding.agent === info.agent && binding.brief === partText
      && info.time.created >= binding.startedAt);
    if (hasNewMatch) return null;
    const matches = candidates.filter((binding) => binding.child === sessionID
      && binding.parent === session.parentID
      && binding.agent === info.agent && binding.brief === partText
      && info.time.created >= binding.startedAt);
    if (matches.length !== 1) return null;
    const binding = matches[0];
    if (binding.ambiguous || (binding.messageID && binding.messageID !== messageID)) return null;
    if (requirePromptSnapshot) {
      const draft = binding.prompt;
      const draftPart = draft?.parts?.[0];
      if (draft?.message?.id !== messageID || draft.message.sessionID !== sessionID
        || draft.message.role !== info.role || draft.message.agent !== info.agent
        || draft.message.time?.created !== info.time.created || draft.parts?.length !== 1
        || draftPart?.id !== part.id || draftPart?.sessionID !== sessionID
        || draftPart?.messageID !== messageID || draftPart?.type !== "text"
        || draftPart.synthetic || draftPart.ignored
        || normalizedPromptText(draftPart.text) !== text) return null;
    }
    binding.messageID = messageID;
    return Object.freeze({
      version: 1, host: "opencode-v1", origin: "delegated_brief",
      parent_session_id: binding.parent, child_session_id: sessionID,
      task_call_id: binding.call, message_id: messageID,
      requested_agent: binding.agent, current_agent: info.agent,
      brief_sha256: digest(text),
    });
  };
  // V1 invokes this with all resolved parts before saving them individually.
  // Keep the message/parts references until lookup so later hooks' in-place
  // changes are checked too. The host persists these original objects, even if
  // a hook replaces output.message/parts. Do not fetch inside this hook.
  const observePrompt = (input, output) => {
    if (disposed) return;
    prune();
    const info = output?.message;
    if (!validId(info?.id) || info.sessionID !== input?.sessionID || info.role !== "user"
      || (input.messageID && input.messageID !== info.id)
      || (input.agent && input.agent !== info.agent)
      || !Number.isFinite(info.time?.created) || !validId(info.agent)) return;
    for (const binding of bindings.values()) {
      if (binding.closed || binding.child !== info.sessionID || binding.agent !== info.agent
        || info.time.created < binding.startedAt) continue;
      if (binding.messageID) continue;
      binding.messageID = info.id;
      const part = output.parts?.[0];
      if (output.parts?.length === 1 && part?.type === "text" && !part.synthetic && !part.ignored
        && normalizedPromptText(part.text) === binding.brief) {
        binding.prompt = { message: info, parts: output.parts };
      }
    }
  };
  const resolve = (prompt) => {
    const { sessionID, messageID } = prompt;
    const text = normalizedPromptText(prompt.text);
    if (disposed || !validId(sessionID) || !validId(messageID) || !text) return Promise.resolve(null);
    prune();
    // Reserve candidates now; later closure or TTL pruning must not invalidate
    // snapshot work admitted while the binding was current.
    const candidates = [...bindings.values()].filter((binding) => binding.child === sessionID && !binding.closed
      && (!requirePromptSnapshot || (binding.messageID === messageID && binding.prompt)));
    if (!readSession || !readMessage
      || !candidates.some((binding) => !binding.messageID || binding.messageID === messageID)) return Promise.resolve(null);
    const key = JSON.stringify([sessionID, messageID]);
    // Duplicate requests share a lookup; distinct requests cannot outgrow the binding cache.
    const existing = activeLookups.get(key);
    if (existing) return existing.text === text ? existing.promise : Promise.resolve(null);
    if (activeLookups.size >= bindings.size) return Promise.resolve(null);
    const controller = new AbortController();
    const completion = Promise.withResolvers();
    let finished = false;
    const finish = (context) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      activeLookups.delete(key);
      controller.abort();
      completion.resolve(context);
    };
    const timer = setTimeout(() => finish(null), LOOKUP_TIMEOUT_MS);
    activeLookups.set(key, { text, promise: completion.promise, cancel: () => finish(null) });
    void Promise.all([
      Promise.resolve().then(() => controller.signal.aborted ? null : readSession(sessionID, controller.signal)),
      Promise.resolve().then(() => controller.signal.aborted ? null : readMessage(sessionID, messageID, controller.signal)),
    ]).then((snapshot) => {
      if (!finished) finish(matchSnapshot(snapshot, { ...prompt, text }, candidates));
    }).catch(() => finish(null));
    return completion.promise;
  };
  return { observe, observePrompt, resolve, dispose: () => {
    disposed = true;
    for (const lookup of activeLookups.values()) lookup.cancel();
    bindings.clear();
  } };
};
