import type { PackArtifacts, PackAssemblyRequest } from "../pack.js";
import type { RuntimeProof } from "../semantic/semantic-worker-protocol.js";

/** What the worker is started with: the store file and the identity of that file. */
export interface PackWorkerData {
	dbPath: string;
	fileIdentity: string;
}

/**
 * One pack to assemble. `proof` is the Identity the worker reads as. It is the only place
 * the worker learns who is asking.
 */
export interface PackWorkerJob {
	proof: RuntimeProof;
	request: PackAssemblyRequest;
}

export type PackWorkerRequest =
	| { type: "assemble"; id: number; deadlineAt: number; job: PackWorkerJob }
	| { type: "close" };

export type PackWorkerReply =
	| { type: "ready" }
	| { type: "result"; id: number; artifacts: PackArtifacts }
	| { type: "error"; id: number; code: "assembly_failed" | "expired" };
