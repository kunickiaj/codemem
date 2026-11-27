/**
 * The worker thread that assembles prompt packs.
 *
 * It opens the store read-only and reads as the Identity named in each request. It reads no
 * configuration, environment or key file, and it cannot write. The thread that asked
 * decides whether the pack is delivered.
 */
import { statSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";
import { connectReadOnly } from "../db.js";
import { createMemoryReadHandle } from "../memory-reads.js";
import { assemblePackArtifacts } from "../pack.js";
import type { PackWorkerData, PackWorkerJob, PackWorkerRequest } from "./pack-worker-protocol.js";

/** Requests larger than this are refused: a pack request is a query and a few candidates. */
const MAX_JOB_BYTES = 4 * 1024 * 1024;

if (!parentPort) throw new Error("pack_worker_parent_required");
const port = parentPort;
const { dbPath, fileIdentity } = workerData as PackWorkerData;
const stat = statSync(dbPath);
if (`${stat.dev}:${stat.ino}` !== fileIdentity) throw new Error("pack_worker_file_changed");
const db = connectReadOnly(dbPath);
try {
	db.pragma("query_only = ON");
} catch (error) {
	db.close();
	throw error;
}

function validateJob(job: PackWorkerJob): void {
	const { proof, request } = job;
	if (
		typeof proof?.actorId !== "string" ||
		!proof.actorId.trim() ||
		typeof proof.deviceId !== "string" ||
		!proof.deviceId.trim() ||
		(proof.expectedPublicKey !== undefined && typeof proof.expectedPublicKey !== "string") ||
		typeof request?.context !== "string" ||
		!Number.isFinite(request.limit) ||
		!Array.isArray(request.semanticResults) ||
		JSON.stringify(job).length > MAX_JOB_BYTES
	)
		throw new Error("invalid_pack_worker_job");
}

port.on("message", (message: PackWorkerRequest) => {
	if (message?.type === "close") {
		db.close();
		port.close();
		return;
	}
	if (
		message?.type !== "assemble" ||
		!Number.isSafeInteger(message.id) ||
		!Number.isFinite(message.deadlineAt)
	) {
		throw new Error("invalid_pack_worker_message");
	}
	try {
		validateJob(message.job);
		if (Date.now() >= message.deadlineAt) {
			port.postMessage({ type: "error", id: message.id, code: "expired" });
			return;
		}
		const store = createMemoryReadHandle(db, message.job.proof);
		const artifacts = assemblePackArtifacts(store, message.job.request);
		port.postMessage({ type: "result", id: message.id, artifacts });
	} catch {
		port.postMessage({ type: "error", id: message.id, code: "assembly_failed" });
	}
});
port.postMessage({ type: "ready" });
