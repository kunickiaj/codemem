import { expect } from "vitest";
import type { CoordinatorAuthLinkSigner } from "./coordinator-auth-link-contract.js";
import {
	attempt,
	type LinkFixture,
	rows,
	signer,
	TABLES,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import { enroll, review } from "./coordinator-auth-store-test-fixtures.js";

export function numberedAttempt(n: number, actor = signer) {
	return attempt({ attemptId: `maintenance-${n}`, runtimeVerifierHash: digest(n), signer: actor });
}

export function digest(n: number) {
	return n.toString(16).padStart(64, "0");
}

export async function actor(
	f: LinkFixture,
	suffix: string,
	identityId = "identity-a",
	coordinatorId = f.cfg.coordinatorId,
): Promise<CoordinatorAuthLinkSigner> {
	const input = review({
		deviceId: `device-${suffix}`,
		attestationId: `attestation-${suffix}`,
		reviewReceiptId: `receipt-${suffix}`,
		identityId,
		coordinatorId,
	});
	await enroll(f.store, input);
	expect(await f.store.createAuthControllerAttestation(input)).toMatchObject({ kind: "created" });
	return {
		groupId: input.groupId,
		deviceId: input.deviceId,
		publicKey: input.publicKey,
		fingerprint: input.fingerprint,
	};
}

// Clone a valid persisted row only inside the disposable parity fixture. Unique
// commitments remain representative; large capacity fixtures bypass API caps.
export function seedCopies(
	f: LinkFixture,
	count: number,
	overrides: Record<string, unknown> = {},
	offset = 100,
) {
	const template = rows(f, TABLES[0])[0];
	if (!template) throw new Error("seed requires one valid attempt");
	const columns = Object.keys(template);
	const insert = f.db.prepare(
		`INSERT INTO coordinator_auth_link_attempts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
	);
	f.db.transaction(() => {
		for (let n = offset; n < offset + count; n++) {
			const row: Record<string, unknown> = {
				...template,
				attempt_id: `seed-${n}`,
				runtime_verifier_hash: digest(n),
			};
			if (template.browser_transaction_hash !== null)
				row.browser_transaction_hash = digest(n + 100_000);
			if (template.completion_secret_hash !== null)
				row.completion_secret_hash = digest(n + 200_000);
			if (template.link_id !== null) row.link_id = `seed-link-${n}`;
			Object.assign(row, overrides);
			insert.run(...columns.map((column) => row[column]));
		}
	})();
}

export function expireAt(f: LinkFixture, createdAt: number) {
	f.db
		.prepare("UPDATE coordinator_auth_link_attempts SET created_at_ms = ?, expires_at_ms = ?")
		.run(createdAt, createdAt + TTL);
}

export function allData(f: LinkFixture) {
	return [
		...TABLES,
		"groups",
		"enrolled_devices",
		"coordinator_auth_controller_attestations",
		"coordinator_auth_session_receipts",
		"coordinator_auth_sessions",
	].map((table) => f.db.prepare(`SELECT * FROM ${table}`).all());
}
