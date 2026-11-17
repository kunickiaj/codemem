/**
 * Caller context for a codemem MCP server that several project directories
 * share (OpenCode `pool: true`). A shared server has one fixed working
 * directory, so it started with `--caller-context required` and declares a
 * `_codemem_caller` argument on every tool. This module fills that argument
 * in from the plugin instance that runs the call and hides it from the model.
 * Tools that do not declare the argument are left alone, so a private
 * per-project server is unaffected. So are tools of any other MCP server: the
 * argument carries the project path and session ID, which only the server
 * configured under the name `codemem` should receive.
 */

import { randomUUID } from "node:crypto";

export const CALLER_ARGUMENT = "_codemem_caller";
const CODEMEM_SERVER = "codemem";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The host reports an MCP tool's server name as its namespace. Tool IDs are
// not enough: a server named `codemem_other` produces IDs with the same prefix.
const declaresCaller = (tool) =>
  tool?.options?.namespace === CODEMEM_SERVER
  && isObject(tool.input?.properties)
  && CALLER_ARGUMENT in tool.input.properties;

const cleanProject = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * Inner calls of one Code Mode block share the block's call ID, so a sequence
 * number keeps each call distinct. The per-instance nonce keeps a provider
 * that reuses call IDs from repeating an identity after the plugin reloads.
 * A redelivery of one dispatched call keeps the value it was dispatched with.
 */
export const createCallSequence = (nonce = randomUUID().slice(0, 8)) => {
  let next = 0;
  return () => {
    next += 1;
    return `${nonce}:${next}`;
  };
};

/**
 * @param {{ list(): readonly object[], update(id: string, update: (tool: any) => void): void }} editor
 * @param {{ directory: string, nextSequence: () => string, readEnvProject?: () => unknown }} options
 * @returns {string[]} IDs of the tools that now receive the caller argument.
 */
export const addCallerToPooledMcpTools = (editor, options) => {
  const { directory, nextSequence, readEnvProject = () => process.env.CODEMEM_PROJECT } = options;
  // Hosts whose tool editor cannot list or update tools have no pooling either.
  if (typeof editor.list !== "function" || typeof editor.update !== "function") return [];
  const pooled = editor.list().filter(declaresCaller);
  for (const tool of pooled) {
    editor.update(tool.id, (target) => {
      const { [CALLER_ARGUMENT]: _hidden, ...properties } = target.input.properties;
      target.input = { ...target.input, properties };
      const execute = target.execute;
      // The plugin's value always replaces one that arrived with the call.
      target.execute = (input, context) => execute({
        ...input,
        [CALLER_ARGUMENT]: {
          directory,
          env_project: cleanProject(readEnvProject()),
          session_id: context.sessionID,
          request_id: `${context.id}:${nextSequence()}`,
        },
      }, context);
    });
  }
  return pooled.map((tool) => tool.id);
};
