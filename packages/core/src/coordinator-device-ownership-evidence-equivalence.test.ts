// Collects the same ownership evidence twice on identical fixtures: once with the ported
// collector, whose capture is a read set and whose recheck is its guards, and once with
// the collector as it was at 075d46647, whose capture and recheck were single statements.
// Each check is flipped either before the capture or between the capture and its recheck,
// in both backends and both resolution schema variants. The answers must agree: the
// collection, its reviewed digest, and whether the recheck still matches. Without the
// resolution table a collection refuses, so that variant has no recheck to flip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOW } from "./coordinator-auth-link-test-fixtures.js";
import {
	enroll,
	type Fixture,
	review,
	setupStore,
} from "./coordinator-auth-store-test-fixtures.js";
import { CoordinatorDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence.js";
import { OriginalDeviceOwnershipEvidence } from "./coordinator-device-ownership-evidence-original-sql-test-fixtures.js";
import {
	binding,
	cfg,
	claim,
	collectInput,
	controller,
	evidenceBackend,
	history,
	insert,
	invitation,
	otherKey,
	recheckMatches,
	signer,
	sourceRef,
} from "./coordinator-device-ownership-evidence-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
const open: Fixture[] = [];
afterEach(async () => {
	for (const f of open.splice(0)) {
		await f.store.close();
		if (f.db.open) f.db.close();
	}
	vi.restoreAllMocks();
});

type Backend = "SQLite" | "D1";
type Variant = "ready" | "missing";
type Stage = "capture" | "recheck";
const RESOLUTIONS = "coordinator_legacy_owner_resolutions";
const RACED = "2026-10-05T00:00:00.000Z";

/** One subject with evidence in every category the checks below flip. */
async function seeded(kind: Backend, variant: Variant) {
	const f = setupStore(kind, { authClock: () => NOW });
	open.push(f);
	if (variant === "ready") f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	else f.db.exec(`DROP TABLE IF EXISTS ${RESOLUTIONS}`);
	await enroll(f.store, review({ ...signer, identityId: "A" }));
	controller(f, { identity_id: "A", enrollment_identity_id: null });
	invitation(f, { assigned_identity_id: "A", recipient_actor_id: "A" });
	history(f, { label: "A" });
	return f;
}

const set = (f: Fixture, sql: string, ...values: (string | number | null)[]) =>
	f.db.prepare(sql).run(...values);

/** Every category the old capture selected and its atomic recheck compared, flipped. */
const CHECKS: Record<string, (f: Fixture, variant: Variant) => void> = {
	none: () => undefined,
	"discovered controller, other owner": (f) =>
		controller(f, {
			attestation_id: "raced-controller",
			review_receipt_id: "raced-receipt",
			group_id: "raced-group",
			identity_id: "B",
		}),
	"discovered controller receipt": (f) =>
		set(
			f,
			"UPDATE coordinator_auth_controller_attestations SET review_receipt_id='changed-receipt'",
		),
	"discovered invite unrevoked": (f) =>
		set(f, "UPDATE coordinator_invites SET revoked_at=NULL WHERE invite_id='invite-b'"),
	"discovery by unparsed key": (f) =>
		controller(f, {
			attestation_id: "unparsed-controller",
			review_receipt_id: "unparsed-receipt",
			group_id: "unparsed-group",
			device_id: "unparsed-device",
			public_key: "not-a-key",
		}),
	binding: (f) => binding(f),
	claim: (f) => claim(f),
	"enrollment label": (f) =>
		set(f, "UPDATE enrolled_devices SET identity_id='A' WHERE device_id=?", signer.deviceId),
	"enrollment disabled": (f) =>
		set(f, "UPDATE enrolled_devices SET enabled=0 WHERE device_id=?", signer.deviceId),
	revocation: (f) =>
		insert(f, "coordinator_device_revocations", {
			subject_kind: "device_id",
			subject_value: signer.deviceId,
			revocation_id: "raced-revocation",
			evidence_group_id: signer.groupId,
			evidence_device_id: signer.deviceId,
			evidence_public_key: signer.publicKey,
			evidence_fingerprint: signer.fingerprint,
			created_at: RACED,
		}),
	resolution: (f, variant) => {
		if (variant === "missing") return f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
		const source = controller(f, {
			attestation_id: "resolved-source",
			review_receipt_id: "resolved-receipt",
			group_id: "resolved-group",
		});
		insert(f, RESOLUTIONS, sourceRef(source));
	},
	schema: (f, variant) =>
		variant === "ready"
			? f.db.exec(`CREATE INDEX raced_resolution_index ON ${RESOLUTIONS}(created_at)`)
			: f.db.exec(`CREATE TABLE ${RESOLUTIONS} (device_id TEXT)`),
	"history record": (f) =>
		set(
			f,
			`INSERT INTO coordinator_legacy_team_completions
			(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
			SELECT 'second-group',candidate_ref || '-2',manifest_version,manifest_json,completed_at,created_at
			FROM coordinator_legacy_team_completions`,
		),
	"history metadata": (f) =>
		set(f, "UPDATE coordinator_legacy_team_completions SET created_at=?", RACED),
	"history key alias": (f) => {
		set(f, "INSERT OR IGNORE INTO groups(group_id,created_at) VALUES ('alias-group','x')");
		set(
			f,
			`INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,enabled,created_at)
			VALUES ('alias-group','alias-device',?,?,1,'x')`,
			`${signer.publicKey} alias`,
			signer.fingerprint,
		);
	},
	"unrelated person's binding": (f) =>
		binding(f, { device_id: "unrelated-device", key_id: "f".repeat(64), binding_id: "other" }),
	"unrelated enrollment": (f) => {
		set(f, "INSERT OR IGNORE INTO groups(group_id,created_at) VALUES ('other-group','x')");
		set(
			f,
			`INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,enabled,created_at)
			VALUES ('other-group','other-device',?,?,1,'x')`,
			otherKey,
			"9".repeat(64),
		);
	},
};

/** What one collector answered, and the stage the change landed before. */
async function answer(
	kind: Backend,
	variant: Variant,
	check: (f: Fixture, variant: Variant) => void,
	stage: Stage,
	collector: "ported" | "original",
) {
	const f = await seeded(kind, variant);
	const backend = evidenceBackend(f, kind);
	const reader =
		collector === "ported"
			? new CoordinatorDeviceOwnershipEvidence(backend, cfg)
			: new OriginalDeviceOwnershipEvidence(backend, cfg);
	const input = await collectInput(f);
	// The stages whose change actually ran before the collector read again.
	const reached: Stage[] = [];
	if (stage === "capture") {
		check(f, variant);
		reached.push("capture");
	}
	const collected = await reader.collect(input);
	if (collected.kind !== "collected") return { reached, collected, digest: null, recheck: null };
	const digest = await reader.reviewedEvidenceDigest(collected.recheckSnapshot);
	if (stage === "recheck") {
		check(f, variant);
		reached.push("recheck");
	}
	let recheck: { matches: number } | null;
	if (reader instanceof OriginalDeviceOwnershipEvidence)
		recheck = await backend.first<{ matches: number }>(
			reader.prepareAtomicRecheck(collected.recheckSnapshot),
		);
	else recheck = await recheckMatches(backend, reader.recheckGuards(collected.recheckSnapshot));
	return { reached, collected, digest, recheck };
}

for (const kind of ["SQLite", "D1"] as const)
	for (const variant of ["ready", "missing"] as const)
		describe(`${kind}, ${variant} resolution schema: ownership evidence equivalence`, () => {
			const stages =
				variant === "ready" ? (["capture", "recheck"] as const) : (["capture"] as const);
			const cases = Object.entries(CHECKS).flatMap(([name, check]) =>
				stages.map((stage) => [`${stage}: ${name}`, check, stage] as const),
			);
			it.each(cases)("%s", async (name, check, stage) => {
				// Arrange, Act: the same change at the same stage for both collectors.
				const original = await answer(kind, variant, check, stage, "original");
				const ported = await answer(kind, variant, check, stage, "ported");
				// Assert: the change reached its stage in both, and every answer agrees. Without
				// the resolution table, only a change that creates it lets a collection through.
				expect(original.reached).toEqual([stage]);
				if (variant === "missing")
					expect(original.collected.kind).toBe(
						name === "capture: resolution" ? "collected" : "unavailable",
					);
				expect(ported).toEqual(original);
			});
		});
