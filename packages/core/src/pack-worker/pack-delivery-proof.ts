/**
 * Who a pack is delivered to, and whether that is still who the process is.
 *
 * A local Identity switch commits in the store first and in the configuration second. In
 * between, the process still reads its old Identity from the configuration and looks
 * current to itself, while the store already belongs to the new one. The proof therefore
 * carries the Identity generation the store has persisted, and a request is refused when
 * that generation names another Identity than the process runs as.
 *
 * A process that answers requests while it builds packs takes the proof before it
 * retrieves anything and checks it as the last step before delivery, after every read the
 * pack depends on. A switch that commits at any point in between refuses the pack, whether
 * a worker thread assembled it or this thread did.
 */
import { readLocalIdentityGenerationMarker } from "../local-identity-generation.js";
import type { StoreHandle } from "../search.js";
import { SemanticIdentityChangedError } from "../semantic/semantic-executor-seam.js";
import { captureProof } from "../semantic/semantic-worker-executor.js";
import type { PackWorkerProof } from "./pack-worker-protocol.js";

export interface PackDeliveryStore extends StoreHandle {
	hasCurrentIdentity(): boolean;
	onIdentityChanged?(listener: () => void): () => void;
	/** How many times this process has changed its Identity. */
	identityChangeCount?(): number;
}

/**
 * Who this thread is now. Throws when a switch has committed in the store to another
 * Identity than this process runs as.
 */
export function captureDeliveryProof(store: PackDeliveryStore): PackWorkerProof {
	const proof: PackWorkerProof = {
		...captureProof(store),
		identityGeneration: readLocalIdentityGenerationMarker(store.db),
	};
	if (proof.identityGeneration && proof.identityGeneration.actorId !== proof.actorId) {
		throw new SemanticIdentityChangedError();
	}
	return proof;
}

/** Reads the Identity, the device key and the persisted generation again and compares. */
export function assertProofUnchanged(store: PackDeliveryStore, proof: PackWorkerProof): void {
	if (JSON.stringify(captureDeliveryProof(store)) !== JSON.stringify(proof)) {
		throw new SemanticIdentityChangedError();
	}
}

/** One pack request's hold on who it is for. */
export interface PackDeliveryGuard {
	/**
	 * Throws unless the process is still who it was when the request began. Call it last,
	 * after the pack is assembled and checked, and before anything is recorded or returned.
	 */
	assertCurrent(): void;
}

/** Take the proof for one request, before anything is retrieved for it. */
export function beginPackDelivery(store: PackDeliveryStore): PackDeliveryGuard {
	const changesBefore = store.identityChangeCount?.() ?? 0;
	const proof = captureDeliveryProof(store);
	return {
		assertCurrent() {
			if ((store.identityChangeCount?.() ?? 0) !== changesBefore) {
				throw new SemanticIdentityChangedError();
			}
			assertProofUnchanged(store, proof);
		},
	};
}
