import { MemoryStore, resolveDbPath, stripPrivateObj } from "@codemem/core";
import { Command } from "commander";
import { helpStyle } from "../help-style.js";

const SESSION_ID_KEYS = [
	"session_stream_id",
	"session_id",
	"stream_id",
	"opencode_session_id",
] as const;

function resolveSessionStreamId(payload: Record<string, unknown>): string | null {
	const values = new Map<string, string>();
	for (const key of SESSION_ID_KEYS) {
		const value = payload[key];
		if (typeof value !== "string") continue;
		const text = value.trim();
		if (text) values.set(key, text);
	}
	if (values.size === 0) return null;
	const unique = new Set(values.values());
	if (unique.size > 1) throw new Error("conflicting session id fields");
	for (const key of SESSION_ID_KEYS) {
		const value = values.get(key);
		if (value) return value;
	}
	return null;
}

async function readStdinJson(): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	const raw = Buffer.concat(chunks).toString("utf-8").trim();
	if (!raw) throw new Error("stdin JSON required");
	const parsed = JSON.parse(raw) as unknown;
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("payload must be an object");
	}
	return parsed as Record<string, unknown>;
}

export const enqueueRawEventCommand = new Command("enqueue-raw-event")
	.configureHelp(helpStyle)
	.description("Enqueue one raw event from stdin into the durable queue")
	.option("--db <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.option("--db-path <path>", "database path (default: $CODEMEM_DB or ~/.codemem/mem.sqlite)")
	.action(async (opts: { db?: string; dbPath?: string }) => {
		const payload = await readStdinJson();
		const sessionId = resolveSessionStreamId(payload);
		if (!sessionId) throw new Error("session id required");
		if (sessionId.startsWith("msg_")) throw new Error("invalid session id");

		const eventType = typeof payload.event_type === "string" ? payload.event_type.trim() : "";
		if (!eventType) throw new Error("event_type required");

		const cwd = typeof payload.cwd === "string" ? payload.cwd : null;
		const project = typeof payload.project === "string" ? payload.project : null;
		const startedAt = typeof payload.started_at === "string" ? payload.started_at : null;
		const tsWallMs = Number.isFinite(Number(payload.ts_wall_ms))
			? Math.floor(Number(payload.ts_wall_ms))
			: null;
		const tsMonoMs = Number.isFinite(Number(payload.ts_mono_ms))
			? Number(payload.ts_mono_ms)
			: null;
		const eventId = typeof payload.event_id === "string" ? payload.event_id.trim() : "";
		const eventPayload =
			payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload)
				? (stripPrivateObj(payload.payload) as Record<string, unknown>)
				: {};

		const store = new MemoryStore(resolveDbPath(opts.db ?? opts.dbPath));
		try {
			store.updateRawEventSessionMeta({
				opencodeSessionId: sessionId,
				source: "opencode",
				cwd,
				project,
				startedAt,
				lastSeenTsWallMs: tsWallMs,
			});
			store.recordRawEventsBatch(sessionId, [
				{
					event_id: eventId,
					event_type: eventType,
					payload: eventPayload,
					ts_wall_ms: tsWallMs,
					ts_mono_ms: tsMonoMs,
				},
			]);
		} finally {
			store.close();
		}
	});
