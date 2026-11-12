// Commits the same reviewed owner resolution twice on identical fixtures: once through the
// ported commit, whose snapshot, owner and evidence checks are read-set guards, and once
// through the commit as it was at 075d46647, whose checks sat in WITH stages of its batch.
// Each check is flipped either before the commit's reads or just before its one batch, for
// new and reused controllers, in both resolution schema variants. Both must answer alike
// and leave the same rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupV2Store } from "./coordinator-account-schema-sqlite-test-fixtures.js";
import type { AuthLinkStatement } from "./coordinator-auth-link.js";
import { cfg, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { OriginalDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence-original-sql-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { commitReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit.js";
import { commitOriginalReviewedOwnerResolution } from "./coordinator-legacy-owner-resolution-commit-original-sql-test-fixtures.js";
import {
	backendFor,
	buildReview,
	controllerTable,
	now,
	originalController,
	resolutionTable,
	seed,
	signer,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";

// Both runs stamp their fixtures at the same time, so their rows compare exactly.
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(NOW));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
const open: LinkFixture[] = [];
afterEach(async () => {
	for (const f of open.splice(0)) {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Kind = "SQLite" | "D1";
type Variant = "ready" | "missing";
type Stage = "reads" | "batch";
type Change = (f: LinkFixture, keyId: string) => void;
const RACED = "2026-10-09T00:00:00.000Z";
const set = (f: LinkFixture, sql: string, ...values: (string | number | null)[]) =>
	f.db.prepare(sql).run(...values);

/**
 * Every check the old batch made: snapshot invites and history, authority, owner target
 * and its claim and controller conflicts, evidence, catalog and pins.
 */
const CHECKS: Record<string, Change> = {
	none: () => undefined,
	"history metadata": (f) =>
		set(f, "UPDATE coordinator_legacy_team_completions SET created_at=?", RACED),
	"history added": (f) =>
		set(
			f,
			`INSERT INTO coordinator_legacy_team_completions
			(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
			SELECT 'second-history',candidate_ref || '-2',manifest_version,manifest_json,completed_at,created_at
			FROM coordinator_legacy_team_completions LIMIT 1`,
		),
	"enrollment label": (f) =>
		set(
			f,
			"UPDATE enrolled_devices SET identity_id='identity-d' WHERE device_id=?",
			signer.deviceId,
		),
	"enrollment disabled": (f) =>
		set(f, "UPDATE enrolled_devices SET enabled=0 WHERE device_id=?", signer.deviceId),
	"enrollment key text": (f) =>
		set(
			f,
			"UPDATE enrolled_devices SET public_key=public_key || ' changed' WHERE device_id=?",
			signer.deviceId,
		),
	"group archived": (f) =>
		set(f, "UPDATE groups SET archived_at=? WHERE group_id=?", RACED, signer.groupId),
	"device revoked": (f) => revocation(f, "device_id", signer.deviceId),
	"key revoked": (f, keyId) => revocation(f, "ed25519_key", keyId),
	"link revoked": (f) =>
		set(f, `UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW + 1}`),
	"link generation": (f) =>
		set(f, "UPDATE coordinator_auth_account_links SET created_at_ms=created_at_ms+1"),
	"link issuer": (f) =>
		set(f, "UPDATE coordinator_auth_account_links SET issuer='https://changed.example.test'"),
	"link deleted": (f) => set(f, "DELETE FROM coordinator_auth_account_links"),
	"link provenance": (f) =>
		set(f, "UPDATE coordinator_auth_link_attempts SET account_subject='changed'"),
	"other-owner binding": (f) =>
		set(
			f,
			`INSERT INTO coordinator_device_ownership_bindings
			(device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
			VALUES (?,?,'identity-b',?,'raced-binding','owner_enrollment','raced-source',?)`,
			signer.deviceId,
			"e".repeat(64),
			cfg.coordinatorId,
			RACED,
		),
	"resolution catalog": (f) =>
		f.db.exec(
			`CREATE TABLE IF NOT EXISTS ${resolutionTable} (device_id TEXT); CREATE INDEX raced_resolution_index ON ${resolutionTable}(device_id)`,
		),
	"controller receipt": (f) =>
		set(f, `UPDATE ${controllerTable} SET review_receipt_id='raced-receipt'`),
	"consumed invite": (f) =>
		insertRow(f, "coordinator_invites", {
			invite_id: "raced-invite",
			group_id: signer.groupId,
			token: "raced-token",
			policy: "auto_admit",
			expires_at: RACED,
			created_at: RACED,
			consumed_at: RACED,
			bound_device_id: signer.deviceId,
			bound_public_key: signer.publicKey,
			bound_fingerprint: signer.fingerprint,
			invite_kind: "team_member",
		}),
	"owner claim conflict": (f) => {
		// A copy of the owner's claim, for this enrollment but another Identity. Each
		// identifier is fresh, as claims never share one.
		const claim = f.db.prepare("SELECT * FROM coordinator_auth_device_claims LIMIT 1").get();
		insertRow(f, "coordinator_auth_device_claims", {
			...(claim as Record<string, unknown>),
			claim_id: "raced-claim",
			identity_id: "identity-b",
			device_id: signer.deviceId,
			key_id: "d".repeat(64),
			attempt_id: "raced-attempt",
		});
	},
	"owner controller conflict": (f) =>
		insertRow(f, controllerTable, {
			attestation_id: "raced-controller",
			coordinator_id: cfg.coordinatorId,
			identity_id: "identity-b",
			group_id: "raced-group",
			device_id: signer.deviceId,
			public_key: signer.publicKey,
			fingerprint: signer.fingerprint,
			review_receipt_id: "raced-controller-receipt",
			evidence_digest: "b".repeat(64),
			enrollment_identity_id: null,
			revision: 1,
			created_at: RACED,
			revoked_at: null,
		}),
};

function insertRow(f: LinkFixture, table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	f.db
		.prepare(
			`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		)
		.run(...columns.map((column) => row[column]));
}

function revocation(f: LinkFixture, kind: string, value: string) {
	set(
		f,
		`INSERT INTO coordinator_device_revocations (subject_kind,subject_value,revocation_id,
		evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
		VALUES (?,?,'raced-revocation',?,?,?,?,?)`,
		kind,
		value,
		signer.groupId,
		signer.deviceId,
		signer.publicKey,
		signer.fingerprint,
		RACED,
	);
}

/** One commit's answer: its receipts, or the error it threw, with the rows it left. */
async function answer(
	kind: Kind,
	variant: Variant,
	options: { reuse: boolean; change: Change; stage: Stage; original: boolean },
) {
	const f = (
		kind === "SQLite"
			? setupV2Store({ authClock: () => NOW })
			: setupStore(kind, { authClock: () => NOW })
	) as LinkFixture;
	f.cfg = { ...cfg };
	open.push(f);
	const h = backendFor(f, kind);
	// A reused controller needs an ordinary label; a new one is reviewed over weak label C.
	await seed(f, h, { weakCurrent: !options.reuse });
	const existing = options.reuse ? await originalController(f) : null;
	const review = await buildReview(f, { existingController: existing });
	// The missing variant: the reviewed deployment has no resolution table at commit time.
	if (variant === "missing") f.db.exec(`DROP TABLE ${resolutionTable}`);
	const keyId = (await ed25519KeyIdForRevocation(signer.publicKey)) ?? "";
	let reached: Stage | null = null;
	if (options.stage === "reads") {
		options.change(f, keyId);
		reached = "reads";
	} else
		h.hooks.beforeBatch = () => {
			// Marked only once the change applied, so a change that fails reaches nothing.
			options.change(f, keyId);
			reached = "batch";
		};
	const backend = h.backend;
	const evidenceBackend = {
		first: backend.first,
		readBatch: backend.readBatch,
		all: async <T>({ sql, values }: AuthLinkStatement) => f.db.prepare(sql).all(...values) as T[],
	};
	const commit = options.original
		? commitOriginalReviewedOwnerResolution({
				backend,
				evidence: new OriginalDeviceOwnershipEvidence(evidenceBackend, f.cfg),
				review,
				now,
			})
		: commitReviewedOwnerResolution({ backend, evidence: h.evidence, review, now });
	const result = await commit.catch((error: unknown) => ({ thrown: String(error) }));
	return { result, reached, rows: snapshot(f) };
}

for (const kind of ["SQLite", "D1"] as const)
	for (const variant of ["ready", "missing"] as const)
		describe(`${kind}, ${variant} resolution schema: owner resolution commit equivalence`, () => {
			const cases = Object.entries(CHECKS).flatMap(([name, change]) =>
				[false, true].flatMap((reuse) =>
					(["reads", "batch"] as const).map(
						(stage) =>
							[
								`${reuse ? "reuse" : "create"}, ${stage}: ${name}`,
								{ reuse, change, stage },
							] as const,
					),
				),
			);
			it.each(cases)("%s", async (_name, c) => {
				// Arrange, Act: the same review and change on two identical fixtures.
				const original = await answer(kind, variant, { ...c, original: true });
				const ported = await answer(kind, variant, { ...c, original: false });
				// Assert: the change reached its stage in both, and both answered alike. Without
				// the resolution table, both refuse while collecting, before any batch.
				const batchReached = variant === "ready" || c.stage === "reads";
				expect(original.reached).toBe(batchReached ? c.stage : null);
				expect(ported).toEqual(original);
			});
		});
