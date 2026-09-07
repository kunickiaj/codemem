import type { ObserverTokenUsage } from "./observer-client.js";
import {
	OBSERVER_ENVELOPE_JSON_SCHEMA,
	type ObserverEnvelopeParseResult,
	type ObserverForcedToolCall,
	parseObserverForcedToolCalls,
} from "./observer-output-schema.js";

export const OBSERVER_FORCED_TOOL_NAME = "record_memories" as const;

export const OBSERVER_FORCED_TOOL_DEFINITION = {
	name: OBSERVER_FORCED_TOOL_NAME,
	description: "Record the validated observer memory envelope for this session batch.",
	inputSchema: OBSERVER_ENVELOPE_JSON_SCHEMA,
} as const;

export interface ObserverForcedToolRequest {
	system: string;
	user: string;
	tool: typeof OBSERVER_FORCED_TOOL_DEFINITION;
	toolChoice: { name: typeof OBSERVER_FORCED_TOOL_NAME };
	parallelToolCalls: false;
}

export interface ObserverForcedToolTransportResponse {
	toolCalls: readonly ObserverForcedToolCall[];
	provider: string;
	model: string;
	elapsedMs: number | null;
	usage: ObserverTokenUsage | null;
}

export interface ObserverForcedToolTransport {
	invoke(request: ObserverForcedToolRequest): Promise<ObserverForcedToolTransportResponse>;
}

export interface ObserverForcedToolResult {
	response: ObserverForcedToolTransportResponse;
	parsed: ObserverEnvelopeParseResult;
}

export function buildObserverForcedToolRequest(
	system: string,
	user: string,
): ObserverForcedToolRequest {
	return {
		system,
		user,
		tool: OBSERVER_FORCED_TOOL_DEFINITION,
		toolChoice: { name: OBSERVER_FORCED_TOOL_NAME },
		parallelToolCalls: false,
	};
}

export async function requestObserverEnvelopeWithForcedTool(
	transport: ObserverForcedToolTransport,
	system: string,
	user: string,
): Promise<ObserverForcedToolResult> {
	const response = await transport.invoke(buildObserverForcedToolRequest(system, user));
	return { response, parsed: parseObserverForcedToolCalls(response.toolCalls) };
}
