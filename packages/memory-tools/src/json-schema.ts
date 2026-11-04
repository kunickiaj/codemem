/**
 * Minimal JSON Schema builders for tool input contracts. Kept deliberately
 * small: hosts (OpenCode, pi) accept plain JSON Schema objects, and the MCP
 * parity test compares against the SDK's zod-derived output.
 */

export type JsonSchema = Record<string, unknown>;

/**
 * Matches the MCP server's zod-derived object schemas, which leave
 * `additionalProperties` unset: unknown arguments are stripped, not rejected.
 */
export interface ObjectSchema extends JsonSchema {
	type: "object";
	properties: Record<string, JsonSchema>;
	required?: string[];
}

function withDescription(schema: JsonSchema, description?: string): JsonSchema {
	return description ? { ...schema, description } : schema;
}

export function string(description?: string): JsonSchema {
	return withDescription({ type: "string" }, description);
}

export function boolean(description?: string): JsonSchema {
	return withDescription({ type: "boolean" }, description);
}

export function number(
	options: { minimum?: number; maximum?: number; description?: string } = {},
): JsonSchema {
	const { description, ...bounds } = options;
	return withDescription({ type: "number", ...bounds }, description);
}

export function integer(
	options: { minimum?: number; maximum?: number; description?: string } = {},
): JsonSchema {
	const { description, ...bounds } = options;
	return withDescription({ type: "integer", ...bounds }, description);
}

export function stringArray(description?: string): JsonSchema {
	return withDescription({ type: "array", items: { type: "string" } }, description);
}

export function integerArray(
	options: { maxItems?: number; description?: string } = {},
): JsonSchema {
	const { description, ...bounds } = options;
	return withDescription({ type: "array", items: { type: "integer" }, ...bounds }, description);
}

export function stringEnum(values: readonly string[], description?: string): JsonSchema {
	return withDescription({ type: "string", enum: [...values] }, description);
}

export function anyOf(variants: JsonSchema[], description?: string): JsonSchema {
	return withDescription({ anyOf: variants }, description);
}

export function withDefault(schema: JsonSchema, value: unknown): JsonSchema {
	return { ...schema, default: value };
}

/** Build an object schema; `required` lists the properties without defaults that callers must send. */
export function object(
	properties: Record<string, JsonSchema>,
	required: string[] = [],
): ObjectSchema {
	const schema: ObjectSchema = { type: "object", properties };
	if (required.length > 0) schema.required = required;
	return schema;
}
