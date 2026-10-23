import { afterEach, beforeEach, expect, vi } from "vitest";
import {
	controllerLinkEvidenceSql,
	otherKey,
	seedClaimSql,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import {
	applyAccountConnectionSchema,
	readConnectionSchemaState,
} from "./coordinator-account-connection-schema.js";
import { CONNECTION_BIRTH_COLUMNS } from "./coordinator-account-connection-storage.js";
import {
	AccountOwnerTargetOperations,
	type CoordinatorAccountOwnerTargetInput,
} from "./coordinator-account-owner-target.js";
import type { CoordinatorAuthControllerStore } from "./coordinator-auth-controller.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import { backendTest, type LinkFixture, NOW } from "./coordinator-auth-link-test-fixtures.js";
import { review, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import {
	canonicalCoordinatorLegacyTeamCompletionManifestJson as canonical,
	normalizeCoordinatorLegacyTeamCompletionManifest as normalize,
} from "./coordinator-legacy-team-completion.js";
import { legacyTeamCandidateId } from "./recipient-policy-identifiers.js";

const signer = {
	groupId: "group-a",
	deviceId: "current-laptop",
	publicKey: otherKey,
	fingerprint: "c".repeat(64),
};
const input = { targetIdentityId: "identity-a", signer };
const unavailable = { kind: "unavailable" };
type Reviews = Pick<CoordinatorAuthControllerStore, "getActiveAuthControllerAttestation">;

function backendFor(f: LinkFixture, kind: "SQLite" | "D1"): AuthLinkBackend {
	const d1 = sqliteD1(f.db);
	return {
		first: async <T>({ sql, values }: AuthLinkStatement) => {
			if (kind === "D1")
				return d1
					.prepare(sql)
					.bind(...values)
					.first<T>();
			return (f.db.prepare(sql).get(...values) as T | undefined) ?? null;
		},
		run: async ({ sql, values }) => f.db.prepare(sql).run(...values).changes,
		batch: async (statements) =>
			f.db.transaction(() =>
				statements.map(({ sql, values }) => f.db.prepare(sql).run(...values).changes),
			)(),
	};
}

function snapshot(f: LinkFixture) {
	const tables = f.db
		.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
		.all() as { name: string }[];
	return tables.map(({ name }) => [name, f.db.prepare(`SELECT * FROM "${name}"`).all()]);
}

function history(f: LinkFixture, groupId: string, identityId: string) {
	const manifest = normalize({
		version: 1,
		coordinator_id: f.cfg.coordinatorId,
		candidate_ref: legacyTeamCandidateId(f.cfg.coordinatorId, groupId),
		candidate_digest: "a".repeat(64),
		team_id: `team-${groupId}`,
		team_digest: "b".repeat(64),
		source_digest: "c".repeat(64),
		finish_digest: "d".repeat(64),
		access_delta_digest: "e".repeat(64),
		team: {
			display_name: "Synthetic history",
			policy_revision: "f".repeat(64),
			device_eligibility_mode: "reviewed_allowlist",
		},
		memberships: [{ identity_id: identityId, role: "member" }],
		device_decisions: [
			{
				device_id: signer.deviceId,
				key_fingerprint: signer.fingerprint,
				enabled: true,
				identity_id: identityId,
				decision: "included",
			},
		],
		project_mappings: [],
		project_recipients: [],
		completed_at: "2026-10-01T00:00:00.000Z",
	});
	f.db
		.prepare(`INSERT INTO coordinator_legacy_team_completions
		(group_id,candidate_ref,manifest_version,manifest_json,completed_at,created_at)
		VALUES (?,?,1,?,?,?)`)
		.run(
			groupId,
			manifest.candidate_ref,
			canonical(manifest),
			manifest.completed_at,
			manifest.completed_at,
		);
}

async function seed(f: LinkFixture, backend: AuthLinkBackend, origin = "device_claim") {
	f.db.exec(seedEnrollmentSql);
	if (origin === "device_claim") {
		f.db.exec(seedClaimSql);
		f.db.exec(`INSERT INTO coordinator_auth_account_links
			(coordinator_id,link_id,issuer,subject,identity_id,attempt_id,auth_config_revision,
			created_at_ms,authority_kind,device_claim_id)
			SELECT coordinator_id,claim_id,issuer,'private-claim-subject',identity_id,attempt_id,
			auth_config_revision,created_at_ms,'device_claim',claim_id FROM coordinator_auth_device_claims;
			INSERT INTO coordinator_auth_link_audit_log
			(coordinator_id,link_id,attempt_id,identity_id,group_id,device_id,fingerprint,
			auth_config_revision,created_at_ms,action,authority_kind,device_claim_id)
			SELECT coordinator_id,link_id,attempt_id,identity_id,group_id,device_id,fingerprint,
			auth_config_revision,finalized_at_ms,'link_created','device_claim',link_id
			FROM coordinator_auth_link_attempts;`);
	} else {
		f.db.exec(controllerLinkEvidenceSql());
		expect(
			await f.store.createAuthControllerAttestation(
				review({
					publicKey: CANONICAL_PUBLIC_KEY,
					attestationId: "historical-controller",
					reviewReceiptId: "historical-receipt",
				}),
			),
		).toMatchObject({ kind: "created" });
	}
	await applyAccountConnectionSchema(backend);
	await f.store.enrollDevice(signer.groupId, signer);
	history(f, "history-a", "identity-a");
	history(f, "history-b", "identity-b");
	expect(await readConnectionSchemaState(backend)).toBe("ready");
}

async function seedReview(f: LinkFixture, identityId = input.targetIdentityId) {
	expect(
		await f.store.createAuthControllerAttestation(
			review({
				...signer,
				identityId,
				attestationId: "laptop-review",
				reviewReceiptId: "old-receipt",
				evidenceDigest: "d".repeat(64),
			}),
		),
	).toMatchObject({ kind: "created" });
}

function archive(f: LinkFixture) {
	const columns = CONNECTION_BIRTH_COLUMNS.join(",");
	f.db.exec(`INSERT INTO coordinator_auth_account_connection_unlinks
		(coordinator_id,attempt_id,target_link_id,identity_id,issuer,target_subject,group_id,
		device_id,public_key,fingerprint,enrollment_identity_id,auth_config_revision,
		request_hash,state,created_at_ms)
		SELECT coordinator_id,'end-attempt',link_id,identity_id,issuer,subject,'group-a',
		'device-a','${CANONICAL_PUBLIC_KEY}','${"a".repeat(64)}',NULL,auth_config_revision,
		'${"e".repeat(64)}','committing',${NOW + 1} FROM coordinator_auth_account_links;
		INSERT INTO coordinator_auth_account_connection_history
		(${columns},original_rowid,ended_at_ms,end_attempt_id,signin_floor)
		SELECT ${columns},rowid,${NOW + 1},'end-attempt',signin_floor
		FROM coordinator_auth_account_links;
		DELETE FROM coordinator_auth_account_links;
		UPDATE coordinator_auth_account_connection_unlinks
		SET state='completed',completed_at_ms=${NOW + 1};`);
}

function successor(f: LinkFixture) {
	const tables = [
		"coordinator_auth_account_links",
		"coordinator_auth_link_attempts",
		"coordinator_auth_link_audit_log",
	];
	const rows = tables.map(
		(table) => f.db.prepare(`SELECT * FROM ${table}`).get() as Record<string, unknown>,
	);
	archive(f);
	for (const [index, table] of tables.entries()) {
		const original = rows[index];
		if (!original) throw new Error("missing genesis fixture");
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
			.prepare(`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")})
			VALUES (${entries.map(() => "?").join(",")})`)
			.run(...entries.map(([, value]) => value));
	}
	f.db.exec(
		"UPDATE coordinator_auth_account_connection_history SET successor_link_id='successor-link'",
	);
}

async function revoke(
	f: LinkFixture,
	subject: "origin-device" | "origin-key" | "target-device" | "target-key",
) {
	const origin = subject.startsWith("origin");
	const key = subject.endsWith("key");
	const publicKey = origin ? CANONICAL_PUBLIC_KEY : signer.publicKey;
	const deviceId = origin ? "device-a" : signer.deviceId;
	const value = key ? await ed25519KeyIdForRevocation(publicKey) : deviceId;
	if (origin && key) expect(value).toBe(EXPECTED_KEY_ID);
	f.db
		.prepare(`INSERT INTO coordinator_device_revocations
		(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,
		evidence_public_key,evidence_fingerprint,created_at) VALUES (?,?,?,?,?,?,?,?)`)
		.run(
			key ? "ed25519_key" : "device_id",
			value,
			`revoked-${subject}`,
			signer.groupId,
			deviceId,
			publicKey,
			origin ? "a".repeat(64) : signer.fingerprint,
			"created",
		);
}

beforeEach(() => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
});

for (const kind of ["SQLite", "D1"] as const) {
	const test = backendTest(kind);
	test(`${kind} accepts matching nonnull enrollment and fresh verifier revision without changing birth`, async ({
		fixture: f,
	}) => {
		// Arrange: the link retains its original revision after verifier rotation.
		const backend = backendFor(f, kind);
		await seed(f, backend);
		f.db
			.prepare("UPDATE enrolled_devices SET identity_id=? WHERE device_id=?")
			.run(input.targetIdentityId, signer.deviceId);
		const before = snapshot(f);
		// Act
		const result = await new AccountOwnerTargetOperations(backend, f.store).readAccountOwnerTarget(
			input,
			{ ...f.cfg, revision: "f".repeat(64) },
		);
		// Assert
		expect(result).toMatchObject({
			kind: "ready",
			currentGeneration: { authConfigRevision: f.cfg.revision },
			review: null,
		});
		expect(snapshot(f)).toEqual(before);
	});
	test(`${kind} uses retained claim genesis but denies revocation of a historical account generation`, async ({
		fixture: f,
	}) => {
		// Arrange: a valid continuation retains its claim's genesis in connection history.
		const backend = backendFor(f, kind);
		await seed(f, backend);
		successor(f);
		const before = snapshot(f);
		const operations = new AccountOwnerTargetOperations(backend, f.store);
		// Act
		const live = await operations.readAccountOwnerTarget(input, f.cfg);
		const afterLive = snapshot(f);
		f.db.exec(`UPDATE coordinator_auth_account_connection_history SET revoked_at_ms=${NOW + 2}`);
		const revoked = snapshot(f);
		const denied = await operations.readAccountOwnerTarget(input, f.cfg);
		// Assert
		expect(live).toMatchObject({ kind: "ready", linkId: "successor-link", review: null });
		expect(afterLive).toEqual(before);
		expect(denied).toEqual(unavailable);
		expect(snapshot(f)).toEqual(revoked);
	});
	for (const origin of ["device_claim", "controller_attestation"]) {
		test(`${kind} ${origin} birth exposes only advisory target fields without assigning ownership`, async ({
			fixture: f,
		}) => {
			// Arrange: different origin key A, requester key C, null enrollment and independent A/B history.
			const backend = backendFor(f, kind);
			await seed(f, backend, origin);
			const reader = vi.spyOn(f.store, "getActiveAuthControllerAttestation");
			const before = snapshot(f);
			// Act
			const result = await new AccountOwnerTargetOperations(
				backend,
				f.store,
			).readAccountOwnerTarget(input, f.cfg);
			// Assert: exact equality excludes subject, profile and provider identity fields.
			expect(result).toEqual({
				kind: "ready",
				targetIdentityId: "identity-a",
				linkId: origin === "device_claim" ? "claim-a" : "link-a",
				currentGeneration: { authConfigRevision: f.cfg.revision, createdAtMs: NOW },
				review: null,
			});
			expect(reader).not.toHaveBeenCalled();
			expect(snapshot(f)).toEqual(before);
		});
	}
	test(`${kind} restores the exact old receipt and digest after history changes without renewing review`, async ({
		fixture: f,
	}) => {
		// Arrange: review is explicit, never inferred from null enrollment or historical assignment.
		const backend = backendFor(f, kind);
		await seed(f, backend);
		await seedReview(f);
		const operations = new AccountOwnerTargetOperations(backend, f.store);
		const before = snapshot(f);
		// Act
		const original = await operations.readAccountOwnerTarget(input, f.cfg);
		const afterFirstRead = snapshot(f);
		history(f, "history-new", "identity-new");
		const changed = snapshot(f);
		const restored = await operations.readAccountOwnerTarget(input, f.cfg);
		// Assert
		expect(original).toEqual({
			kind: "ready",
			targetIdentityId: "identity-a",
			linkId: "claim-a",
			currentGeneration: { authConfigRevision: f.cfg.revision, createdAtMs: NOW },
			review: {
				attestationId: "laptop-review",
				reviewReceiptId: "old-receipt",
				evidenceDigest: "d".repeat(64),
			},
		});
		expect(restored).toEqual(original);
		expect(afterFirstRead).toEqual(before);
		expect(snapshot(f)).toEqual(changed);
	});
	test(`${kind} rejects a review revoked after the active read before its promise resolves`, async ({
		fixture: f,
	}) => {
		// Arrange: retain the real active row while its immutable tombstone changes during await.
		const backend = backendFor(f, kind);
		await seed(f, backend);
		await seedReview(f);
		const before = snapshot(f);
		const readRow = () =>
			f.db
				.prepare("SELECT * FROM coordinator_auth_controller_attestations WHERE attestation_id=?")
				.get("laptop-review") as Record<string, unknown>;
		const priorRow = readRow();
		const original = f.store.getActiveAuthControllerAttestation.bind(f.store);
		let changed: ReturnType<typeof snapshot> | undefined;
		const reader = vi
			.spyOn(f.store, "getActiveAuthControllerAttestation")
			.mockImplementation(async (coordinatorId, attestationId) => {
				const active = await original(coordinatorId, attestationId);
				expect(active).toMatchObject({ attestation_id: "laptop-review", revoked_at: null });
				expect(await f.store.revokeAuthControllerAttestation(coordinatorId, attestationId)).toBe(
					true,
				);
				changed = snapshot(f);
				return active;
			});
		// Act
		const result = await new AccountOwnerTargetOperations(backend, f.store).readAccountOwnerTarget(
			input,
			f.cfg,
		);
		// Assert: only revocation changed; the stale active row must not produce a ready preview.
		expect(reader).toHaveBeenCalledExactlyOnceWith(f.cfg.coordinatorId, "laptop-review");
		const revokedRow = readRow();
		expect(priorRow.revoked_at).toBeNull();
		expect(revokedRow.revoked_at).not.toBeNull();
		expect(revokedRow).toEqual({ ...priorRow, revoked_at: revokedRow.revoked_at });
		expect(
			snapshot(f).filter(([table]) => table !== "coordinator_auth_controller_attestations"),
		).toEqual(before.filter(([table]) => table !== "coordinator_auth_controller_attestations"));
		expect(changed).toBeDefined();
		expect(snapshot(f)).toEqual(changed);
		expect(result).toEqual(unavailable);
	});
	for (const subject of ["origin-device", "origin-key", "target-device", "target-key"] as const) {
		test(`${kind} ${subject} tombstone affects only current requester readiness`, async ({
			fixture: f,
		}) => {
			// Arrange: retained genesis is account proof, not current origin-device authorization.
			const backend = backendFor(f, kind);
			await seed(f, backend);
			await revoke(f, subject);
			const before = snapshot(f);
			// Act
			const result = await new AccountOwnerTargetOperations(
				backend,
				f.store,
			).readAccountOwnerTarget(input, f.cfg);
			// Assert
			expect(result).toMatchObject(
				subject.startsWith("origin") ? { kind: "ready", review: null } : unavailable,
			);
			expect(snapshot(f)).toEqual(before);
		});
	}
	const mutations: Record<string, (f: LinkFixture) => void | Promise<void>> = {
		"missing enrollment": (f) => {
			f.db.prepare("DELETE FROM enrolled_devices WHERE device_id=?").run(signer.deviceId);
		},
		"disabled enrollment": (f) => {
			f.db.prepare("UPDATE enrolled_devices SET enabled=0 WHERE device_id=?").run(signer.deviceId);
		},
		"archived group": (f) => {
			f.db.exec("UPDATE groups SET archived_at='archived' WHERE group_id='group-a'");
		},
		"different enrollment identity": (f) => {
			f.db
				.prepare("UPDATE enrolled_devices SET identity_id='identity-b' WHERE device_id=?")
				.run(signer.deviceId);
		},
		"malformed provenance": (f) => {
			f.db.exec("UPDATE coordinator_auth_link_attempts SET account_subject='mismatch'");
		},
		"missing provenance": (f) => {
			f.db.exec("DELETE FROM coordinator_auth_link_audit_log");
		},
		"disconnected account": archive,
		"revoked current account": (f) => {
			f.db.exec(`UPDATE coordinator_auth_account_links SET revoked_at_ms=${NOW + 1}`);
		},
		"unsupported schema": (f) => {
			f.db.exec("DROP TRIGGER account_change_birth");
		},
		"revoked controller": async (f) => {
			await seedReview(f);
			f.db.exec("UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked'");
		},
		"conflicting controller": async (f) => {
			await seedReview(f, "identity-b");
		},
	};
	for (const [name, mutate] of Object.entries(mutations)) {
		test(`${kind} denies ${name} without writes`, async ({ fixture: f }) => {
			// Arrange
			const backend = backendFor(f, kind);
			await seed(f, backend);
			await mutate(f);
			const before = snapshot(f);
			// Act
			const result = await new AccountOwnerTargetOperations(
				backend,
				f.store,
			).readAccountOwnerTarget(input, f.cfg);
			// Assert
			expect(result).toEqual(unavailable);
			expect(snapshot(f)).toEqual(before);
		});
	}
	for (const name of ["revoked controller", "disabled enrollment", "disconnected account"]) {
		test(`${kind} rejects ${name} changed during final schema read`, async ({ fixture: f }) => {
			const backend = backendFor(f, kind);
			await seed(f, backend);
			await seedReview(f);
			let schemaReads = 0;
			let changed: ReturnType<typeof snapshot> | undefined;
			const interleaved: AuthLinkBackend = {
				...backend,
				first: async <T>(statement: AuthLinkStatement) => {
					const result = await backend.first<T>(statement);
					if (statement.sql.startsWith("SELECT min(column1) AS ready") && ++schemaReads === 2) {
						if (name === "revoked controller") {
							expect(
								await f.store.revokeAuthControllerAttestation(f.cfg.coordinatorId, "laptop-review"),
							).toBe(true);
						} else {
							await mutations[name]?.(f);
						}
						changed = snapshot(f);
					}
					return result;
				},
			};
			const result = await new AccountOwnerTargetOperations(
				interleaved,
				f.store,
			).readAccountOwnerTarget(input, f.cfg);
			expect(schemaReads).toBe(2);
			expect(changed).toBeDefined();
			expect(snapshot(f)).toEqual(changed);
			expect(result).toEqual(unavailable);
		});
	}
	for (const message of ["no such table: connection_missing", "database unavailable"]) {
		test(`${kind} preserves final schema error handling for ${message}`, async ({ fixture: f }) => {
			const backend = backendFor(f, kind);
			await seed(f, backend);
			let schemaReads = 0;
			const failing: AuthLinkBackend = {
				...backend,
				first: async <T>(statement: AuthLinkStatement) => {
					if (statement.sql.startsWith("SELECT min(column1) AS ready") && ++schemaReads === 2)
						throw new Error(message);
					return backend.first<T>(statement);
				},
			};
			const before = snapshot(f);
			const result = new AccountOwnerTargetOperations(failing, f.store).readAccountOwnerTarget(
				input,
				f.cfg,
			);
			if (message.startsWith("no such table")) {
				await expect(result).resolves.toEqual(unavailable);
			} else {
				await expect(result).rejects.toThrow("account_owner_target_unavailable");
			}
			expect(schemaReads).toBe(2);
			expect(snapshot(f)).toEqual(before);
		});
	}
	for (const [name, changes] of Object.entries({
		group: { signer: { ...signer, groupId: "other-group" } },
		device: { signer: { ...signer, deviceId: "other-device" } },
		key: { signer: { ...signer, publicKey: CANONICAL_PUBLIC_KEY } },
		fingerprint: { signer: { ...signer, fingerprint: "f".repeat(64) } },
		identity: { targetIdentityId: "identity-b" },
		"invalid identity": { targetIdentityId: "" },
		"invalid key": { signer: { ...signer, publicKey: "not-ed25519" } },
	})) {
		test(`${kind} denies wrong ${name} input`, async ({ fixture: f }) => {
			// Arrange
			const backend = backendFor(f, kind);
			await seed(f, backend);
			const before = snapshot(f);
			const request: CoordinatorAccountOwnerTargetInput = { ...input, ...changes };
			// Act
			const result = await new AccountOwnerTargetOperations(
				backend,
				f.store,
			).readAccountOwnerTarget(request, f.cfg);
			// Assert
			expect(result).toEqual(unavailable);
			expect(snapshot(f)).toEqual(before);
		});
	}
	for (const changes of [
		{ enabled: false },
		{ coordinatorId: "other-coordinator" },
		{ issuer: "https://other.example.test" },
	]) {
		test(`${kind} denies mismatched or disabled config ${JSON.stringify(changes)}`, async ({
			fixture: f,
		}) => {
			// Arrange
			const backend = backendFor(f, kind);
			await seed(f, backend);
			const before = snapshot(f);
			// Act
			const result = await new AccountOwnerTargetOperations(
				backend,
				f.store,
			).readAccountOwnerTarget(input, { ...f.cfg, ...changes });
			// Assert
			expect(result).toEqual(unavailable);
			expect(snapshot(f)).toEqual(before);
		});
	}
	for (const changes of [
		null,
		{ identity_id: "other" },
		{ coordinator_id: "other" },
		{ attestation_id: "other" },
		{ group_id: "other" },
		{ device_id: "other" },
		{ public_key: CANONICAL_PUBLIC_KEY },
		{ fingerprint: "f".repeat(64) },
		{ revoked_at: "revoked" },
		{ revision: 2 },
		{ review_receipt_id: "" },
		{ evidence_digest: "bad" },
	]) {
		test(`${kind} rejects malformed trusted review response ${JSON.stringify(changes)}`, async ({
			fixture: f,
		}) => {
			// Arrange: real matching review exists, but the trusted reader must still return exact pins.
			const backend = backendFor(f, kind);
			await seed(f, backend);
			await seedReview(f);
			const active = await f.store.getActiveAuthControllerAttestation(
				f.cfg.coordinatorId,
				"laptop-review",
			);
			if (!active) throw new Error("missing fixture review");
			const reviews: Reviews = {
				getActiveAuthControllerAttestation: vi
					.fn()
					.mockResolvedValue(changes === null ? null : { ...active, ...changes }),
			};
			const before = snapshot(f);
			// Act
			const result = await new AccountOwnerTargetOperations(
				backend,
				reviews,
			).readAccountOwnerTarget(input, f.cfg);
			// Assert
			expect(result).toEqual(unavailable);
			expect(snapshot(f)).toEqual(before);
		});
	}
	for (const name of [
		"disabled enrollment",
		"different enrollment identity",
		"revoked current account",
		"disconnected account",
		"missing provenance",
		"unsupported schema",
	]) {
		test(`${kind} rechecks ${name} changed during awaited review`, async ({ fixture: f }) => {
			// Arrange: capture a valid review, then interleave an independent database mutation.
			const backend = backendFor(f, kind);
			await seed(f, backend);
			await seedReview(f);
			const active = await f.store.getActiveAuthControllerAttestation(
				f.cfg.coordinatorId,
				"laptop-review",
			);
			let changed: ReturnType<typeof snapshot> | undefined;
			const reviews: Reviews = {
				getActiveAuthControllerAttestation: async () => {
					await Promise.resolve();
					await mutations[name]?.(f);
					changed = snapshot(f);
					return active;
				},
			};
			// Act
			const result = await new AccountOwnerTargetOperations(
				backend,
				reviews,
			).readAccountOwnerTarget(input, f.cfg);
			// Assert: only the interleaved writer changed records.
			expect(result).toEqual(unavailable);
			expect(changed).toBeDefined();
			expect(snapshot(f)).toEqual(changed);
		});
	}
}
