// Completes the same legacy team twice on identical fixtures: once with the ported owner
// proof, whose capture reads are re-run as guards leading the winning batch, and once
// with the owner proof and winning INSERT as they were at 075d46647, whose capture was
// pinned inside the INSERT. Both run through today's store, which sends the pre-port proof
// with no guards, so its INSERT and denial read decide exactly as they did. Each check is
// flipped either before the capture reads or just before the winning transaction, in
// both backends and both resolution schema variants. Both must answer alike, reach the
// stage, and leave the same rows.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cfg, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { setupStore } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import * as copy from "./coordinator-legacy-completion-owner-proof-original-sql-test-fixtures.js";
import {
	beforeWinningBatch,
	completions,
	controllers,
	futureGroup,
	type manifest,
	ordinary,
	recovery,
	resolutions,
} from "./coordinator-legacy-completion-owner-proof-test-fixtures.js";
import {
	now,
	signer,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import { CoordinatorLegacyTeamCompletionConflictError } from "./coordinator-legacy-team-completion.js";

// Which owner proof and INSERT the stores use while a case runs. The mocks reach the
// pre-port copies through this holder: importing them in a factory would import the
// mocked compatibility module from inside its own factory.
const mode = vi.hoisted(() => ({
	original: false,
	copy: null as
		| null
		| typeof import("./coordinator-legacy-completion-owner-proof-original-sql-test-fixtures.js"),
}));
vi.mock("./coordinator-legacy-completion-owner-proof.js", async (importActual) => {
	const actual =
		await importActual<typeof import("./coordinator-legacy-completion-owner-proof.js")>();
	return {
		...actual,
		captureLegacyCompletionOwnerProof: (
			input: Parameters<typeof actual.captureLegacyCompletionOwnerProof>[0],
		) =>
			mode.original && mode.copy
				? mode.copy.captureLegacyCompletionOwnerProof(input)
				: actual.captureLegacyCompletionOwnerProof(input),
		// The pre-port proof carries its checks in its statements; it has no guards.
		legacyCompletionOwnerProofSql: (
			proof: Parameters<typeof actual.legacyCompletionOwnerProofSql>[0],
		) =>
			mode.original && mode.copy
				? { guards: [], ...mode.copy.legacyCompletionOwnerProofSql(proof) }
				: actual.legacyCompletionOwnerProofSql(proof),
	};
});
vi.mock("./coordinator-legacy-owner-compatibility.js", async (importActual) => {
	const actual = await importActual<typeof import("./coordinator-legacy-owner-compatibility.js")>();
	return {
		...actual,
		legacyCompletionInsertStatement: (
			input: Parameters<typeof actual.legacyCompletionInsertStatement>[0],
		) =>
			mode.original && mode.copy
				? mode.copy.originalLegacyCompletionInsertStatement({
						...input,
						proof: { ...input.proof, values: input.proof.values.map(String) },
					})
				: actual.legacyCompletionInsertStatement(input),
	};
});
mode.copy = copy;

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
	mode.original = false;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Kind = "SQLite" | "D1";
type Variant = "ready" | "missing";
type Stage = "capture" | "batch";
type Context = { sourceId: string; keyId: string };
type Change = (f: LinkFixture, context: Context) => void;
const run = (f: LinkFixture, sql: string, ...values: (string | number | null)[]) =>
	f.db.prepare(sql).run(...values);

function insertRow(f: LinkFixture, table: string, row: Record<string, unknown>) {
	const columns = Object.keys(row);
	f.db
		.prepare(
			`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
		)
		.run(...columns.map((column) => row[column]));
}

const otherBinding: Change = (f, { keyId }) =>
	insertRow(f, "coordinator_device_ownership_bindings", {
		device_id: signer.deviceId,
		key_id: keyId,
		identity_id: "identity-c",
		coordinator_id: f.cfg.coordinatorId,
		binding_id: "raced-binding",
		provenance: "owner_enrollment",
		source_ref: "raced-source",
		bound_at: now,
	});
const futureLabel: Change = (f) =>
	run(f, "UPDATE enrolled_devices SET identity_id='identity-c' WHERE group_id=?", futureGroup);
const groupArchived: Change = (f) =>
	run(f, "UPDATE groups SET archived_at=? WHERE group_id=?", now, futureGroup);

/**
 * Every check of the old winning INSERT, with a recovered owner A: each captured
 * category the INSERT pinned, its owner compatibility check, and its ordinary checks.
 */
const READY: Record<string, Change> = {
	none: () => undefined,
	"resolution catalog": (f) =>
		f.db.exec(`CREATE INDEX raced_resolution_index ON ${resolutions}(created_at)`),
	"resolution receipt": (f) => {
		const receipt = f.db.prepare(`SELECT * FROM ${resolutions} LIMIT 1`).get() as Record<
			string,
			unknown
		>;
		insertRow(f, resolutions, { ...receipt, resolution_id: "raced-resolution" });
	},
	"source controller revoked": (f, { sourceId }) =>
		run(f, `UPDATE ${controllers} SET revoked_at=? WHERE attestation_id=?`, now, sourceId),
	"consumed invite discovered": (f) =>
		insertRow(f, "coordinator_invites", {
			invite_id: "raced-invite",
			group_id: signer.groupId,
			token: "raced-token",
			policy: "open",
			created_at: now,
			expires_at: "2026-10-05T00:00:00.000Z",
			consumed_at: now,
			bound_device_id: signer.deviceId,
			bound_public_key: signer.publicKey,
			bound_fingerprint: signer.fingerprint,
			invite_kind: "team_member",
			recipient_actor_id: "identity-c",
		}),
	"invite digest": (f) =>
		run(
			f,
			"UPDATE coordinator_invites SET reviewed_preview_digest=? WHERE invite_id='completion-project'",
			"f".repeat(64),
		),
	"binding to another owner": otherBinding,
	"claim by another owner": (f) => {
		const claim = f.db
			.prepare("SELECT * FROM coordinator_auth_device_claims LIMIT 1")
			.get() as Record<string, unknown>;
		insertRow(f, "coordinator_auth_device_claims", {
			...claim,
			claim_id: "raced-claim",
			identity_id: "identity-c",
			device_id: signer.deviceId,
			key_id: "d".repeat(64),
			attempt_id: "raced-attempt",
		});
	},
	"source enrollment label": (f) =>
		run(
			f,
			"UPDATE enrolled_devices SET identity_id='identity-c' WHERE group_id=? AND device_id=?",
			signer.groupId,
			signer.deviceId,
		),
	"key revoked": (f, { keyId }) =>
		insertRow(f, "coordinator_device_revocations", {
			subject_kind: "ed25519_key",
			subject_value: keyId,
			revocation_id: "raced-revocation",
			evidence_group_id: signer.groupId,
			evidence_device_id: signer.deviceId,
			evidence_public_key: signer.publicKey,
			evidence_fingerprint: signer.fingerprint,
			created_at: now,
		}),
	"history metadata": (f) =>
		run(
			f,
			`UPDATE ${completions} SET created_at=? WHERE group_id='history-a'`,
			"2026-10-09T00:00:00.000Z",
		),
	"key alias enrolled": (f) => {
		run(f, "INSERT OR IGNORE INTO groups(group_id,created_at) VALUES ('alias-group','x')");
		run(
			f,
			"INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,enabled,created_at) VALUES ('alias-group','alias-device',?,?,1,'x')",
			`${signer.publicKey} alias`,
			signer.fingerprint,
		);
	},
	"future enrollment label": futureLabel,
	"future enrollment disabled": (f) =>
		run(f, "UPDATE enrolled_devices SET enabled=0 WHERE group_id=?", futureGroup),
	"group archived": groupArchived,
};

// A key alias enrolled before the capture; the change gives it another fingerprint, so
// only the key and fingerprint pairs differ.
const aliasSetup = READY["key alias enrolled"] as Change;
READY["key alias fingerprint"] = (f) =>
	run(
		f,
		"UPDATE enrolled_devices SET fingerprint=? WHERE device_id='alias-device'",
		"9".repeat(64),
	);
const SETUP: Record<string, Change> = { "key alias fingerprint": aliasSetup };

/** Without the resolution table: its catalog, owner compatibility and ordinary checks. */
const MISSING: Record<string, Change> = {
	none: () => undefined,
	"resolution table created": (f) => f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
	"binding to another owner": otherBinding,
	"future enrollment label": futureLabel,
	"group archived": groupArchived,
};

async function answer(kind: Kind, variant: Variant, name: string, stage: Stage, original: boolean) {
	const change = (variant === "ready" ? READY : MISSING)[name];
	if (!change) throw new Error(`unknown change ${name}`);
	const f = setupStore(kind, { authClock: () => NOW, accountSchema: "v2" }) as LinkFixture;
	f.cfg = { ...cfg };
	open.push(f);
	let value: ReturnType<typeof manifest>;
	let sourceId = "";
	if (variant === "ready") {
		const recovered = await recovery(f, kind);
		value = recovered.value;
		sourceId = recovered.result.controller.attestation_id;
	} else {
		f.db.exec(`DROP TABLE IF EXISTS ${resolutions}`);
		value = await ordinary(f);
	}
	const context = { sourceId, keyId: (await ed25519KeyIdForRevocation(signer.publicKey)) ?? "" };
	SETUP[name]?.(f, context);
	// The stage whose change actually landed before the store went on.
	let reached: Stage | null = null;
	if (stage === "capture") {
		change(f, context);
		reached = "capture";
	} else
		beforeWinningBatch(f, () => {
			change(f, context);
			reached = "batch";
		});
	if (!mode.copy) throw new Error("pre-port copy not loaded");
	mode.original = original;
	const outcome = await f.store.createLegacyTeamCompletion(futureGroup, value).then(
		(result) => ({ result }),
		(error: unknown) => ({
			error: String(error),
			conflict: error instanceof CoordinatorLegacyTeamCompletionConflictError,
		}),
	);
	mode.original = false;
	return { reached, outcome, rows: snapshot(f) };
}

for (const kind of ["SQLite", "D1"] as const)
	for (const [variant, checks] of [
		["ready", READY],
		["missing", MISSING],
	] as const)
		describe(`${kind}, ${variant} resolution schema: legacy completion owner proof equivalence`, () => {
			const cases = Object.keys(checks).flatMap((name) =>
				(["capture", "batch"] as const).map((stage) => [`${stage}: ${name}`, name, stage] as const),
			);
			it.each(cases)("%s", async (_label, name, stage) => {
				// Arrange, Act: the same change at the same stage for both owner proofs.
				const original = await answer(kind, variant, name, stage, true);
				const ported = await answer(kind, variant, name, stage, false);
				// Assert: both reached the stage, answered alike and left the same rows.
				expect(original.reached).toBe(stage);
				expect(ported).toEqual(original);
			});
		});
