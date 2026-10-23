import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureControllerHistory } from "../../core/src/coordinator-auth-controller-history.js";
import type { AuthLinkStatement } from "../../core/src/coordinator-auth-link.js";
import { CoordinatorDeviceOwnershipEvidence } from "../../core/src/coordinator-device-ownership-evidence.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "../../core/src/coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "../../core/src/recipient-policy-identifiers.js";
import { resetCeremony, snapshot } from "./owner-ceremony-test-fixtures.js";

const db = env.COORDINATOR_DB;
const config = { coordinatorId: "coordinator-evidence" };
const timestamp = "2026-10-01T00:00:00.000Z";
const signer = {
	groupId: "evidence-group",
	deviceId: "evidence-device",
	publicKey: CANONICAL_PUBLIC_KEY,
	fingerprint: "a".repeat(64),
};
type Row = Record<string, string | number | null>;
const prepare = (s: AuthLinkStatement) => db.prepare(s.sql).bind(...s.values);
const backend = {
	first: <T>(s: AuthLinkStatement) => prepare(s).first<T>(),
	all: async <T>(s: AuthLinkStatement) => (await prepare(s).all<T>()).results,
};
const reader = () => new CoordinatorDeviceOwnershipEvidence(backend, config);
async function insert(table: string, row: Row) {
	const entries = Object.entries(row);
	await db
		.prepare(
			`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map(() => "?").join(",")})`,
		)
		.bind(...entries.map(([, value]) => value))
		.run();
}
async function state() {
	return {
		schema: (
			await db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()
		).results,
		rows: await snapshot(),
	};
}
async function readOnly<T>(action: () => Promise<T>) {
	const before = await state();
	const result = await action();
	expect(await state()).toEqual(before);
	return result;
}
async function input() {
	return {
		canonicalOwnerId: "A",
		actualSigner: { ...signer },
		verifiedHistory: await captureControllerHistory(
			{ coordinatorId: config.coordinatorId, ...signer },
			<T>(sql: string, values: string[]) => backend.all<T>({ sql, values }),
		),
	};
}
async function collect(api = reader()) {
	const captured = await input();
	return readOnly(() => api.collect(captured));
}
async function invitation(patch: Row = {}) {
	await insert("coordinator_invites", {
		invite_id: "evidence-invite",
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
async function controller() {
	const row = {
		attestation_id: "evidence-controller",
		coordinator_id: config.coordinatorId,
		identity_id: "A",
		group_id: "removed-source-group",
		device_id: signer.deviceId,
		public_key: `${signer.publicKey} retained-source-comment`,
		fingerprint: signer.fingerprint,
		review_receipt_id: "evidence-receipt",
		evidence_digest: "b".repeat(64),
		enrollment_identity_id: "C",
		revision: 1,
		created_at: timestamp,
		revoked_at: null,
	};
	await insert("coordinator_auth_controller_attestations", row);
	return {
		coordinator_id: row.coordinator_id,
		resolution_id: "evidence-resolution",
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
async function history() {
	const manifest = normalize({
		version: 1,
		coordinator_id: config.coordinatorId,
		candidate_ref: legacyTeamCandidateId(config.coordinatorId, "historical-group"),
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
		memberships: [{ identity_id: "C", role: "member" }],
		device_decisions: [
			{
				device_id: signer.deviceId,
				key_fingerprint: signer.fingerprint,
				enabled: true,
				identity_id: "C",
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: timestamp,
	});
	await insert("coordinator_legacy_team_completions", {
		group_id: "historical-group",
		candidate_ref: manifest.candidate_ref,
		manifest_version: 1,
		manifest_json: canonical(manifest),
		completed_at: timestamp,
		created_at: timestamp,
	});
}

beforeEach(async () => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await resetCeremony();
	await db.prepare("DELETE FROM coordinator_legacy_team_completions").run();
	await db
		.prepare("DELETE FROM coordinator_invites WHERE token=? OR invite_id=?")
		.bind("synthetic-token-do-not-capture", "evidence-invite")
		.run();
	await insert("groups", { group_id: signer.groupId, created_at: timestamp });
	await insert("enrolled_devices", {
		group_id: signer.groupId,
		device_id: signer.deviceId,
		public_key: signer.publicKey,
		fingerprint: signer.fingerprint,
		identity_id: "A",
		enabled: 1,
		created_at: timestamp,
	});
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

it.each([null, "A"])(
	"native current enrollment %s is compatible without authority or writes",
	async (label) => {
		// Arrange
		await db.prepare("UPDATE enrolled_devices SET identity_id=?").bind(label).run();
		// Act
		const result = await collect();
		// Assert
		expect(result).toMatchObject({ kind: "collected", decision: "compatible", weakLabels: [] });
		expect(result).not.toHaveProperty("authority");
		expect(result).not.toHaveProperty("authorized");
	},
);

it("native canonical included C history is weak metadata and leaves sharing untouched", async () => {
	// Arrange
	await history();
	await db.prepare("UPDATE enrolled_devices SET identity_id='C'").run();
	// Act
	const result = await collect();
	// Assert: full database comparison includes all sharing and memory-related tables.
	expect(result).toMatchObject({
		kind: "collected",
		decision: "weak_label_review_required",
		weakLabels: [
			expect.objectContaining({
				label: "C",
				kind: "legacy_included_owner_label",
				effect: "account_owner_display_only",
			}),
		],
	});
});

it("native C enrollment without provenance fails closed", async () => {
	// Arrange
	await db.prepare("UPDATE enrolled_devices SET identity_id='C'").run();
	// Act
	const result = await collect();
	// Assert
	expect(result).toEqual({ kind: "unavailable", authorizationUnavailable: true });
});

it.each(["exact-device", "invite-only-key-alias"])(
	"native consumed B team invitation blocks by %s after later revocation",
	async (match) => {
		// Arrange: the alias exists only in the invite, never in enrollment or controller history.
		await invitation(
			match === "invite-only-key-alias"
				? {
						bound_device_id: "invite-only-device",
						bound_public_key: `${signer.publicKey} invite-alias`,
					}
				: {},
		);
		// Act
		const result = await collect();
		// Assert
		expect(result).toMatchObject({ kind: "collected", decision: "owner_transfer_required" });
		expect(JSON.stringify(result)).not.toContain("synthetic-token-do-not-capture");
	},
);

it("native unconsumed B invitation contributes no strong fact", async () => {
	// Arrange
	await invitation({
		consumed_at: null,
		bound_device_id: null,
		bound_public_key: null,
		bound_fingerprint: null,
	});
	// Act
	const result = await collect();
	// Assert
	expect(result).toMatchObject({ kind: "collected", decision: "compatible" });
});

it("native immutable source pins verify after the historical source group is removed", async () => {
	// Arrange: no source group or source enrollment exists; original key text is retained.
	const sourceRef = await controller();
	const api = reader();
	// Act
	const result = await readOnly(() =>
		api.verifyControllerSource({ sourceRef, expectedOwnerId: "A", actualSigner: signer }),
	);
	// Assert
	expect(result).toEqual({ kind: "verified_controller_source" });
	expect(sourceRef.source_public_key).toBe(`${signer.publicKey} retained-source-comment`);
});

it.each(["revoked", "changed-original-key-text", "missing"])(
	"native source %s cannot verify",
	async (change) => {
		// Arrange: these synthetic row changes test retained evidence, not an operational writer.
		const sourceRef = await controller();
		if (change === "revoked")
			await db
				.prepare("UPDATE coordinator_auth_controller_attestations SET revoked_at=?")
				.bind("2026-10-02T00:00:00.000Z")
				.run();
		if (change === "changed-original-key-text")
			await db
				.prepare("UPDATE coordinator_auth_controller_attestations SET public_key=?")
				.bind(signer.publicKey)
				.run();
		if (change === "missing")
			await db.prepare("DELETE FROM coordinator_auth_controller_attestations").run();
		const api = reader();
		// Act
		const result = await readOnly(() =>
			api.verifyControllerSource({ sourceRef, expectedOwnerId: "A", actualSigner: signer }),
		);
		// Assert
		const kinds = {
			revoked: "source_revoked",
			"changed-original-key-text": "source_mismatch",
			missing: "source_missing",
		};
		expect(result).toEqual({ kind: kinds[change] });
	},
);

it("native atomic predicate changes from one to zero after a new B fact", async () => {
	// Arrange
	const api = reader();
	const captured = await collect(api);
	if (captured.kind !== "collected") throw new Error("Native collection fixture rejected");
	const statement = api.prepareAtomicRecheck(captured.recheckSnapshot);
	expect(await readOnly(() => backend.first(statement))).toEqual({ matches: 1 });
	await invitation();
	// Act: execute the already prepared SQL after the new fact, not JS preflight.
	const result = await readOnly(() => backend.first(statement));
	// Assert
	expect(result).toEqual({ matches: 0 });
});

it("native unrelated person's fact does not change the atomic predicate", async () => {
	// Arrange
	const api = reader();
	const captured = await collect(api);
	if (captured.kind !== "collected") throw new Error("Native collection fixture rejected");
	const statement = api.prepareAtomicRecheck(captured.recheckSnapshot);
	await insert("coordinator_device_ownership_bindings", {
		device_id: "unrelated-device",
		key_id: "f".repeat(64),
		identity_id: "B",
		coordinator_id: config.coordinatorId,
		binding_id: "unrelated-binding",
		provenance: "owner_enrollment",
		source_ref: "synthetic-birth",
		bound_at: timestamp,
	});
	// Act
	const result = await readOnly(() => backend.first(statement));
	// Assert
	expect(result).toEqual({ matches: 1 });
});

it("native serialized, fake, and other-reader snapshots cannot supply recheck authority", async () => {
	// Arrange
	const api = reader();
	const captured = await collect(api);
	if (captured.kind !== "collected") throw new Error("Native collection fixture rejected");
	const candidates = [
		api.prepareAtomicRecheck({ version: 1 }),
		api.prepareAtomicRecheck(JSON.parse(JSON.stringify(captured.recheckSnapshot))),
		reader().prepareAtomicRecheck(captured.recheckSnapshot),
	];
	// Act
	const results = await readOnly(() =>
		Promise.all(candidates.map((statement) => backend.first(statement))),
	);
	// Assert: only the opaque original object on its original reader can match.
	expect(JSON.stringify(captured.recheckSnapshot)).toBe('{"version":1}');
	expect(results).toEqual([{ matches: 0 }, { matches: 0 }, { matches: 0 }]);
});
