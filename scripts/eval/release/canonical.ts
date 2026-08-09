import { createHash } from "node:crypto";
import { parseProjectedCorpus } from "./corpus.js";
import type { Digest, JsonValue, ProjectedCorpusV1 } from "./types.js";

export function compareCodePoints(left: string, right: string): number {
	const leftPoints = Array.from(left, (value) => value.codePointAt(0) ?? -1);
	const rightPoints = Array.from(right, (value) => value.codePointAt(0) ?? -1);
	const length = Math.min(leftPoints.length, rightPoints.length);
	for (let index = 0; index < length; index += 1) {
		const difference = (leftPoints[index] ?? -1) - (rightPoints[index] ?? -1);
		if (difference !== 0) return difference;
	}
	return leftPoints.length - rightPoints.length;
}

function normalized(value: JsonValue): JsonValue {
	if (typeof value === "string") return value.replaceAll("\r\n", "\n").normalize("NFC");
	if (Array.isArray(value)) return value.map(normalized);
	if (value && typeof value === "object") {
		const entries = Object.entries(value).map(
			([key, child]) => [key.normalize("NFC"), normalized(child)] as const,
		);
		if (new Set(entries.map(([key]) => key)).size !== entries.length)
			throw new TypeError("Canonical JSON object keys must be unique after normalization");
		return Object.fromEntries(entries);
	}
	return value;
}

export function serialize(value: JsonValue): string {
	const clean = normalized(value);
	if (Array.isArray(clean)) return `[${clean.map(serialize).join(",")}]`;
	if (clean && typeof clean === "object")
		return `{${Object.entries(clean)
			.toSorted(([left], [right]) => compareCodePoints(left, right))
			.map(([key, child]) => `${JSON.stringify(key)}:${serialize(child)}`)
			.join(",")}}`;
	return JSON.stringify(clean) ?? "null";
}

export function digest(value: JsonValue): Digest {
	return `sha256:${createHash("sha256").update(serialize(value), "utf8").digest("hex")}`;
}

export function project(value: unknown): ProjectedCorpusV1 {
	const corpus = parseProjectedCorpus(value);
	const rows = corpus.rows
		.map((row) => ({
			case_id: row.case_id.normalize("NFC"),
			ordinal: row.ordinal,
			row_type: row.row_type.normalize("NFC"),
			value: normalized(row.value),
		}))
		.toSorted(
			(left, right) =>
				compareCodePoints(left.case_id, right.case_id) ||
				left.ordinal - right.ordinal ||
				compareCodePoints(left.row_type, right.row_type),
		);
	for (let index = 1; index < rows.length; index += 1) {
		const previous = rows[index - 1];
		const current = rows[index];
		if (
			previous &&
			current &&
			previous.case_id === current.case_id &&
			previous.ordinal === current.ordinal &&
			previous.row_type === current.row_type
		) {
			throw new TypeError(
				"Projected corpus rows must have unique case_id, ordinal, and row_type keys",
			);
		}
	}
	return { schema_version: 1, rows };
}

export function digestCorpus(corpus: unknown): Digest {
	return digest(project(corpus) as unknown as JsonValue);
}
