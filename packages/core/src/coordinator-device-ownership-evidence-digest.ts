import type { ControllerHistorySnapshot } from "./coordinator-auth-controller-history.js";
import {
	type EvidenceRow,
	type EvidenceRows,
	type EvidenceSubject,
	evidenceRows,
	keyId,
} from "./coordinator-device-ownership-evidence-classify.js";

function canonicalRows(rows: EvidenceRow[]): string[] {
	return rows.map((row) => JSON.stringify(row)).sort();
}

async function actualSubjectRows(
	rows: EvidenceRow[],
	subject: EvidenceSubject,
	columns: { device: number; publicKey: number },
): Promise<EvidenceRow[]> {
	const relevant: EvidenceRow[] = [];
	for (const row of rows) {
		if (
			row[columns.device] === subject.deviceId ||
			(await keyId(row[columns.publicKey])) === subject.keyId
		)
			relevant.push(row);
	}
	return relevant;
}

/** Hash only validated semantic evidence, not conservative SQL discovery inputs.
 * Row positions follow the fixed source column lists; sorting uses code units,
 * never locale rules. Exact source key text remains part of relevant evidence.
 */
export async function capturedOwnershipEvidenceDigest(
	rows: EvidenceRows,
	subject: EvidenceSubject,
	canonicalOwnerId: string,
	history: ControllerHistorySnapshot,
): Promise<string> {
	const controllers = await actualSubjectRows(evidenceRows(rows, "controllers"), subject, {
		device: 4,
		publicKey: 5,
	});
	const invites = await actualSubjectRows(evidenceRows(rows, "invites"), subject, {
		device: 7,
		publicKey: 8,
	});
	const projection = [
		"codemem:reviewed-device-ownership-evidence:v1",
		["legacy-owner-resolution-schema", 1, "ready"],
		[
			subject.coordinatorId,
			subject.groupId,
			subject.deviceId,
			subject.publicKey,
			subject.fingerprint,
			subject.keyId,
		],
		canonicalOwnerId,
		[
			"enrollment",
			"bindings",
			"claims",
			"resolutions",
			"revocations",
			"history",
			"historyKeys",
		].map((name) => [name, canonicalRows(evidenceRows(rows, name))]),
		["controllers", canonicalRows(controllers)],
		["invites", canonicalRows(invites)],
		["subjectFingerprints", [...history.fingerprints].sort()],
	];
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(projection)),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
