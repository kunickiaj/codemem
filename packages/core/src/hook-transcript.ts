import {
	closeSync,
	constants,
	fstatSync,
	openSync,
	readSync,
	realpathSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_HOOK_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const HOOK_TRANSCRIPT_CHUNK_BYTES = 64 * 1024;

const HOOK_TRANSCRIPT_OUTCOMES = [
	"ok",
	"not_provided",
	"path_rejected",
	"unreadable",
	"no_complete_record",
	"no_assistant_record",
] as const;

export type HookTranscriptOutcome = (typeof HOOK_TRANSCRIPT_OUTCOMES)[number];

export type HookTranscriptPolicy =
	| { trust: "trusted" }
	| { trust: "restricted"; approvedRoots: readonly string[] };

export const TRUSTED_HOOK_TRANSCRIPT_POLICY: HookTranscriptPolicy = { trust: "trusted" };

export interface HookTranscriptReadOptions {
	policy: HookTranscriptPolicy;
	cwd?: string | null;
	/** Optional instrumentation seam for deterministic bounded-read tests. */
	onBytesRead?: (count: number) => void;
}

export type HookTranscriptExtraction = [string | null, Record<string, number> | null];

export interface HookTranscriptResult {
	extraction: HookTranscriptExtraction;
	outcome: HookTranscriptOutcome;
}

type ResolvedTranscriptPath = { path: string } | { outcome: Exclude<HookTranscriptOutcome, "ok"> };

function expandUser(path: string): string {
	return path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

function isContained(root: string, target: string): boolean {
	const pathFromRoot = relative(root, target);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
	);
}

function resolveTranscriptPath(
	transcriptPath: unknown,
	options: HookTranscriptReadOptions,
): ResolvedTranscriptPath {
	if (typeof transcriptPath !== "string") return { outcome: "not_provided" };
	const requestedPath = expandUser(transcriptPath.trim());
	if (!requestedPath) return { outcome: "not_provided" };

	if (!isAbsolute(requestedPath)) {
		if (options.policy.trust !== "trusted") return { outcome: "path_rejected" };
		if (typeof options.cwd !== "string") return { outcome: "path_rejected" };
		try {
			const cwd = expandUser(options.cwd.trim());
			if (!isAbsolute(cwd)) return { outcome: "path_rejected" };
			const realCwd = realpathSync(cwd);
			if (!statSync(realCwd).isDirectory()) return { outcome: "path_rejected" };
			const realTarget = realpathSync(resolve(realCwd, requestedPath));
			return isContained(realCwd, realTarget) ? { path: realTarget } : { outcome: "path_rejected" };
		} catch {
			return { outcome: "unreadable" };
		}
	}

	try {
		const realTarget = realpathSync(requestedPath);
		if (options.policy.trust === "trusted") return { path: realTarget };
		for (const root of options.policy.approvedRoots) {
			try {
				const realRoot = realpathSync(expandUser(root));
				if (statSync(realRoot).isDirectory() && isContained(realRoot, realTarget))
					return { path: realTarget };
			} catch {
				// Missing or unreadable approved roots are simply ineligible.
			}
		}
	} catch {
		return { outcome: "unreadable" };
	}
	return { outcome: "path_rejected" };
}

function reportBytesRead(options: HookTranscriptReadOptions, count: number): void {
	if (count <= 0) return;
	try {
		options.onBytesRead?.(count);
	} catch {
		// Instrumentation is best-effort and must not affect extraction.
	}
}

function readInto(
	descriptor: number,
	buffer: Buffer,
	length: number,
	position: number,
	options: HookTranscriptReadOptions,
): number {
	let offset = 0;
	while (offset < length) {
		const count = readSync(descriptor, buffer, offset, length - offset, position + offset);
		if (count === 0) break;
		offset += count;
		reportBytesRead(options, count);
	}
	return offset;
}

function decodeRecord(
	descriptor: number,
	buffer: Buffer,
	start: number,
	end: number,
	options: HookTranscriptReadOptions,
): string {
	const decoder = new TextDecoder("utf-8", { fatal: false });
	let position = start;
	let text = "";
	while (position < end) {
		const length = Math.min(buffer.length, end - position);
		const count = readInto(descriptor, buffer, length, position, options);
		if (count === 0) break;
		position += count;
		text += decoder.decode(buffer.subarray(0, count), { stream: position < end });
	}
	return text;
}

function textFromContent(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (Array.isArray(value)) return value.map(textFromContent).filter(Boolean).join("\n").trim();
	if (value != null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") return record.text.trim();
		return textFromContent(record.content);
	}
	return "";
}

function normalizeUsage(value: unknown): Record<string, number> | null {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
	const usage = value as Record<string, unknown>;
	const toInt = (key: string): number => {
		try {
			const parsed = Number(usage[key] ?? 0);
			return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
		} catch {
			return 0;
		}
	};
	const normalized = {
		input_tokens: toInt("input_tokens"),
		output_tokens: toInt("output_tokens"),
		cache_creation_input_tokens: toInt("cache_creation_input_tokens"),
		cache_read_input_tokens: toInt("cache_read_input_tokens"),
	};
	const total = Object.values(normalized).reduce((sum, count) => sum + count, 0);
	return total > 0 ? normalized : null;
}

function assistantFromRecord(line: string): HookTranscriptExtraction | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const record = parsed as Record<string, unknown>;
		const candidates = [record];
		if (
			record.message != null &&
			typeof record.message === "object" &&
			!Array.isArray(record.message)
		) {
			candidates.push(record.message as Record<string, unknown>);
		}
		let role = "";
		let contentValue: unknown = null;
		let usageValue: unknown = null;
		for (const candidate of candidates) {
			if (!role) {
				if (typeof candidate.role === "string") role = candidate.role.trim().toLowerCase();
				else if (candidate.type === "assistant") role = "assistant";
			}
			if (contentValue == null) {
				for (const field of ["content", "text"]) {
					if (field in candidate) {
						contentValue = candidate[field];
						break;
					}
				}
			}
			if (usageValue == null) {
				for (const field of ["usage", "token_usage", "tokenUsage"]) {
					if (field in candidate) {
						usageValue = candidate[field];
						break;
					}
				}
			}
		}
		if (role !== "assistant") return null;
		const text = textFromContent(contentValue);
		return text ? [text, normalizeUsage(usageValue)] : null;
	} catch {
		return null;
	}
}

function scanTranscript(
	descriptor: number,
	size: number,
	options: HookTranscriptReadOptions,
): HookTranscriptResult {
	const windowStart = Math.max(0, size - MAX_HOOK_TRANSCRIPT_BYTES);
	const buffer = Buffer.allocUnsafe(HOOK_TRANSCRIPT_CHUNK_BYTES);
	const decodeBuffer = Buffer.allocUnsafe(HOOK_TRANSCRIPT_CHUNK_BYTES);
	let boundaryAligned = windowStart === 0;
	if (!boundaryAligned) {
		boundaryAligned =
			readInto(descriptor, buffer, 1, windowStart - 1, options) === 1 && buffer[0] === 0x0a;
	}

	let lineEnd = size;
	let scanEnd = size;
	let hasCompleteRecord = false;
	while (scanEnd > windowStart) {
		const chunkStart = Math.max(windowStart, scanEnd - buffer.length);
		const count = readInto(descriptor, buffer, scanEnd - chunkStart, chunkStart, options);
		if (count === 0) break;
		for (let index = count - 1; index >= 0; index -= 1) {
			if (buffer[index] !== 0x0a) continue;
			const lineStart = chunkStart + index + 1;
			if (lineEnd > lineStart) {
				hasCompleteRecord = true;
				const line =
					lineEnd <= chunkStart + count
						? buffer.subarray(index + 1, lineEnd - chunkStart).toString("utf8")
						: decodeRecord(descriptor, decodeBuffer, lineStart, lineEnd, options);
				const extraction = assistantFromRecord(line);
				if (extraction) return { extraction, outcome: "ok" };
			}
			lineEnd = chunkStart + index;
		}
		scanEnd = chunkStart;
	}

	if (boundaryAligned && lineEnd > windowStart) {
		hasCompleteRecord = true;
		const extraction = assistantFromRecord(
			decodeRecord(descriptor, decodeBuffer, windowStart, lineEnd, options),
		);
		if (extraction) return { extraction, outcome: "ok" };
	}
	return {
		extraction: [null, null],
		outcome: hasCompleteRecord ? "no_assistant_record" : "no_complete_record",
	};
}

function readTranscript(path: string, options: HookTranscriptReadOptions): HookTranscriptResult {
	let descriptor: number | null = null;
	try {
		descriptor = openSync(
			path,
			constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
		);
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) return { extraction: [null, null], outcome: "unreadable" };
		const openedPath = realpathSync(path);
		const openedPathStat = statSync(openedPath);
		if (openedPath !== path || openedPathStat.dev !== stat.dev || openedPathStat.ino !== stat.ino) {
			return { extraction: [null, null], outcome: "path_rejected" };
		}
		return scanTranscript(descriptor, stat.size, options);
	} catch {
		return { extraction: [null, null], outcome: "unreadable" };
	} finally {
		if (descriptor !== null) {
			try {
				closeSync(descriptor);
			} catch {
				// A close failure does not make transcript extraction fatal.
			}
		}
	}
}

export function extractHookTranscript(
	transcriptPath: unknown,
	options: HookTranscriptReadOptions,
): HookTranscriptExtraction {
	return extractHookTranscriptWithOutcome(transcriptPath, options).extraction;
}

export function extractHookTranscriptWithOutcome(
	transcriptPath: unknown,
	options: HookTranscriptReadOptions,
): HookTranscriptResult {
	const resolved = resolveTranscriptPath(transcriptPath, options);
	if ("outcome" in resolved) return { extraction: [null, null], outcome: resolved.outcome };
	return readTranscript(resolved.path, options);
}
