import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
	HistoricalPackFailureV1,
	HistoricalPackRequestV1,
	HistoricalPackResponseV1,
	HistoricalPackTraceV1,
	JsonValue,
} from "./types.js";

function failure(
	code: HistoricalPackFailureV1["error"]["code"],
	message: string,
): HistoricalPackFailureV1 {
	return { schema_version: 1, ok: false, error: { code, message } };
}

function request(value: unknown): HistoricalPackRequestV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("request must be an object");
	const input = value as HistoricalPackRequestV1;
	if (
		input.schema_version !== 1 ||
		input.operation !== "run_pack_traces" ||
		!isAbsolute(input.store_path) ||
		!Array.isArray(input.memories) ||
		!Array.isArray(input.probes)
	)
		throw new TypeError("invalid historical pack request");
	if (new Set(input.memories.map((memory) => memory.memory_key)).size !== input.memories.length)
		throw new TypeError("memory_key values must be unique");
	if (new Set(input.probes.map((probe) => probe.probe_id)).size !== input.probes.length)
		throw new TypeError("probe_id values must be unique");
	return input;
}

function metadata(value: unknown): Record<string, JsonValue> {
	if (typeof value === "string")
		try {
			return metadata(JSON.parse(value));
		} catch {
			return {};
		}
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, JsonValue>)
		: {};
}

function summarize(trace: unknown, probeId: string): HistoricalPackTraceV1 {
	const value = trace as {
		mode?: { selected?: HistoricalPackTraceV1["mode"] };
		retrieval?: {
			candidates?: Array<{
				id: number;
				rank: number;
				artifact_class?: HistoricalPackTraceV1["retrieval"]["candidates"][number]["artifact_class"];
			}>;
		};
		assembly?: HistoricalPackTraceV1["assembly"];
	};
	if (!value.mode?.selected || !value.assembly?.sections)
		throw new TypeError("historical pack trace is incomplete");
	return {
		probe_id: probeId,
		mode: value.mode.selected,
		retrieval: { candidates: value.retrieval?.candidates ?? [] },
		assembly: value.assembly,
	};
}

async function main(): Promise<HistoricalPackResponseV1> {
	const [storeModulePath, packModulePath] = process.argv.slice(2);
	if (!storeModulePath || !packModulePath)
		return failure("invalid_request", "historical module paths are required");
	let input: HistoricalPackRequestV1;
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
		input = request(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch (error) {
		return failure("invalid_request", error instanceof Error ? error.message : String(error));
	}
	if (existsSync(input.store_path))
		return failure("invalid_request", "store_path must not already exist");
	process.env.CODEMEM_EMBEDDING_DISABLED = "1";
	process.env.CODEMEM_MEMORY_CROSS_SESSION_DEDUP_WINDOW_MS = "0";
	try {
		const source = dirname(storeModulePath);
		const database = (await import(pathToFileURL(resolve(source, "db.ts")).href)) as {
			connect?: (path: string) => { close(): void };
		};
		const bootstrap = (await import(
			pathToFileURL(resolve(source, "schema-bootstrap.ts")).href
		).catch(() => ({}))) as { bootstrapSchema?: (db: unknown) => void };
		if (database.connect && bootstrap.bootstrapSchema) {
			const db = database.connect(input.store_path);
			try {
				bootstrap.bootstrapSchema(db);
			} finally {
				db.close();
			}
		}
		const storeModule = (await import(pathToFileURL(storeModulePath).href)) as {
			MemoryStore?: new (
				path: string,
			) => {
				db: { prepare(sql: string): { get(): unknown } };
				startSession(options: Record<string, unknown>): number;
				remember(
					sessionId: number,
					kind: string,
					title: string,
					body: string,
					confidence: number,
					tags?: string[],
					metadata?: Record<string, JsonValue>,
				): number;
				get(
					id: number,
				): { kind: string; title: string; body_text: string; metadata_json?: unknown } | null;
				close(): void;
			};
		};
		const packModule = (await import(pathToFileURL(packModulePath).href)) as {
			buildMemoryPackTrace?: (store: unknown, query: string, limit: number) => unknown;
		};
		const MemoryStore = storeModule.MemoryStore;
		const buildMemoryPackTrace = packModule.buildMemoryPackTrace;
		if (!MemoryStore || !buildMemoryPackTrace)
			return failure("unsupported_subject", "historical pack APIs unavailable");
		const store = new MemoryStore(input.store_path);
		try {
			const sessions = new Map<string, number>();
			const ids = new Map<string, number>();
			for (const memory of input.memories) {
				const session =
					sessions.get(memory.session_key) ??
					store.startSession({
						project: "release-eval",
						toolVersion: "release-eval",
						metadata: { release_eval: true },
					});
				sessions.set(memory.session_key, session);
				ids.set(
					memory.memory_key,
					store.remember(
						session,
						memory.kind,
						memory.title,
						memory.body_text,
						memory.confidence,
						memory.tags,
						memory.metadata,
					),
				);
			}
			const traces = input.probes.map((probe) =>
				summarize(buildMemoryPackTrace(store, probe.query, probe.limit), probe.probe_id),
			);
			const materialized_items = input.memories.map((memory) => {
				const id = ids.get(memory.memory_key);
				if (id === undefined) throw new Error(`missing materialized ID for ${memory.memory_key}`);
				const item = store.get(id);
				if (!item) throw new Error(`missing materialized item ${id}`);
				return {
					id,
					memory_key: memory.memory_key,
					kind: item.kind,
					title: item.title,
					body_text: item.body_text,
					metadata: metadata(item.metadata_json),
				};
			});
			let usage_row_count = 0;
			try {
				usage_row_count = Number(
					(
						store.db.prepare("SELECT COUNT(*) AS count FROM usage_events").get() as {
							count: number;
						}
					).count,
				);
			} catch {
				usage_row_count = 0;
			}
			return {
				schema_version: 1,
				ok: true,
				result: { traces, materialized_items, usage_row_count },
			};
		} finally {
			store.close();
		}
	} catch (error) {
		return failure(
			"subject_execution_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

process.stdout.write(`${JSON.stringify(await main())}\n`);
