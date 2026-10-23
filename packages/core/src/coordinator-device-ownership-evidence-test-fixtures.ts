import { it } from "vitest";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { cfg, NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	type Backend,
	enroll,
	type Fixture,
	review,
	setupStore,
	sqliteD1,
} from "./coordinator-auth-store-test-fixtures.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

export { cfg, EXPECTED_KEY_ID };
export const timestamp = "2026-10-01T00:00:00.000Z";
export const signer = {
	groupId: "group-a",
	deviceId: "device-a",
	publicKey: CANONICAL_PUBLIC_KEY,
	fingerprint: "a".repeat(64),
};
export const otherKey =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM";
export type Row = Record<string, string | number | null>;
export function insert(f: Fixture, table: string, row: Row) {
	const columns = Object.keys(row);
	f.db
		.prepare(
			`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		)
		.run(...columns.map((column) => row[column]));
}

export function evidenceBackend(f: Fixture, backend: Backend) {
	const d1 = sqliteD1(f.db);
	return {
		async first<T>(statement: AuthLinkStatement): Promise<T | null> {
			if (backend === "D1") {
				return d1
					.prepare(statement.sql)
					.bind(...statement.values)
					.first<T>();
			}
			return (f.db.prepare(statement.sql).get(...statement.values) as T | undefined) ?? null;
		},
		async all<T>(statement: AuthLinkStatement): Promise<T[]> {
			if (backend === "D1") {
				return (
					(
						await d1
							.prepare(statement.sql)
							.bind(...statement.values)
							.all<T>()
					).results ?? []
				);
			}
			return f.db.prepare(statement.sql).all(...statement.values) as T[];
		},
	};
}
export function evidenceTest(backend: Backend) {
	return it.extend<{ f: Fixture }>({
		f: async ({ task: _task }, use) => {
			const f = setupStore(backend, { authClock: () => NOW });
			try {
				f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
				await enroll(f.store, review({ ...signer, identityId: "A" }));
				await use(f);
			} finally {
				await f.store.close();
				if (f.db.open) f.db.close();
			}
		},
	});
}
export function databaseSnapshot(f: Fixture) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}
export function controller(f: Fixture, patch: Row = {}) {
	const row = {
		attestation_id: "controller-a",
		coordinator_id: cfg.coordinatorId,
		identity_id: "A",
		group_id: "retained-group",
		device_id: signer.deviceId,
		public_key: signer.publicKey,
		fingerprint: signer.fingerprint,
		review_receipt_id: "receipt-a",
		evidence_digest: "b".repeat(64),
		enrollment_identity_id: "C",
		revision: 1,
		created_at: timestamp,
		revoked_at: null,
		...patch,
	};
	insert(f, "coordinator_auth_controller_attestations", row);
	return row;
}
export function binding(f: Fixture, patch: Row = {}) {
	insert(f, "coordinator_device_ownership_bindings", {
		device_id: signer.deviceId,
		key_id: EXPECTED_KEY_ID,
		identity_id: "B",
		coordinator_id: cfg.coordinatorId,
		binding_id: "binding-b",
		provenance: "owner_enrollment",
		source_ref: "synthetic-birth",
		bound_at: timestamp,
		...patch,
	});
}
export function claim(f: Fixture, patch: Row = {}) {
	insert(f, "coordinator_auth_device_claims", {
		claim_id: "claim-b",
		coordinator_id: cfg.coordinatorId,
		identity_id: "B",
		group_id: "retained-group",
		device_id: signer.deviceId,
		public_key: signer.publicKey,
		fingerprint: signer.fingerprint,
		key_id: EXPECTED_KEY_ID,
		attempt_id: "committed-attempt",
		issuer: cfg.issuer,
		auth_config_revision: cfg.revision,
		created_at_ms: NOW,
		...patch,
	});
}
export function invitation(f: Fixture, patch: Row = {}) {
	insert(f, "coordinator_invites", {
		invite_id: "invite-b",
		group_id: signer.groupId,
		token: "synthetic-token-do-not-capture",
		policy: "open",
		created_at: timestamp,
		expires_at: "2026-10-03T00:00:00.000Z",
		consumed_at: "2026-10-02T00:00:00.000Z",
		revoked_at: "2026-10-04T00:00:00.000Z",
		bound_device_id: signer.deviceId,
		bound_public_key: signer.publicKey,
		bound_fingerprint: signer.fingerprint,
		invite_kind: "team_member",
		assigned_identity_id: "B",
		target_identity_id: null,
		recipient_actor_id: "B",
		reviewed_preview_digest: "c".repeat(64),
		...patch,
	});
}
export function history(
	f: Fixture,
	patch: {
		label?: string;
		deviceId?: string;
		fingerprint?: string;
		decision?: "included" | "excluded";
	} = {},
) {
	const label = patch.label ?? "C";
	const included = patch.decision !== "excluded";
	const manifest = normalize({
		version: 1,
		coordinator_id: cfg.coordinatorId,
		candidate_ref: legacyTeamCandidateId(cfg.coordinatorId, "historical-group"),
		candidate_digest: "a".repeat(64),
		team_id: "historical-team",
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic Team",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: included ? [{ identity_id: label, role: "member" }] : [],
		device_decisions: [
			{
				device_id: patch.deviceId ?? signer.deviceId,
				key_fingerprint: patch.fingerprint ?? signer.fingerprint,
				enabled: true,
				identity_id: included ? label : null,
				decision: patch.decision ?? "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: timestamp,
	});
	insert(f, "coordinator_legacy_team_completions", {
		group_id: "historical-group",
		candidate_ref: manifest.candidate_ref,
		manifest_version: 1,
		manifest_json: canonical(manifest),
		completed_at: timestamp,
		created_at: timestamp,
	});
}
export async function collectInput(f: Fixture) {
	return {
		canonicalOwnerId: "A",
		actualSigner: { ...signer },
		verifiedHistory: await f.store.captureAuthControllerLegacyHistory({
			coordinatorId: cfg.coordinatorId,
			...signer,
		}),
	};
}

// A source reference uses the existing parsed resolution metadata, not an invented
// controller wire format. Its persistence is deliberately NOT proof of authority.
export function sourceRef(row: ReturnType<typeof controller>) {
	return {
		coordinator_id: row.coordinator_id,
		resolution_id: "resolution-a",
		resolution_version: 1,
		device_id: row.device_id,
		key_id: EXPECTED_KEY_ID,
		owner_identity_id: row.identity_id,
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		source_attestation_id: row.attestation_id,
		source_group_id: row.group_id,
		source_controller_revision: row.revision,
		source_public_key: row.public_key,
		source_fingerprint: row.fingerprint,
		source_enrollment_identity_id: row.enrollment_identity_id,
		source_created_at: row.created_at,
		source_review_receipt_id: row.review_receipt_id,
		source_evidence_digest: row.evidence_digest,
		resolution_evidence_digest: "d".repeat(64),
		reviewed_weak_labels_json: "[]",
		created_at: "2026-10-22T00:00:00.000Z",
	};
}
