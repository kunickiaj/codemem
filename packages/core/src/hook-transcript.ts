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

export type HookTranscriptPolicy =
	| { trust: "trusted" }
	| { trust: "restricted"; approvedRoots: readonly string[] };

export const TRUSTED_HOOK_TRANSCRIPT_POLICY: HookTranscriptPolicy = { trust: "trusted" };

export interface HookTranscriptReadOptions {
	policy: HookTranscriptPolicy;
	cwd?: string | null;
}

type TranscriptExtraction = [string | null, Record<string, number> | null];

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
): string | null {
	if (typeof transcriptPath !== "string") return null;
	const requestedPath = expandUser(transcriptPath.trim());
	if (!requestedPath) return null;

	try {
		if (!isAbsolute(requestedPath)) {
			if (options.policy.trust !== "trusted") return null;
			if (typeof options.cwd !== "string") return null;
			const cwd = expandUser(options.cwd.trim());
			if (!isAbsolute(cwd)) return null;
			const realCwd = realpathSync(cwd);
			if (!statSync(realCwd).isDirectory()) return null;
			const realTarget = realpathSync(resolve(realCwd, requestedPath));
			return isContained(realCwd, realTarget) ? realTarget : null;
		}

		const realTarget = realpathSync(requestedPath);
		if (options.policy.trust === "trusted") return realTarget;
		for (const root of options.policy.approvedRoots) {
			try {
				const realRoot = realpathSync(expandUser(root));
				if (statSync(realRoot).isDirectory() && isContained(realRoot, realTarget))
					return realTarget;
			} catch {
				// Missing or unreadable approved roots are simply ineligible.
			}
		}
	} catch {
		return null;
	}
	return null;
}

function readTranscriptTail(path: string): string | null {
	let descriptor: number | null = null;
	try {
		descriptor = openSync(
			path,
			constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0),
		);
		const stat = fstatSync(descriptor);
		if (!stat.isFile()) return null;
		const openedPath = realpathSync(path);
		const openedPathStat = statSync(openedPath);
		if (openedPath !== path || openedPathStat.dev !== stat.dev || openedPathStat.ino !== stat.ino) {
			return null;
		}
		const bytesToRead = Math.min(stat.size, MAX_HOOK_TRANSCRIPT_BYTES);
		const start = stat.size - bytesToRead;
		const buffer = Buffer.allocUnsafe(bytesToRead);
		let offset = 0;
		while (offset < bytesToRead) {
			const bytesRead = readSync(descriptor, buffer, offset, bytesToRead - offset, start + offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		let retained = buffer.subarray(0, offset);
		if (start > 0) {
			const precedingByte = Buffer.allocUnsafe(1);
			const precedingByteRead = readSync(descriptor, precedingByte, 0, 1, start - 1);
			if (precedingByteRead !== 1 || precedingByte[0] !== 0x0a) {
				const firstNewline = retained.indexOf(0x0a);
				if (firstNewline < 0) return null;
				retained = retained.subarray(firstNewline + 1);
			}
		}
		return retained.length > 0 ? retained.toString("utf8") : null;
	} catch {
		return null;
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

function parseTranscript(content: string): TranscriptExtraction {
	let assistantText: string | null = null;
	let assistantUsage: Record<string, number> | null = null;
	for (const rawLine of content.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
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
			if (role !== "assistant") continue;
			const text = textFromContent(contentValue);
			if (!text) continue;
			assistantText = text;
			assistantUsage = normalizeUsage(usageValue);
		} catch {
			// Ignore malformed JSONL records and continue scanning the bounded tail.
		}
	}
	return [assistantText, assistantUsage];
}

export function extractHookTranscript(
	transcriptPath: unknown,
	options: HookTranscriptReadOptions,
): TranscriptExtraction {
	const resolvedPath = resolveTranscriptPath(transcriptPath, options);
	if (!resolvedPath) return [null, null];
	const content = readTranscriptTail(resolvedPath);
	return content === null ? [null, null] : parseTranscript(content);
}
