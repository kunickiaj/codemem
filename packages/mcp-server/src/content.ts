function parseStructuredObject(text: string): Record<string, unknown> {
	const value: unknown = JSON.parse(text);
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("MCP structured content must be a JSON object");
	}
	return value as Record<string, unknown>;
}

export function jsonContent(data: unknown) {
	const text = JSON.stringify(data);
	if (text === undefined) throw new TypeError("MCP structured content must be JSON serializable");
	return {
		content: [{ type: "text" as const, text }],
		structuredContent: parseStructuredObject(text),
	};
}

export function errorContent(message: string) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
		isError: true,
	};
}
