/**
 * The worker thread that assembles prompt packs.
 *
 * It opens the store read-only and reads as the Identity named in each request. It reads no
 * configuration, environment or key file, and it cannot write. The thread that asked
 * decides whether the pack is delivered.
 */
import { parentPort, workerData } from "node:worker_threads";
import { isDatabaseFileUnchanged } from "../database-file-identity.js";
import { connectReadOnly } from "../db.js";
import {
	type LocalIdentityGenerationMarker,
	readLocalIdentityGenerationMarker,
} from "../local-identity-generation.js";
import { createMemoryReadHandle } from "../memory-reads.js";
import { assemblePackArtifacts } from "../pack.js";
import type { PackWorkerData, PackWorkerJob, PackWorkerRequest } from "./pack-worker-protocol.js";

/** Requests larger than this are refused: a pack request is a query and a few candidates. */
const MAX_JOB_BYTES = 4 * 1024 * 1024;

if (!parentPort) throw new Error("pack_worker_parent_required");
const port = parentPort;
const { opened } = workerData as PackWorkerData;
// The path must lead to the file, and the write-ahead log, that the store identified when it
// opened its connection. Checked on both sides of the open: a file replaced before it would
// otherwise be read as the store's, and its row IDs would pass for the store's. A file put
// there only for the instant of the open is not caught; see database-file-identity.ts.
if (!isDatabaseFileUnchanged(opened)) throw new Error("pack_worker_file_changed");
const db = connectReadOnly(opened.path);
try {
	if (!isDatabaseFileUnchanged(opened)) throw new Error("pack_worker_file_changed");
	db.pragma("query_only = ON");
} catch (error) {
	db.close();
	throw error;
}

function sameGeneration(
	a: LocalIdentityGenerationMarker | null,
	b: LocalIdentityGenerationMarker | null,
): boolean {
	return a?.generation === b?.generation && a?.actorId === b?.actorId;
}

/** Whether this connection sees the Identity generation the request was made under. */
function generationMatches(job: PackWorkerJob): boolean {
	return sameGeneration(readLocalIdentityGenerationMarker(db), job.proof.identityGeneration);
}

function validGeneration(marker: unknown): boolean {
	if (marker === null) return true;
	const candidate = marker as Partial<LocalIdentityGenerationMarker> | undefined;
	return (
		Number.isSafeInteger(candidate?.generation) &&
		typeof candidate?.actorId === "string" &&
		candidate.actorId.trim().length > 0
	);
}

function validateJob(job: PackWorkerJob): void {
	const { proof, request } = job;
	if (
		typeof proof?.actorId !== "string" ||
		!proof.actorId.trim() ||
		typeof proof.deviceId !== "string" ||
		!proof.deviceId.trim() ||
		(proof.expectedPublicKey !== undefined && typeof proof.expectedPublicKey !== "string") ||
		!validGeneration(proof.identityGeneration) ||
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
		if (!generationMatches(message.job)) {
			port.postMessage({ type: "error", id: message.id, code: "refused" });
			return;
		}
		const store = createMemoryReadHandle(db, message.job.proof);
		const artifacts = assemblePackArtifacts(store, message.job.request);
		// A switch that committed while the pack was assembled may have changed what it read.
		if (!generationMatches(message.job)) {
			port.postMessage({ type: "error", id: message.id, code: "refused" });
			return;
		}
		port.postMessage({ type: "result", id: message.id, artifacts });
	} catch {
		port.postMessage({ type: "error", id: message.id, code: "assembly_failed" });
	}
});
port.postMessage({ type: "ready" });
