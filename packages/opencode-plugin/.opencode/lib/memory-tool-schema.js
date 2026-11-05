/**
 * Convert the memory tool JSON Schemas to Zod for OpenCode 1, whose plugin
 * tools only accept Zod argument shapes. Only the subset the shared contracts
 * use is supported; any other keyword throws at registration so a contract
 * change cannot silently lose validation.
 */

const ANNOTATIONS = ["description", "default"];
const ALLOWED_KEYWORDS = {
  object: ["type", "properties", "required", ...ANNOTATIONS],
  string: ["type", "enum", ...ANNOTATIONS],
  number: ["type", "minimum", "maximum", ...ANNOTATIONS],
  integer: ["type", "minimum", "maximum", ...ANNOTATIONS],
  boolean: ["type", ...ANNOTATIONS],
  array: ["type", "items", "maxItems", ...ANNOTATIONS],
  anyOf: ["anyOf", ...ANNOTATIONS],
};

const isRecord = (value) => value != null && typeof value === "object" && !Array.isArray(value);

const schemaKind = (schema) => (Array.isArray(schema.anyOf) ? "anyOf" : schema.type);

const assertKnownKeywords = (schema, path) => {
  if (!isRecord(schema)) throw new TypeError(`Unsupported memory tool schema at ${path}: not an object`);
  const kind = schemaKind(schema);
  const allowed = ALLOWED_KEYWORDS[kind];
  if (!allowed) throw new TypeError(`Unsupported memory tool schema type at ${path}: ${String(kind)}`);
  const unknown = Object.keys(schema).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new TypeError(`Unsupported memory tool schema keyword at ${path}: ${unknown.join(", ")}`);
  }
  return kind;
};

const withBounds = (base, schema) => {
  let result = base;
  if (schema.minimum !== undefined) result = result.min(schema.minimum);
  if (schema.maximum !== undefined) result = result.max(schema.maximum);
  return result;
};

const stringSchema = (z, schema, path) => {
  if (schema.enum === undefined) return z.string();
  if (!Array.isArray(schema.enum) || !schema.enum.every((value) => typeof value === "string")) {
    throw new TypeError(`Unsupported memory tool enum at ${path}: only string enums are supported`);
  }
  return z.enum(schema.enum);
};

const arraySchema = (z, schema, path) => {
  const items = convertSchema(z, schema.items, `${path}[]`);
  const array = z.array(items);
  return schema.maxItems === undefined ? array : array.max(schema.maxItems);
};

const anyOfSchema = (z, schema, path) => {
  const variants = schema.anyOf.map((variant, index) => convertSchema(z, variant, `${path}|${index}`));
  if (variants.length < 2) throw new TypeError(`Unsupported memory tool anyOf at ${path}: needs two variants`);
  return z.union(variants);
};

const BASE_CONVERTERS = {
  string: stringSchema,
  number: (z, schema) => withBounds(z.number(), schema),
  integer: (z, schema) => withBounds(z.number().int(), schema),
  boolean: (z) => z.boolean(),
  array: arraySchema,
  anyOf: anyOfSchema,
  object: (z, schema, path) => z.object(convertObjectShape(z, schema, path)),
};

const convertSchema = (z, schema, path) => {
  const kind = assertKnownKeywords(schema, path);
  let result = BASE_CONVERTERS[kind](z, schema, path);
  if (typeof schema.description === "string") result = result.describe(schema.description);
  return result;
};

const convertProperty = (z, schema, { path, required }) => {
  const base = convertSchema(z, schema, path);
  // Defaults mirror the MCP server's Zod schemas, so a defaulted value reaches
  // the handler exactly as it would through stdio MCP.
  if (Object.hasOwn(schema, "default")) return base.default(schema.default);
  return required ? base : base.optional();
};

/** Convert an object schema to a Zod raw shape (OpenCode 1 `tool({ args })`). */
export const convertObjectShape = (z, schema, path = "input") => {
  const kind = assertKnownKeywords(schema, path);
  if (kind !== "object" || !isRecord(schema.properties)) {
    throw new TypeError(`Unsupported memory tool schema at ${path}: expected an object with properties`);
  }
  const required = new Set(schema.required ?? []);
  for (const name of required) {
    if (!Object.hasOwn(schema.properties, name)) {
      throw new TypeError(`Memory tool schema at ${path} requires unknown property ${name}`);
    }
  }
  return Object.fromEntries(
    Object.entries(schema.properties).map(([name, property]) => [
      name,
      convertProperty(z, property, { path: `${path}.${name}`, required: required.has(name) }),
    ]),
  );
};
