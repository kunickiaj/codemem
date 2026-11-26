// Private-text lexer for the plugin, kept self-contained because the plugin ships
// without core. It follows the same contract and shared test vectors as core's
// stripPrivate (packages/core/src/ingest-sanitize.ts):
// a private block protects text inside the single text value where it is written.
// Markers are literal `<private ...>` and `</private>` tags in any case, with
// optional whitespace and attributes, nesting by depth. An opener with no closer in
// the same value removes the rest of that value, as does a tag cut off before its
// `>`. A closer with no opener is removed and nothing else is. `<private/>`, escaped
// forms and other tag names are text. Text without markers is returned unchanged.

const TAG_NAME_CHAR = /[A-Za-z0-9_.:-]/;
const WHITESPACE = /\s/;

const skipWhitespace = (text, index) => {
  let next = index;
  while (next < text.length && WHITESPACE.test(text.charAt(next))) next += 1;
  return next;
};

/** A tag ending at `end`; an opener whose last character before `>` is `/` is self-closing. */
const tagEnding = (end, closer, lastSignificant) => {
  if (closer) return { kind: "close", end };
  return { kind: lastSignificant === "/" ? "self" : "open", end };
};

/** Where a tag ends: the first `>` outside a quoted attribute value, or cut off at the end. */
const readTagEnd = (text, start, closer) => {
  let lastSignificant = "";
  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === '"' || char === "'") {
      const closingQuote = text.indexOf(char, index + 1);
      if (closingQuote === -1) break;
      index = closingQuote;
      lastSignificant = char;
    } else if (char === ">") {
      return tagEnding(index + 1, closer, lastSignificant);
    } else if (!WHITESPACE.test(char)) {
      lastSignificant = char;
    }
  }
  return { kind: "cut", end: text.length };
};

/** The private tag starting at text[start] (a `<`), or null when it is not one. */
const readPrivateTag = (text, start) => {
  let index = skipWhitespace(text, start + 1);
  const closer = text.charAt(index) === "/";
  index = skipWhitespace(text, closer ? index + 1 : index);
  const nameStart = index;
  while (index < text.length && TAG_NAME_CHAR.test(text.charAt(index))) index += 1;
  // The name must be exactly `private`; `<private-notes>` is another tag.
  if (text.slice(nameStart, index).toLowerCase() !== "private") return null;
  return readTagEnd(text, index, closer);
};

/** Remove private blocks from one text value, scanned on its own. */
export const stripPrivate = (text) => {
  if (typeof text !== "string") return "";
  // Without the tag name there is no marker, and the text comes back unchanged.
  if (!text.toLowerCase().includes("private")) return text;
  let output = "";
  let depth = 0;
  let kept = 0;
  let index = text.indexOf("<");
  while (index !== -1) {
    const tag = readPrivateTag(text, index);
    if (!tag || tag.kind === "self") {
      index = text.indexOf("<", index + 1);
      continue;
    }
    if (depth === 0) output += text.slice(kept, index);
    if (tag.kind === "cut") return output;
    if (tag.kind === "open") depth += 1;
    else if (depth > 0) depth -= 1;
    kept = tag.end;
    index = text.indexOf("<", tag.end);
  }
  return depth === 0 ? output + text.slice(kept) : output;
};

export const hasPrivateMarker = (text) => stripPrivate(text) !== text;

/** Every string value scanned on its own; an entry whose key carries a marker is dropped. */
export const stripPrivateObj = (value) => {
  if (typeof value === "string") return stripPrivate(value);
  if (Array.isArray(value)) return value.map(stripPrivateObj);
  if (value != null && typeof value === "object") {
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (hasPrivateMarker(key)) continue;
      result[key] = stripPrivateObj(item);
    }
    return result;
  }
  return value;
};

const EVENT_METADATA_KEYS = ["cwd", "project", "started_at"];

const sanitizeEventItem = (item) => {
  const sanitized = { ...item };
  if (item.payload != null && typeof item.payload === "object") {
    sanitized.payload = stripPrivateObj(item.payload);
  }
  for (const key of EVENT_METADATA_KEYS) {
    if (typeof item[key] === "string") sanitized[key] = stripPrivate(item[key]);
  }
  return sanitized;
};

/**
 * A raw-event envelope with private blocks removed from its content: each event's
 * payload values and session metadata. Routing fields stay exactly as built.
 */
export const sanitizeRawEventEnvelope = (envelope) => {
  if (envelope == null || typeof envelope !== "object" || Array.isArray(envelope)) return envelope;
  const sanitized = sanitizeEventItem(envelope);
  if (Array.isArray(envelope.events)) {
    sanitized.events = envelope.events.map((event) =>
      event != null && typeof event === "object" && !Array.isArray(event) ? sanitizeEventItem(event) : event);
  }
  return sanitized;
};
