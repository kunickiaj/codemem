import { expect } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import type { LinkFixture } from "./coordinator-auth-link-test-fixtures.js";
import type { Backend } from "./coordinator-auth-store-test-fixtures.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import {
	buildReview,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import type { LegacyOwnerResolutionRecord } from "./coordinator-legacy-owner-resolution-metadata.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	existingFact,
	setupReview,
	signer,
} from "./coordinator-owner-resolution-review-test-fixtures.js";

export { signer, snapshot };
export const selectedOwnerId = "identity-a";
export const safeProfile = {
	displayName: "Synthetic Owner A",
	email: "owner-a@example.test",
	pictureUrl: "https://lh3.googleusercontent.com/synthetic-owner-a",
};

/**
 * A linked owner's profile as a device running as another Identity sees it:
 * an empty object, never the name, email, or picture (ADR 0005 Section 8).
 */
export const withheldProfile = expect.toSatisfy(
	(value: unknown) => JSON.stringify(value) === "{}",
	"withheld owner profile",
);

export function databaseSnapshot(f: LinkFixture) {
	return {
		catalog: f.db
			.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
			.all(),
		tables: snapshot(f),
	};
}

export function seedCurrentProfile(
	f: LinkFixture,
	options: { attemptId?: string; profile?: typeof safeProfile } = {},
) {
	// Derive every provenance/generation field from the actual finalized birth.
	// The extension's order zero denotes its migrated verified birth profile.
	f.db
		.prepare(`INSERT INTO coordinator_auth_link_profiles
		(coordinator_id,attempt_id,issuer,subject,auth_config_revision,browser_transaction_hash,
		link_id,display_name,email,email_verified,picture_url,verified_at_ms,source_order)
		SELECT coordinator_id,attempt_id,issuer,account_subject,auth_config_revision,browser_transaction_hash,
		link_id,?,?,1,?,oidc_verified_at_ms,0 FROM coordinator_auth_link_attempts WHERE state='finalized' AND attempt_id=?`)
		.run(
			(options.profile ?? safeProfile).displayName,
			(options.profile ?? safeProfile).email,
			(options.profile ?? safeProfile).pictureUrl,
			options.attemptId ?? "completed-attempt",
		);
}

export function strongOtherOwner(f: LinkFixture) {
	// Real persisted thirteen-field strong controller source, not caller-classified evidence.
	f.db.exec(`INSERT INTO coordinator_auth_controller_attestations
	(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,
	review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at)
	SELECT 'strong-b',coordinator_id,'identity-b','strong-b-group',device_id,public_key,fingerprint,
	'receipt-b',evidence_digest,NULL,revision,created_at,NULL FROM coordinator_auth_controller_attestations LIMIT 1`);
}

export function overflowSources(f: LinkFixture, options: { rows: number; commentBytes: number }) {
	const insert = f.db.prepare(`INSERT INTO coordinator_auth_controller_attestations
	(attestation_id,coordinator_id,identity_id,group_id,device_id,public_key,fingerprint,
	review_receipt_id,evidence_digest,enrollment_identity_id,revision,created_at,revoked_at)
	SELECT ?,coordinator_id,identity_id,?,device_id,public_key || ?,fingerprint,
	?,evidence_digest,enrollment_identity_id,revision,created_at,NULL
	FROM coordinator_auth_controller_attestations WHERE attestation_id='original-controller'`);
	f.db.transaction(() => {
		for (let i = 0; i < options.rows; i++) {
			insert.run(
				`overflow-${i}`,
				`overflow-group-${i}`,
				` ${"x".repeat(options.commentBytes)}`,
				`overflow-receipt-${i}`,
			);
		}
	})();
}

export async function setupResolved(
	f: LinkFixture,
	kind: Backend,
	options: { fact?: boolean } = {},
) {
	f.cfg.issuer = "https://accounts.google.com";
	const original = await setupReview(f, kind);
	seedCurrentProfile(f);
	const fact =
		options.fact === false ? null : await existingFact(f, original, { retainedSource: true });
	const finalRead = { inject: undefined as (() => void) | undefined, count: 0 };
	const statements: AuthLinkStatement[] = [];
	function before(statement: AuthLinkStatement) {
		statements.push(statement);
		// Match behavior-bearing tables, not a particular CTE spelling/template.
		if (!/coordinator_auth_(?:account|link)_profiles/.test(statement.sql)) return;
		if (!statement.sql.includes("coordinator_legacy_owner_resolutions")) return;
		finalRead.count++;
		const inject = finalRead.inject;
		finalRead.inject = undefined;
		inject?.();
	}
	const backend = {
		...original.backend,
		async first<T>(statement: AuthLinkStatement): Promise<T | null> {
			before(statement);
			return original.backend.first<T>(statement);
		},
		async all<T>(statement: AuthLinkStatement): Promise<T[]> {
			before(statement);
			return original.backend.all<T>(statement);
		},
	};
	return { ...original, backend, fact, finalRead, statements };
}
export type ResolvedHarness = Awaited<ReturnType<typeof setupResolved>>;

export function replaceFacts(f: LinkFixture, rows: LegacyOwnerResolutionRecord[]) {
	// Simulate an imported/corrupted persisted database without disabling immutability
	// on the production schema. Reinstall the exact accepted DDL before the read.
	f.db.exec("DROP TABLE coordinator_legacy_owner_resolutions");
	f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	for (const row of rows) {
		const entries = Object.entries(row);
		f.db
			.prepare(
				`INSERT INTO coordinator_legacy_owner_resolutions (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
			)
			.run(...entries.map(([, value]) => value));
	}
}

export async function appendLegitimateFact(f: LinkFixture, h: ResolvedHarness) {
	if (!h.fact) throw new Error("fixture requires original persisted fact");
	return commitReviewedOwnerResolution({
		backend: h.backend,
		evidence: h.evidence,
		review: await buildReview(f, {
			existingController: h.fact.controller,
			resolutionId: "resolution-second",
		}),
		now: h.fact.resolution.created_at,
	});
}

export function sourceController(f: LinkFixture, h: ResolvedHarness, assignment: string) {
	if (!h.fact) throw new Error("fixture requires original persisted fact");
	f.db
		.prepare(
			`UPDATE coordinator_auth_controller_attestations SET ${assignment} WHERE attestation_id=?`,
		)
		.run(h.fact.controller.attestation_id);
}

export function expectNoDisclosure(value: unknown) {
	expectDisplayOnly(value);
	expect(value).toMatchObject({
		state: "owner_unconfirmed",
		ownerIdentity: null,
		profileState: "unavailable",
		profile: null,
	});
	expect(JSON.stringify(value)).not.toContain(safeProfile.email);
}

export function expectDisplayOnly(value: unknown) {
	expect(Object.keys(value as object).sort()).toEqual(
		[
			"version",
			"coordinatorId",
			"groupId",
			"deviceId",
			"fingerprint",
			"state",
			"ownerIdentity",
			"profileState",
			"profile",
		].sort(),
	);
	expect(JSON.stringify(value)).not.toMatch(
		/authority|canLink|grants|actions|eligibility|publicKey|private-claim-subject|evidenceDigest|sourceRef/,
	);
}
