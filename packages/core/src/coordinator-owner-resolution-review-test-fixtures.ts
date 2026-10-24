import { afterEach, beforeEach, expect, vi } from "vitest";
import { CONNECTION_BIRTH_COLUMNS } from "./coordinator-account-connection-storage.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { type Backend, review } from "./coordinator-auth-store-test-fixtures.js";
import { invitation } from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { CANONICAL_PUBLIC_KEY } from "./coordinator-ed25519-key-id-test-fixtures.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	backendFor,
	buildReview,
	now,
	originalController,
	seed,
	signer,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";

export { signer };
export const selection = {
	groupId: signer.groupId,
	deviceId: signer.deviceId,
	identityId: "identity-a",
	fingerprint: signer.fingerprint,
};
export const scope = "historical_included_owner_labels_only";
export function deterministicReviewTests() {
	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(NOW);
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	});
	afterEach(() => {
		expect(globalThis.fetch).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});
}

export async function setupReview(f: LinkFixture, kind: Backend, weakCurrent = true) {
	const h = backendFor(f, kind);
	await seed(f, h, { weakCurrent });
	// Keep the writer's real adapter and hooks, with a local allDb closure. No
	// production capability/store API is required by these private-operation tests.
	const backend = {
		...h.backend,
		async all<T>({ sql, values }: AuthLinkStatement): Promise<T[]> {
			return f.db.prepare(sql).all(...values) as T[];
		},
	};
	return { ...h, backend };
}

export function projectLabel(f: LinkFixture, actor = "identity-project") {
	invitation(f, {
		invite_id: "project-receipt",
		group_id: signer.groupId,
		bound_device_id: signer.deviceId,
		bound_public_key: signer.publicKey,
		bound_fingerprint: signer.fingerprint,
		invite_kind: "project_share",
		assigned_identity_id: null,
		target_identity_id: null,
		recipient_actor_id: actor,
	});
}

export async function existingFact(
	f: LinkFixture,
	h: Awaited<ReturnType<typeof setupReview>>,
	options: { retainedSource?: boolean } = {},
) {
	const existingController = options.retainedSource
		? await originalController(f, "old-source-group", `${signer.publicKey} retained-source`)
		: null;
	return commitReviewedOwnerResolution({
		backend: h.backend,
		evidence: h.evidence,
		review: await buildReview(f, { existingController }),
		now,
	});
}

export async function anotherGroup(f: LinkFixture) {
	await f.store.createGroup("group-two");
	await f.store.enrollDevice("group-two", signer);
	f.db
		.prepare("UPDATE enrolled_devices SET identity_id='identity-c' WHERE group_id=?")
		.run("group-two");
	return { ...selection, groupId: "group-two" };
}

export function expectSafeDto(value: unknown) {
	const text = JSON.stringify(value);
	expect(text).not.toMatch(
		/public_key|publicKey|providerSubject|private-claim-subject|email|token|issuer|ownershipEvidenceDigest|recheckSnapshot|authority/,
	);
	expect(text).not.toContain(signer.publicKey);
}

export async function unrelatedChurn(f: LinkFixture) {
	await f.store.createGroup("unrelated-group");
	const device = {
		deviceId: "unrelated-person",
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "9".repeat(64),
	};
	await f.store.enrollDevice("unrelated-group", device);
	expect(
		await f.store.createAuthControllerAttestation(
			review({
				...device,
				groupId: "unrelated-group",
				identityId: "identity-b",
				attestationId: "unrelated-controller",
				reviewReceiptId: "unrelated-receipt",
			}),
		),
	).toMatchObject({ kind: "created" });
	// Historical compatibility spelling is deliberately seeded raw: the current
	// producer rejects surrounding Unicode whitespace, while discovery must still
	// distinguish its valid canonical bytes from the requester's key.
	const publicKey = `\u2003${CANONICAL_PUBLIC_KEY.replace(" ", "\u00a0!")}\u2003`;
	f.db
		.prepare(
			"UPDATE coordinator_auth_controller_attestations SET public_key=? WHERE attestation_id='unrelated-controller'",
		)
		.run(publicKey);
	f.db
		.prepare("UPDATE enrolled_devices SET public_key=? WHERE device_id='unrelated-person'")
		.run(publicKey);
	return publicKey;
}

export function reconnectTarget(f: LinkFixture) {
	// Accepted continuation fixture: archive the original generation and retain its
	// claim/browser/audit birth. Never simulate a generation by editing immutable birth columns.
	const tables = [
		"coordinator_auth_account_links",
		"coordinator_auth_link_attempts",
		"coordinator_auth_link_audit_log",
	];
	const originals = tables.map(
		(table) => f.db.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>,
	);
	const columns = CONNECTION_BIRTH_COLUMNS.join(",");
	f.db
		.prepare(`INSERT INTO coordinator_auth_account_connection_unlinks
		(coordinator_id,attempt_id,target_link_id,identity_id,issuer,target_subject,group_id,
		device_id,public_key,fingerprint,enrollment_identity_id,auth_config_revision,request_hash,state,created_at_ms)
		SELECT coordinator_id,'end-attempt',link_id,identity_id,issuer,account_subject,'group-a',
		'device-a',public_key,fingerprint,NULL,auth_config_revision,?,'committing',?
		FROM coordinator_auth_link_attempts WHERE state='finalized'`)
		.run("e".repeat(64), NOW + 1);
	f.db
		.prepare(`INSERT INTO coordinator_auth_account_connection_history
		(${columns},original_rowid,ended_at_ms,end_attempt_id,signin_floor)
		SELECT ${columns},rowid,?,'end-attempt',signin_floor FROM coordinator_auth_account_links`)
		.run(NOW + 1);
	f.db.exec("DELETE FROM coordinator_auth_account_links");
	f.db
		.prepare(
			"UPDATE coordinator_auth_account_connection_unlinks SET state='completed',completed_at_ms=?",
		)
		.run(NOW + 1);
	for (const [index, table] of tables.entries()) {
		const original = originals[index];
		if (!original) throw new Error("missing synthetic target birth");
		const row = { ...original, link_id: "successor-link", attempt_id: "successor-attempt" };
		if (table === "coordinator_auth_link_attempts")
			Object.assign(row, {
				prior_link_id: "claim-a",
				browser_start_hash: "1".repeat(64),
				browser_transaction_hash: "2".repeat(64),
				runtime_verifier_hash: "3".repeat(64),
				completion_secret_hash: "4".repeat(64),
			});
		const entries = Object.entries(row);
		f.db
			.prepare(
				`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
			)
			.run(...entries.map(([, value]) => value));
	}
	f.db.exec(
		"UPDATE coordinator_auth_account_connection_history SET successor_link_id='successor-link'",
	);
}
