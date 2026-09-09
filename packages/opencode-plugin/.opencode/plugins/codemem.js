import { tool } from "@opencode-ai/plugin";

import { createRuntimeHost, createRuntimeLocation } from "../lib/host-contract.js";
import {
  __testUtils,
  buildInjectionToastMessage,
  createCodememRuntime,
} from "../lib/runtime.js";

const extractV1SessionID = (event) => {
  if (!event || typeof event !== "object") return null;
  const properties = event.properties;
  if (!properties || typeof properties !== "object") return null;
  if (typeof properties.sessionID === "string") return properties.sessionID;
  if (typeof properties.info?.sessionID === "string") return properties.info.sessionID;
  if (typeof properties.part?.sessionID === "string") return properties.part.sessionID;
  if (
    ["session.created", "session.updated", "session.deleted"].includes(event.type)
    && typeof properties.info?.id === "string"
  ) {
    return properties.info.id;
  }
  return null;
};

const extractV1HookSessionID = (input) => {
  if (!input || typeof input !== "object") return null;
  return input.sessionID
    || input.sessionId
    || input.session?.id
    || input.session?.sessionID
    || input.properties?.sessionID
    || null;
};

const translateV1Event = (event) => ({
  type: event?.type || "unknown",
  sessionID: extractV1SessionID(event),
  messageInfo: event?.properties?.info || null,
  part: event?.properties?.part || null,
  usage: event?.properties?.usage || event?.usage || null,
  raw: event,
});

const translateV1PromptInput = (input) => ({
  sessionID: input.sessionID,
});

const translateV1ToolResult = (input, output) => ({
  input: {
    sessionID: input.sessionID,
    tool: input.tool,
    args: input.args,
  },
  output: {
    output: output.output,
  },
});

const createV1Tool = (definition) => {
  const args = {};
  for (const [name, argument] of Object.entries(definition.args)) {
    if (argument.type !== "number") {
      throw new Error(`Unsupported OpenCode 1 tool argument: ${name}:${argument.type}`);
    }
    const schema = tool.schema.number();
    args[name] = argument.optional ? schema.optional() : schema;
  }
  return tool({
    description: definition.description,
    args,
    execute: definition.execute,
  });
};

const createOpenCodeV1Adapter = async ({ project, client, directory, worktree }) => {
  const runtime = await createCodememRuntime({
    location: createRuntimeLocation({ project, directory, worktree }),
    host: createRuntimeHost({
      log: (entry) => client.app.log({ body: entry }),
      notify: client.tui?.showToast
        ? (notice) => client.tui.showToast({ body: notice })
        : null,
    }),
  });
  if (!runtime) return {};

  const memoryTools = Object.fromEntries(
    Object.entries(runtime.tools).map(([name, definition]) => [name, createV1Tool(definition)]),
  );

  return {
    dispose: runtime.dispose,
    "experimental.session.compacting": (input) => runtime.handleCompacting({
      sessionID: extractV1HookSessionID(input),
    }),
    "experimental.chat.messages.transform": (input, output) => runtime.transformMessages(
      translateV1PromptInput(input),
      output,
    ),
    "experimental.chat.system.transform": (input, output) => runtime.transformSystem(
      translateV1PromptInput(input),
      output,
    ),
    event: ({ event }) => runtime.handleEvent(translateV1Event(event)),
    "tool.execute.after": (input, output) => {
      const translated = translateV1ToolResult(input, output);
      return runtime.handleToolResult(translated.input, translated.output);
    },
    tool: memoryTools,
  };
};

export const CodememPlugin = createOpenCodeV1Adapter;
export default CodememPlugin;

/**
 * @deprecated Use CodememPlugin.
 * Keep this reference-identical: OpenCode deduplicates plugin exports by identity.
 */
export const OpencodeMemPlugin = CodememPlugin;
export { __testUtils, buildInjectionToastMessage };
export const __v1AdapterTestUtils = {
  createV1Tool,
  extractV1HookSessionID,
  extractV1SessionID,
  translateV1Event,
  translateV1ToolResult,
};
