import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { CoordinatorAuthControllerReviewInput } from "../../core/src/coordinator-auth-controller.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "../../core/src/coordinator-ed25519-key-id-test-fixtures.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS } from "../../core/src/coordinator-legacy-owner-resolution-schema.js";
import { D1CoordinatorStore } from "../../core/src/d1-coordinator-store.js";
import { resetCeremony, snapshot } from "./owner-ceremony-test-fixtures.js";

const db = env.COORDINATOR_DB;
const timestamp = "2026-10-23T00:00:00.000Z";
const controllerTable = "coordinator_auth_controller_attestations";
const resolutionTable = "coordinator_legacy_owner_resolutions";
const coordinatorId = "native-controller-consistency";
const signer = {
	groupId: "native-consistency-group",
	deviceId: "native-consistency-device",
	publicKey: CANONICAL_PUBLIC_KEY,
	fingerprint: "a".repeat(64),
};
type Row = Record<string, string | number | null>;

async function insert(table: string, row: Row) {
	const entries = Object.entries(row);
	await db
		.prepare(`INSERT INTO ${table} (${entries.map(([key]) => key).join(",")})
		VALUES (${entries.map(() => "?").join(",")})`)
		.bind(...entries.map(([, value]) => value))
		.run();
}
async function installResolutionSchema() {
	await db.batch(LEGACY_OWNER_RESOLUTION_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}
async function retainedResolution(options: { persistResolution?: boolean } = {}) {
	const source = {
		attestation_id: "native-original-controller",
		coordinator_id: coordinatorId,
		identity_id: "A",
		group_id: "removed-native-source-group",
		device_id: signer.deviceId,
		public_key: `${signer.publicKey} original-source-alias`,
		fingerprint: signer.fingerprint,
		review_receipt_id: "native-original-receipt",
		evidence_digest: "b".repeat(64),
		enrollment_identity_id: null,
		revision: 1,
		created_at: timestamp,
		revoked_at: null,
	};
	await insert(controllerTable, source);
	const resolution = {
		coordinator_id: coordinatorId,
		resolution_id: "native-retained-resolution",
		resolution_version: 1,
		device_id: signer.deviceId,
		key_id: EXPECTED_KEY_ID,
		owner_identity_id: "A",
		purpose: "existing_account_owner",
		scope: "historical_included_owner_labels_only",
		source_attestation_id: source.attestation_id,
		source_group_id: source.group_id,
		source_controller_revision: source.revision,
		source_public_key: source.public_key,
		source_fingerprint: source.fingerprint,
		source_enrollment_identity_id: null,
		source_created_at: source.created_at,
		source_review_receipt_id: source.review_receipt_id,
		source_evidence_digest: source.evidence_digest,
		resolution_evidence_digest: "c".repeat(64),
		reviewed_weak_labels_json: "[]",
		created_at: timestamp,
	};
	if (options.persistResolution !== false) await insert(resolutionTable, resolution);
	return { source, resolution };
}
async function ordinaryReview(
	store: D1CoordinatorStore,
	patch: Partial<CoordinatorAuthControllerReviewInput> = {},
) {
	const input: CoordinatorAuthControllerReviewInput = {
		...signer,
		coordinatorId,
		identityId: "A",
		attestationId: "native-new-controller",
		reviewReceiptId: "native-new-receipt",
		evidenceDigest: "d".repeat(64),
		...patch,
	};
	input.verifiedSnapshot = {
		enrollmentIdentityId: null,
		invites: [],
		legacyHistory: await store.captureAuthControllerLegacyHistory(input),
	};
	return input;
}

/** Native statements execute unchanged; only the last run boundary is intercepted. */
function winningWrite(change: () => Promise<void>) {
	let injected = false;
	let afterChange: Awaited<ReturnType<typeof snapshot>> | undefined;
	let bindCount = 0;
	const wrap = (statement: D1PreparedStatement, query: string): D1PreparedStatement =>
		new Proxy(statement, {
			get(statement, property) {
				if (property === "bind")
					return (...values: unknown[]) => {
						if (query.includes(`INSERT INTO ${controllerTable}`)) bindCount = values.length;
						return wrap(statement.bind(...values), query);
					};
				if (property === "run")
					return async () => {
						if (
							!injected &&
							/\bINSERT\s+INTO\s+coordinator_auth_controller_attestations\b/iu.test(query)
						) {
							injected = true;
							await change();
							afterChange = await snapshot();
						}
						return statement.run();
					};
				const value = Reflect.get(statement, property);
				return typeof value === "function" ? value.bind(statement) : value;
			},
		});
	const database = new Proxy(db, {
		get(database, property) {
			if (property === "prepare") return (query: string) => wrap(database.prepare(query), query);
			const value = Reflect.get(database, property);
			return typeof value === "function" ? value.bind(database) : value;
		},
	});
	return {
		store: new D1CoordinatorStore(database),
		injected: () => injected,
		afterChange: () => afterChange,
		bindCount: () => bindCount,
	};
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	// Disposable native test storage only; never change guards during an operation.
	await resetCeremony();
	await db.prepare(`DROP TABLE IF EXISTS ${resolutionTable}`).run();
	await installResolutionSchema();
	await db.prepare("DELETE FROM coordinator_legacy_team_completions").run();
	await db.prepare("DELETE FROM coordinator_invites").run();
	const store = new D1CoordinatorStore(db);
	await store.createGroup(signer.groupId);
	await store.enrollDevice(signer.groupId, signer);
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it("native legacy creation succeeds without the optional resolution table", async () => {
	// Arrange: use the default native pool limits, not a SQLite shim or raised limits.
	await db.prepare(`DROP TABLE ${resolutionTable}`).run();
	const store = new D1CoordinatorStore(db);
	const input = await ordinaryReview(store);
	// Act
	const result = await store.createAuthControllerAttestation(input);
	// Assert
	expect(result).toMatchObject({ kind: "created" });
	expect(
		await db.prepare("SELECT name FROM sqlite_master WHERE name=?").bind(resolutionTable).all(),
	).toMatchObject({ results: [] });
});

it("native retained-source creation and exact retry compile under default D1 limits", async () => {
	// Arrange: source enrollment/group are absent; the original unrevoked row remains.
	const retained = await retainedResolution();
	const race = winningWrite(async () => {});
	const input = await ordinaryReview(race.store);
	const before = await snapshot();
	// Act
	const created = await race.store.createAuthControllerAttestation(input);
	const afterCreated = await snapshot();
	const retry = await race.store.createAuthControllerAttestation(input);
	// Assert: depth/compound limits remain the native defaults; binds stay below 100.
	expect(race.injected()).toBe(true);
	expect(race.bindCount()).toBeGreaterThan(0);
	expect(race.bindCount()).toBeLessThanOrEqual(100);
	expect(created.kind).toBe("created");
	expect(retry).toEqual({
		kind: "existing",
		attestation: created.kind === "created" ? created.attestation : null,
	});
	expect(await snapshot()).toEqual(afterCreated);
	expect(afterCreated.filter(([name]) => name !== controllerTable)).toEqual(
		before.filter(([name]) => name !== controllerTable),
	);
	expect(
		await db
			.prepare(`SELECT * FROM ${controllerTable} WHERE attestation_id=?`)
			.bind(retained.source.attestation_id)
			.first(),
	).toEqual(retained.source);
	expect((await db.prepare(`SELECT * FROM ${resolutionTable}`).all()).results).toEqual([
		retained.resolution,
	]);
});

it.each(["device", "key"])(
	"native retained owner A blocks owner B by %s collision",
	async (collision) => {
		// Arrange: no disagreeing completion or enrollment label masks the producer check.
		await retainedResolution();
		const store = new D1CoordinatorStore(db);
		const subject = { ...signer };
		if (collision === "key") subject.deviceId = "native-other-device";
		else
			subject.publicKey =
				"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAID1AF8PoQ4lakrcKp00bfrycmCzPLsSWjMDNVfEq9GYM";
		await store.enrollDevice(subject.groupId, subject);
		const input = await ordinaryReview(store, { ...subject, identityId: "B" });
		const before = await snapshot();
		// Act
		const result = await store.createAuthControllerAttestation(input);
		// Assert
		expect(result).toMatchObject({ kind: "rejected" });
		expect(await snapshot()).toEqual(before);
	},
);

it.each(["schema appears", "new binding", "source removed"])(
	"native winning INSERT pins %s",
	async (change) => {
		// Arrange: capture first, then mutate immediately before native statement execution.
		if (change === "schema appears") await db.prepare(`DROP TABLE ${resolutionTable}`).run();
		else await retainedResolution();
		const race = winningWrite(async () => {
			if (change === "schema appears") await installResolutionSchema();
			if (change === "new binding")
				await insert("coordinator_device_ownership_bindings", {
					device_id: signer.deviceId,
					key_id: EXPECTED_KEY_ID,
					identity_id: "B",
					coordinator_id: coordinatorId,
					binding_id: "native-collision-binding",
					provenance: "owner_enrollment",
					source_ref: "synthetic-birth",
					bound_at: timestamp,
				});
			if (change === "source removed")
				await db
					.prepare(
						`DELETE FROM ${controllerTable} WHERE attestation_id='native-original-controller'`,
					)
					.run();
		});
		const input = await ordinaryReview(race.store);
		// Act
		const result = await race.store.createAuthControllerAttestation(input);
		// Assert: reject without deleting or adding any rows beyond the injected change.
		expect(race.injected()).toBe(true);
		expect(result).toMatchObject({ kind: "rejected" });
		expect(await snapshot()).toEqual(race.afterChange());
	},
);

it("native ready-schema absence pin rejects a retained fact added only at the winning write", async () => {
	// Arrange: retain the source before history capture; only resolution metadata arrives late.
	const retained = await retainedResolution({ persistResolution: false });
	const race = winningWrite(async () => insert(resolutionTable, retained.resolution));
	const input = await ordinaryReview(race.store);
	// Act
	const result = await race.store.createAuthControllerAttestation(input);
	// Assert: a no-fact fast path must still compare absence atomically.
	expect(race.injected()).toBe(true);
	expect(result).toMatchObject({ kind: "rejected" });
	expect(await snapshot()).toEqual(race.afterChange());
});

it("native overlapping identical controller creates return created and existing with one new row", async () => {
	// Arrange: pause the loser at its actual INSERT, after its initial conflict miss and pin capture.
	await retainedResolution();
	const winnerStore = new D1CoordinatorStore(db);
	const input = await ordinaryReview(winnerStore);
	let winner: Awaited<ReturnType<typeof winnerStore.createAuthControllerAttestation>> | undefined;
	const race = winningWrite(async () => {
		winner = await winnerStore.createAuthControllerAttestation(input);
	});
	// Act: the nested invocation completes while the original invocation is still pending.
	const loser = await race.store.createAuthControllerAttestation(input);
	// Assert: the winner changes the full evidence pin, but an exact retry remains eligible.
	expect(race.injected()).toBe(true);
	expect(race.bindCount()).toBeGreaterThan(0);
	expect(race.bindCount()).toBeLessThanOrEqual(100);
	expect(winner?.kind).toBe("created");
	expect(loser).toEqual({
		kind: "existing",
		attestation: winner?.kind === "created" ? winner.attestation : null,
	});
	expect(await snapshot()).toEqual(race.afterChange());
	expect(
		await db
			.prepare(`SELECT COUNT(*) AS count FROM ${controllerTable} WHERE attestation_id=?`)
			.bind(input.attestationId)
			.first(),
	).toEqual({ count: 1 });
});

it.each(["receipt", "digest", "snapshot"] as const)(
	"native overlapping wrong %s review cannot replay the winner",
	async (change) => {
		// Arrange: retain the same owner, but make the losing request differ from the winner.
		await retainedResolution();
		const store = new D1CoordinatorStore(db);
		const input = await ordinaryReview(store);
		const wrong = { ...input };
		if (change === "receipt") wrong.reviewReceiptId = "wrong-receipt";
		if (change === "digest") wrong.evidenceDigest = "e".repeat(64);
		if (change === "snapshot")
			wrong.verifiedSnapshot = {
				...input.verifiedSnapshot,
				enrollmentIdentityId: "wrong",
				invites: [],
			};
		const race = winningWrite(async () => {
			expect((await store.createAuthControllerAttestation(input)).kind).toBe("created");
		});
		const before = await snapshot();
		// Act
		const result = await race.store.createAuthControllerAttestation(wrong);
		// Assert: invalid snapshots can be rejected before reaching the INSERT boundary.
		expect(result.kind).toBe("rejected");
		expect(await snapshot()).toEqual(race.injected() ? race.afterChange() : before);
	},
);

it.each(["binding", "revocation"] as const)(
	"native overlapping exact retry denies late %s after the winner",
	async (change) => {
		// Arrange: both calls initially see the same eligible review and retained source.
		await retainedResolution();
		const store = new D1CoordinatorStore(db);
		const input = await ordinaryReview(store);
		const race = winningWrite(async () => {
			expect((await store.createAuthControllerAttestation(input)).kind).toBe("created");
			if (change === "revocation") {
				await db
					.prepare(`UPDATE ${controllerTable} SET revoked_at=? WHERE attestation_id=?`)
					.bind(timestamp, input.attestationId)
					.run();
				return;
			}
			await insert("coordinator_device_ownership_bindings", {
				device_id: signer.deviceId,
				key_id: EXPECTED_KEY_ID,
				identity_id: "B",
				coordinator_id: coordinatorId,
				binding_id: "native-concurrent-binding",
				provenance: "owner_enrollment",
				source_ref: "synthetic-birth",
				bound_at: timestamp,
			});
		});
		// Act
		const result = await race.store.createAuthControllerAttestation(input);
		// Assert: recapturing a winner must not permit new owner conflicts or revoked replay.
		expect(race.injected()).toBe(true);
		expect(result.kind).toBe("rejected");
		expect(await snapshot()).toEqual(race.afterChange());
	},
);
