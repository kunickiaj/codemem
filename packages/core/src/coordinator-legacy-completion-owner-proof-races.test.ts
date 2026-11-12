// A legacy team completion captures the owner evidence of its recovered subjects with
// small reads, decides in TypeScript, and writes in one transaction (one D1 batch) that
// a guard per capture read leads. A change to any captured category that lands just
// before that transaction must refuse the completion as unavailable, write nothing, and
// leave the change in place. Several changes would also fail the INSERT's own owner
// check; only the guards make the refusal "unavailable" rather than a conflict.
import { afterEach, beforeEach, expect, vi } from "vitest";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	beforeWinningBatch,
	completions,
	controllers,
	futureGroup,
	recovery,
	resolutions,
} from "./coordinator-legacy-completion-owner-proof-test-fixtures.js";
import {
	now,
	signer,
	snapshot,
} from "./coordinator-legacy-owner-resolution-commit-test-fixtures.js";
import { CoordinatorLegacyTeamCompletionConflictError } from "./coordinator-legacy-team-completion.js";

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

/** Applied synchronously, so it lands before the winning transaction starts. */
type Change = (f: LinkFixture, context: { sourceId: string; keyId: string }) => void;
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

/** One change per captured category, named by the guard that must see it. */
const CHANGES: Record<string, Change> = {
	schema: (f) => f.db.exec(`CREATE INDEX raced_resolution_index ON ${resolutions}(created_at)`),
	resolutions: (f) => {
		// A second receipt for the same device and owner, under a fresh identifier.
		const receipt = f.db.prepare(`SELECT * FROM ${resolutions} LIMIT 1`).get() as Record<
			string,
			unknown
		>;
		insertRow(f, resolutions, {
			...receipt,
			resolution_id: "raced-resolution",
		});
	},
	"controllers (source revoked)": (f, { sourceId }) =>
		run(f, `UPDATE ${controllers} SET revoked_at=? WHERE attestation_id=?`, now, sourceId),
	"discovery and invites (new consumed invite)": (f) =>
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
	"invites (reviewed digest)": (f) =>
		run(
			f,
			"UPDATE coordinator_invites SET reviewed_preview_digest=? WHERE invite_id='completion-project'",
			"f".repeat(64),
		),
	"bindings (other owner)": (f, { keyId }) =>
		insertRow(f, "coordinator_device_ownership_bindings", {
			device_id: signer.deviceId,
			key_id: keyId,
			identity_id: "identity-c",
			coordinator_id: f.cfg.coordinatorId,
			binding_id: "raced-binding",
			provenance: "owner_enrollment",
			source_ref: "raced-source",
			bound_at: now,
		}),
	"claims (other owner)": (f) => {
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
	"enrollment (other label)": (f) =>
		run(
			f,
			"UPDATE enrolled_devices SET identity_id='identity-c' WHERE group_id=? AND device_id=?",
			signer.groupId,
			signer.deviceId,
		),
	revocations: (f, { keyId }) =>
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
	"history (metadata)": (f) =>
		run(
			f,
			`UPDATE ${completions} SET created_at=? WHERE group_id='history-a'`,
			"2026-10-09T00:00:00.000Z",
		),
	"historyKeys and historyDiscovery (key alias)": (f) => {
		run(f, "INSERT OR IGNORE INTO groups(group_id,created_at) VALUES ('alias-group','x')");
		run(
			f,
			"INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,enabled,created_at) VALUES ('alias-group','alias-device',?,?,1,'x')",
			`${signer.publicKey} alias`,
			signer.fingerprint,
		);
	},
};

/** Changes that need an earlier row, set up before the capture reads. */
const SETUP: Record<string, (f: LinkFixture) => void> = {
	"historyKeys (alias fingerprint)": (f) => {
		run(f, "INSERT OR IGNORE INTO groups(group_id,created_at) VALUES ('alias-group','x')");
		run(
			f,
			"INSERT INTO enrolled_devices (group_id,device_id,public_key,fingerprint,enabled,created_at) VALUES ('alias-group','alias-device',?,?,1,'x')",
			`${signer.publicKey} alias`,
			signer.fingerprint,
		);
	},
};
// The alias keeps its key text, so only the key and fingerprint pairs change.
CHANGES["historyKeys (alias fingerprint)"] = (f) =>
	run(
		f,
		"UPDATE enrolled_devices SET fingerprint=? WHERE device_id='alias-device'",
		"9".repeat(64),
	);

for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind, { accountSchema: "v2" });
	test(`${kind}: an unchanged capture writes the completion`, async ({ fixture: f }) => {
		// Arrange
		const { value } = await recovery(f, kind);
		const hook = beforeWinningBatch(f, () => undefined);
		// Act
		const result = await f.store.createLegacyTeamCompletion(futureGroup, value);
		// Assert
		expect(result.status).toBe("created");
		expect(hook.injected()).toBe(true);
	});

	test.for(Object.keys(CHANGES))(
		`${kind}: a %s change just before the winning batch refuses as unavailable`,
		async (name, { fixture: f }) => {
			// Arrange: the capture has read the old rows; the change lands before its guards.
			const { value, result: recovered } = await recovery(f, kind);
			SETUP[name]?.(f);
			const change = CHANGES[name];
			if (!change) throw new Error(`unknown change ${name}`);
			const context = {
				sourceId: recovered.controller.attestation_id,
				keyId: (await ed25519KeyIdForRevocation(signer.publicKey)) ?? "",
			};
			let changed: ReturnType<typeof snapshot> | undefined;
			const hook = beforeWinningBatch(f, () => {
				change(f, context);
				changed = snapshot(f);
			});
			// Act
			const outcome = await f.store.createLegacyTeamCompletion(futureGroup, value).then(
				(result) => ({ result }),
				(error: unknown) => ({ error }),
			);
			// Assert: refused as unavailable, nothing written, the change kept.
			expect(hook.injected()).toBe(true);
			expect(outcome).toMatchObject({ error: expect.any(Error) });
			const { error } = outcome as { error: Error };
			expect(error).not.toBeInstanceOf(CoordinatorLegacyTeamCompletionConflictError);
			expect(error.message).toBe("completion_manifest_unavailable");
			expect(changed).toBeDefined();
			expect(snapshot(f)).toEqual(changed);
		},
	);
}
