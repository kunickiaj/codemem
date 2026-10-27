/**
 * Writer guard for the local Identity switch (ADR 0005 Section 8, S4b).
 * After a switch, the generation marker names the device's Identity; a
 * process still running as another one must not write.
 */
import type { Database } from "./db.js";

export class LocalIdentitySupersededError extends Error {
	readonly code = "local_identity_superseded";
	constructor() {
		super(
			"This codemem process uses an Identity this device has switched away from. Restart codemem.",
		);
	}
}

/** The Identity the last switch set, or null when this device never switched. */
export function readLocalIdentityGeneration(db: Database): string | null {
	try {
		const row = db.prepare("SELECT actor_id FROM local_identity_generation WHERE id = 1").get() as
			| { actor_id: string }
			| undefined;
		return row?.actor_id ?? null;
	} catch (error) {
		// Created by the first switch; read paths never run DDL.
		if (error instanceof Error && error.message.includes("no such table")) return null;
		throw error;
	}
}

export function assertLocalIdentityCurrent(db: Database, actorId: string): void {
	const current = readLocalIdentityGeneration(db);
	if (current !== null && current !== actorId) throw new LocalIdentitySupersededError();
}
