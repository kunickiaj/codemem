import { exactKeys, jsonObject, jsonValue, parseJson } from "./json-shape.js";
import type { ProjectedCorpusV1 } from "./types.js";

function identifier(value: unknown, path: string): string {
	if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
	const normalized = value.replaceAll("\r\n", "\n").normalize("NFC").trim();
	if (!normalized) throw new TypeError(`${path} must be non-empty after normalization`);
	return normalized;
}

export function parseProjectedCorpus(value: unknown): ProjectedCorpusV1 {
	const root = jsonObject(value, "projected corpus");
	exactKeys(root, ["schema_version", "rows"], "projected corpus");
	if (root.schema_version !== 1) throw new TypeError("projected corpus.schema_version must be 1");
	if (!Array.isArray(root.rows)) throw new TypeError("projected corpus.rows must be an array");
	return {
		schema_version: 1,
		rows: root.rows.map((entry, index) => {
			const path = `projected corpus.rows[${index}]`;
			const row = jsonObject(entry, path);
			exactKeys(row, ["case_id", "ordinal", "row_type", "value"], path);
			if (!Number.isSafeInteger(row.ordinal) || (row.ordinal as number) < 0)
				throw new TypeError(`${path}.ordinal must be a safe nonnegative integer`);
			return {
				case_id: identifier(row.case_id, `${path}.case_id`),
				ordinal: row.ordinal as number,
				row_type: identifier(row.row_type, `${path}.row_type`),
				value: jsonValue(row.value, `${path}.value`),
			};
		}),
	};
}

export function parseProjectedCorpusJson(source: string): ProjectedCorpusV1 {
	return parseProjectedCorpus(parseJson(source, "projected corpus"));
}
