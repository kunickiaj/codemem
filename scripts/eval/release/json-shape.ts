import type { Digest, JsonValue } from "./types.js";

const COMMIT_PATTERN = /^[a-f0-9]{40}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function jsonObject(value: unknown, path: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError(`${path} must be a JSON object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null)
		throw new TypeError(`${path} must be a plain JSON object`);
	return value as Record<string, unknown>;
}

export function exactKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
	path: string,
): void {
	const unknown = Object.keys(value).filter((key) => !keys.includes(key));
	if (unknown.length > 0)
		throw new TypeError(`${path} contains unknown field(s): ${unknown.toSorted().join(", ")}`);
	const missing = keys.filter((key) => !Object.hasOwn(value, key));
	if (missing.length > 0) throw new TypeError(`${path} is missing field(s): ${missing.join(", ")}`);
}

export function nonEmptyTrimmedString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() !== value || value.length === 0)
		throw new TypeError(`${path} must be a non-empty trimmed string`);
	return value;
}

export function safeInteger(value: unknown, path: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum)
		throw new TypeError(`${path} must be a safe integer >= ${minimum}`);
	return value as number;
}

export function finiteNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value))
		throw new TypeError(`${path} must be finite`);
	return value;
}

export function commitId(value: unknown, path: string): string {
	if (typeof value !== "string" || !COMMIT_PATTERN.test(value))
		throw new TypeError(`${path} must be a lowercase 40-character commit ID`);
	return value;
}

export function sha256Digest(value: unknown, path: string): Digest {
	if (typeof value !== "string" || !DIGEST_PATTERN.test(value))
		throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
	return value as Digest;
}

export function parseJson(source: string, label: string): unknown {
	try {
		return JSON.parse(source) as unknown;
	} catch {
		throw new TypeError(`${label} must be valid JSON`);
	}
}

export function jsonValue(
	value: unknown,
	path: string,
	ancestors = new WeakSet<object>(),
): JsonValue {
	if (value === null || typeof value === "boolean" || typeof value === "string") return value;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError(`${path} must not contain non-finite numbers`);
		return value;
	}
	if (Array.isArray(value)) {
		if (ancestors.has(value)) throw new TypeError(`${path} must not contain circular references`);
		ancestors.add(value);
		const expected = new Set([
			"length",
			...Array.from({ length: value.length }, (_, index) => String(index)),
		]);
		if (Reflect.ownKeys(value).some((key) => typeof key !== "string" || !expected.has(key)))
			throw new TypeError(`${path} must not contain non-JSON array properties`);
		const parsed = Array.from({ length: value.length }, (_, index) => {
			if (!(index in value)) throw new TypeError(`${path} must not contain sparse array entries`);
			return jsonValue(value[index], `${path}[${index}]`, ancestors);
		});
		ancestors.delete(value);
		return parsed;
	}
	const object = jsonObject(value, path);
	if (ancestors.has(object)) throw new TypeError(`${path} must not contain circular references`);
	ancestors.add(object);
	const descriptors = Object.getOwnPropertyDescriptors(object);
	if (
		Reflect.ownKeys(object).some((key) => {
			if (typeof key !== "string") return true;
			const descriptor = descriptors[key];
			return !descriptor?.enumerable || !("value" in descriptor);
		})
	) {
		throw new TypeError(`${path} must contain only enumerable JSON properties`);
	}
	const parsed = Object.fromEntries(
		Object.keys(object).map((key) => [
			key,
			jsonValue(descriptors[key]?.value, `${path}.${key}`, ancestors),
		]),
	);
	ancestors.delete(object);
	return parsed;
}
