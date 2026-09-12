/**
 * @typedef {object} CodememLocation
 * @property {unknown} project
 * @property {string | undefined} directory
 * @property {string | undefined} worktree
 */

export const V2_ADAPTER_DIAGNOSTICS = Object.freeze({
  contextCleanupTimeout: "v2_context_cleanup_timeout",
  contextRecallFailed: "v2_context_recall_failed",
  eventCaptureFailed: "v2_event_capture_failed",
  eventStreamCleanupTimeout: "v2_event_stream_cleanup_timeout",
  eventStreamEndedUnexpectedly: "v2_event_stream_ended_unexpectedly",
  eventStreamFailed: "v2_event_stream_failed",
  registrationCleanupTimeout: "v2_registration_cleanup_timeout",
  runtimeCleanupTimeout: "v2_runtime_cleanup_timeout",
  toolCaptureFailed: "v2_tool_capture_failed",
});

/**
 * @typedef {object} CodememHost
 * @property {(entry: {service: string, level: string, message: string, extra: object}) => Promise<unknown>} log
 * @property {((notice: {message: string, variant: string}) => Promise<unknown>) | null} notify
 * @property {((prompt: {sessionID: string, messageID: string, text: string}) => Promise<object | null>) | null} resolveCaptureContext
 */

/**
 * @typedef {object} CodememCapturedEvent
 * Event types use the OpenCode 1 vocabulary as the runtime's canonical wire names.
 * Adapters retain the host-native event in `raw` for bounded diagnostic logging.
 * @property {string} type
 * @property {string | null} sessionID
 * @property {unknown} messageInfo
 * @property {unknown} part
 * @property {unknown} usage
 * @property {unknown} raw
 */

/**
 * @typedef {object} CodememPromptContext
 * @property {string | null} sessionID
 */

/**
 * @typedef {object} CodememMessageTransformOptions
 * @property {boolean} [deferDeliveryConfirmation] Let the adapter confirm whether host mutation succeeded.
 * @property {boolean} [enableSystemSurface] Route V2 context through the message cache before adapting it to system parts.
 * @property {boolean} [pruneAbsentCacheEntries] Remove replay entries absent from this transform's history.
 * @property {boolean} [requireLatestUserMessageID] Skip recall unless the latest user message has a host ID.
 */

/**
 * @typedef {object} CodememMessageTransformResult
 * @property {boolean} applied
 * @property {"message" | "system"} surface Adapters must route injected output to this surface.
 * @property {((status?: "handed_off" | "failed") => void) | undefined} [completeDelivery]
 */

/**
 * @typedef {object} CodememToolResult
 * @property {string | null} [id] Stable host tool-call identity; OpenCode V1 omits it.
 * @property {string | null} sessionID
 * @property {string} tool
 * @property {object} args
 */

/**
 * @typedef {object} CodememRuntime
 * @property {() => void} deactivate
 * @property {() => Promise<void>} dispose
 * @property {(context: CodememPromptContext) => Promise<void>} handleCompacting
 * @property {(input: CodememPromptContext, output: object, options?: CodememMessageTransformOptions) => Promise<CodememMessageTransformResult>} transformMessages
 * @property {(input: CodememPromptContext, output: object) => Promise<void>} transformSystem
 * @property {(event: CodememCapturedEvent) => Promise<void>} handleEvent
 * @property {(input: CodememToolResult, output: object) => Promise<void>} handleToolResult
 * @property {(code: string) => Promise<void>} reportDiagnostic
 * @property {Record<string, {description: string, args: object, execute: Function}>} tools
 */

export const createRuntimeLocation = ({ project, directory, worktree }) => ({
  project,
  directory,
  worktree,
});

export const createRuntimeHost = ({ log, notify = null, resolveCaptureContext = null }) => ({
  log,
  notify,
  resolveCaptureContext,
});
