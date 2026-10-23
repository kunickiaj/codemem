import { statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { load } from "sqlite-vec";
import { connectReadOnly } from "../db.js";
import type { RankInput, WorkerRequest } from "./semantic-worker-protocol.js";
import { rankWorkerInput } from "./semantic-worker-ranking.js";

if (!parentPort) throw new Error("semantic_worker_parent_required");
const port = parentPort;
const { dbPath, fileIdentity } = workerData as { dbPath: string; fileIdentity: string };
const stat = statSync(dbPath);
if (`${stat.dev}:${stat.ino}` !== fileIdentity) throw new Error("semantic_worker_file_changed");
const db = connectReadOnly(dbPath);
try {
	load(db);
	db.pragma("query_only = ON");
	db.prepare("SELECT vec_version()").get();
} catch (error) {
	db.close();
	throw error;
}

function validateInput(input: RankInput): void {
	if (
		typeof input.generationId !== "string" ||
		!input.generationId.trim() ||
		input.generationId.length > 256 ||
		!(input.embedding instanceof Float32Array) ||
		input.embedding.length !== 384 ||
		!input.embedding.every(Number.isFinite) ||
		!input.proof.actorId.trim() ||
		!input.proof.deviceId.trim() ||
		!input.embeddingIdentity ||
		input.embeddingIdentity.length > 2048 ||
		!Number.isFinite(input.limit) ||
		JSON.stringify(input.filters).length > 32_768
	)
		throw new Error("invalid_semantic_worker_input");
}

port.on("message", (request: WorkerRequest) => {
	if (request?.type === "close") {
		db.close();
		port.close();
		return;
	}
	if (
		request?.type !== "rank" ||
		!Number.isSafeInteger(request.id) ||
		!Number.isFinite(request.deadlineAt)
	) {
		throw new Error("invalid_semantic_worker_message");
	}
	try {
		validateInput(request.input);
		if (Date.now() >= request.deadlineAt) {
			port.postMessage({ type: "error", id: request.id, code: "expired" });
			return;
		}
		const output = rankWorkerInput(db, request.input);
		port.postMessage({ type: "result", id: request.id, output });
	} catch {
		port.postMessage({ type: "error", id: request.id, code: "ranking_failed" });
	}
});
port.postMessage({ type: "ready" });
