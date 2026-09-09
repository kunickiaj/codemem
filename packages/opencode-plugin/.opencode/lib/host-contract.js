/**
 * @typedef {object} CodememLocation
 * @property {unknown} project
 * @property {string | undefined} directory
 * @property {string | undefined} worktree
 */

/**
 * @typedef {object} CodememHost
 * @property {(entry: {service: string, level: string, message: string, extra: object}) => Promise<unknown>} log
 * @property {((notice: {message: string, variant: string}) => Promise<unknown>) | null} notify
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
 * @typedef {object} CodememToolResult
 * @property {string | null} sessionID
 * @property {string} tool
 * @property {object} args
 */

/**
 * @typedef {object} CodememRuntime
 * @property {() => void} dispose
 * @property {(context: CodememPromptContext) => Promise<void>} handleCompacting
 * @property {(input: CodememPromptContext, output: object) => Promise<void>} transformMessages
 * @property {(input: CodememPromptContext, output: object) => Promise<void>} transformSystem
 * @property {(event: CodememCapturedEvent) => Promise<void>} handleEvent
 * @property {(input: CodememToolResult, output: object) => Promise<void>} handleToolResult
 * @property {Record<string, {description: string, args: object, execute: Function}>} tools
 */

export const createRuntimeLocation = ({ project, directory, worktree }) => ({
  project,
  directory,
  worktree,
});

export const createRuntimeHost = ({ log, notify = null }) => ({
  log,
  notify,
});
