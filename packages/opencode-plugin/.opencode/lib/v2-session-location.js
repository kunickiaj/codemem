import { isAbsolute, resolve } from "node:path";

const validLocation = (value) => value
  && typeof value.directory === "string"
  && isAbsolute(value.directory)
  && (value.workspaceID === undefined
    || (typeof value.workspaceID === "string" && value.workspaceID.length > 0));

const sameLocation = (a, b) => resolve(a.directory) === resolve(b.directory)
  && (a.workspaceID ?? null) === (b.workspaceID ?? null);

/**
 * Event locations reject foreign publications early. A positive decision always
 * needs a fresh session read; never cache it across a session move.
 * Message text, tool arguments and parent-session IDs are not location evidence.
 */
export const readV2SessionOwnership = async (context, sessionID, {
  location,
  signal,
  timeoutMs,
}) => {
  if (typeof sessionID !== "string" || !sessionID.trim() || !validLocation(context.location)) {
    return "unavailable";
  }
  if (location !== undefined) {
    if (!validLocation(location)) return "unavailable";
    if (!sameLocation(context.location, location)) return "foreign";
  }
  if (typeof context.session?.get !== "function") return "unavailable";
  try {
    const session = await context.session.get({ sessionID }, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, timeoutMs))]),
    });
    if (session?.id !== sessionID || !validLocation(session.location)) return "unavailable";
    if (typeof session.projectID !== "string") return "unavailable";
    if (session.projectID !== context.location.project?.id) return "foreign";
    return sameLocation(context.location, session.location) ? "owned" : "foreign";
  } catch {
    return "unavailable";
  }
};
