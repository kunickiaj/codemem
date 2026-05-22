export function jsonContent(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

export function errorContent(message: string) {
	return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }] };
}
