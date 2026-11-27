import type { LocalIdentityGenerationMarker } from "../local-identity-generation.js";
import type { PackArtifacts, PackAssemblyRequest } from "../pack.js";
import type { RuntimeProof } from "../semantic/semantic-worker-protocol.js";

/** What the worker is started with: the store file as the store identified it at open. */
export interface PackWorkerData {
	dbPath: string;
	fileIdentity: string;
}

/**
 * Who a pack is assembled for, as the asking thread saw it before it asked. Besides the
 * Identity and the device's key it carries the Identity generation the store has persisted.
 * A switch commits that marker in the store before the configuration names the new
 * Identity, so the marker shows a switch that the Identity alone does not yet.
 */
export interface PackWorkerProof extends RuntimeProof {
	identityGeneration: LocalIdentityGenerationMarker | null;
}

/**
 * One pack to assemble. `proof` is the Identity the worker reads as. It is the only place
 * the worker learns who is asking.
 */
export interface PackWorkerJob {
	proof: PackWorkerProof;
	request: PackAssemblyRequest;
}

export type PackWorkerRequest =
	| { type: "assemble"; id: number; deadlineAt: number; job: PackWorkerJob }
	| { type: "close" };

/**
 * `refused` means the worker's own view of the store did not match the proof. It is an
 * answer about the request and says nothing against the worker.
 */
export type PackWorkerReply =
	| { type: "ready" }
	| { type: "result"; id: number; artifacts: PackArtifacts }
	| { type: "error"; id: number; code: "assembly_failed" | "expired" | "refused" };
