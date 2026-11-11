// Each test changes a retained-ownership fact after a first account link's reads and just
// before its write batch. The negative owner guards that lead that batch must refuse it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	config as reconnectConfig,
	input as reconnectInput,
} from "../../cloudflare-coordinator-worker/test/account-change-fixture.js";
import { reconnectFixture } from "../../cloudflare-coordinator-worker/test/account-reconnect-fixture.js";
import {
	input,
	seedEnrollmentSql,
} from "../../cloudflare-coordinator-worker/test/device-claim-eligibility-fixture.js";
import type { AuthLinkBackend, AuthLinkStatement } from "./coordinator-auth-link.js";
import {
	advance,
	attempt,
	backendTest,
	finalize,
	type LinkFixture,
	NOW,
} from "./coordinator-auth-link-test-fixtures.js";
import { setupStore, sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { ed25519KeyIdForRevocation } from "./coordinator-ed25519-key-id-compat.js";
import { LEGACY_OWNER_RESOLUTION_SCHEMA_SQL } from "./coordinator-legacy-owner-resolution-schema.js";
import {
	NEGATIVE_OWNER_CHANGES,
	type RaceSubject,
} from "./coordinator-owner-negative-race-test-fixtures.js";
import {
	producerSnapshot,
	retainProducerOwner,
} from "./coordinator-producer-negative-owner-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
});
afterEach(() => {
	vi.restoreAllMocks();
});

const test = backendTest("D1");
const WINNING = /UPDATE coordinator_auth_link_attempts\s+SET state = 'finalized'/;
const proof = () => finalize({ signer: input.signer, fingerprint: input.signer.fingerprint });

async function confirmed(f: LinkFixture) {
	f.db.exec(seedEnrollmentSql);
	await advance(
		f,
		"confirmed",
		attempt({
			authority: { kind: "device_claim", identityId: input.identityId },
			signer: input.signer,
		}),
	);
}

/** A store over the same database whose next winning write batch runs `change` first. */
function racingStore(f: LinkFixture, change: () => void) {
	let ran = false;
	const db = sqliteD1(f.db, {
		beforeBatch: (statements) => {
			if (ran || !statements.some(({ query }) => WINNING.test(query))) return;
			ran = true;
			change();
		},
	});
	return { store: new D1CoordinatorStore(db, { authClock: () => NOW }), ran: () => ran };
}

interface ResolutionSubject {
	coordinatorId: string;
	signer: { deviceId: string; publicKey: string; fingerprint: string };
	keyId: string;
}

function storeResolution(db: LinkFixture["db"], s: ResolutionSubject, ownerIdentityId: string) {
	db.prepare(
		`INSERT INTO coordinator_legacy_owner_resolutions (coordinator_id,resolution_id,resolution_version,device_id,key_id,owner_identity_id,purpose,scope,source_attestation_id,source_group_id,source_controller_revision,source_public_key,source_fingerprint,source_enrollment_identity_id,source_created_at,source_review_receipt_id,source_evidence_digest,resolution_evidence_digest,reviewed_weak_labels_json,created_at)
 VALUES (?,'raced-resolution',1,?,?,?,'existing_account_owner','historical_included_owner_labels_only','raced-source','raced-group',1,?,?,NULL,'2026-09-01T00:00:00.000Z','raced-review',?,?,'[]','2026-09-02T00:00:00.000Z')`,
	).run(
		s.coordinatorId,
		s.signer.deviceId,
		s.keyId,
		ownerIdentityId,
		s.signer.publicKey,
		s.signer.fingerprint,
		"b".repeat(64),
		"d".repeat(64),
	);
}

describe("first account link without retained ownership", () => {
	test("links the device while nothing changes", async ({ fixture: f }) => {
		// Arrange
		f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
		await confirmed(f);
		const raced = racingStore(f, () => undefined);
		// Act
		const result = await raced.store.finalizeAuthLinkAttempt(proof(), f.cfg);
		// Assert
		expect(raced.ran()).toBe(true);
		expect(result).toMatchObject({ kind: "applied" });
	});

	const races: [string, "missing" | "ready", (f: LinkFixture, keyId: string) => unknown][] = [
		[
			"the missing resolution table appears",
			"missing",
			(f) => f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL),
		],
		[
			"the resolution table gains an index",
			"ready",
			(f) =>
				f.db.exec(
					"CREATE INDEX raced_resolution_index ON coordinator_legacy_owner_resolutions(created_at)",
				),
		],
		[
			"a resolution by another owner is stored",
			"ready",
			(f, keyId) =>
				storeResolution(f.db, { coordinatorId: f.cfg.coordinatorId, ...input, keyId }, "owner-A"),
		],
		[
			"a resolution by the same owner is stored",
			"ready",
			(f, keyId) =>
				storeResolution(
					f.db,
					{ coordinatorId: f.cfg.coordinatorId, ...input, keyId },
					input.identityId,
				),
		],
	];
	test.for(races)("writes nothing when %s", async ([_name, catalog, change], { fixture: f }) => {
		// Arrange: the change's key ID is computed before the synchronous hook runs it.
		if (catalog === "missing")
			f.db.exec("DROP TABLE IF EXISTS coordinator_legacy_owner_resolutions");
		else f.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
		await confirmed(f);
		const keyId = String(await ed25519KeyIdForRevocation(input.signer.publicKey));
		let atWrite: ReturnType<typeof producerSnapshot> | undefined;
		const raced = racingStore(f, () => {
			change(f, keyId);
			atWrite = producerSnapshot(f.db);
		});
		// Act
		const result = await raced.store.finalizeAuthLinkAttempt(proof(), f.cfg);
		// Assert
		expect(raced.ran()).toBe(true);
		expect(result).toMatchObject({ kind: "rejected" });
		expect(producerSnapshot(f.db)).toEqual(atWrite);
	});
});

/** A reconnect: its finalize carries no binding statements, only the producer's guards. */
async function reconnectRace(options: { retained: boolean }) {
	const base = setupStore("D1", { authClock: () => NOW });
	const db = sqliteD1(base.db);
	const batch = db.batch?.bind(db);
	if (!batch) throw new Error("missing batch");
	const hook: { beforeBatch?: () => void } = {};
	const backend: AuthLinkBackend = {
		first: ({ sql, values }) =>
			db
				.prepare(sql)
				.bind(...values)
				.first(),
		all: async <T>({ sql, values }: AuthLinkStatement) =>
			base.db.prepare(sql).all(...values) as T[],
		run: async ({ sql, values }) => base.db.prepare(sql).run(...values).changes,
		batch: async (statements) => {
			const before = hook.beforeBatch;
			hook.beforeBatch = undefined;
			before?.();
			return (
				await batch(statements.map(({ sql, values }) => db.prepare(sql).bind(...values)))
			).map((result) => Number((result as { meta: { changes: number } }).meta.changes));
		},
	};
	const f = await reconnectFixture(base.store as D1CoordinatorStore, backend);
	base.db.exec(LEGACY_OWNER_RESOLUTION_SCHEMA_SQL);
	await f.disconnect(1);
	const relink = await f.confirmed(1);
	if (options.retained)
		await retainProducerOwner(base.db, {
			coordinatorId: reconnectConfig.coordinatorId,
			...reconnectInput.signer,
			ownerIdentityId: reconnectInput.identityId,
		});
	return { base, f, hook, relink };
}

describe("account reconnect", () => {
	const history = NEGATIVE_OWNER_CHANGES.find((race) => race.reads === "history");
	const resolution = NEGATIVE_OWNER_CHANGES.find((race) => race.reads.startsWith("retained"));
	const subject = (): RaceSubject => ({
		coordinatorId: reconnectConfig.coordinatorId,
		...reconnectInput.signer,
		ownerIdentityId: reconnectInput.identityId,
	});
	const retainedChanges: [string, (db: LinkFixture["db"]) => void][] = [
		["nothing changes", () => undefined],
		[
			"an unparseable legacy completion naming the device is stored",
			(db) => history?.change(db, subject()),
		],
		["a second retained resolution is stored", (db) => resolution?.change(db, subject())],
	];
	it.each(retainedChanges)(
		"with retained ownership answers the finalize when %s before the write",
		async (name, change) => {
			// Arrange: the retained resolution's original source is the device's own owner.
			const { base, f, hook, relink } = await reconnectRace({ retained: true });
			try {
				const links = () => base.db.prepare("SELECT * FROM coordinator_auth_account_links").all();
				let atWrite: unknown[] | undefined;
				hook.beforeBatch = () => {
					change(base.db);
					atWrite = links();
				};
				// Act
				const result = await f.links.finalizeAuthLinkAttempt(relink.proof, reconnectConfig);
				// Assert
				if (name === "nothing changes") {
					expect(result).toMatchObject({ kind: "applied" });
					return;
				}
				expect(result).toMatchObject({ kind: "rejected" });
				expect(links()).toEqual(atWrite);
			} finally {
				await base.store.close();
				if (base.db.open) base.db.close();
			}
		},
	);

	const changes: [string, (db: LinkFixture["db"], keyId: string) => void][] = [
		["nothing changes", () => undefined],
		[
			"the resolution table gains an index",
			(db) =>
				db.exec(
					"CREATE INDEX raced_resolution_index ON coordinator_legacy_owner_resolutions(created_at)",
				),
		],
		[
			"a resolution by another owner is stored",
			(db, keyId) =>
				storeResolution(
					db,
					{ coordinatorId: reconnectConfig.coordinatorId, ...reconnectInput, keyId },
					"owner-A",
				),
		],
	];
	it.each(changes)(
		"without retained ownership answers the finalize when %s before the write",
		async (name, change) => {
			// Arrange
			const { base, f, hook, relink } = await reconnectRace({ retained: false });
			try {
				const keyId = String(await ed25519KeyIdForRevocation(reconnectInput.signer.publicKey));
				const links = () => base.db.prepare("SELECT * FROM coordinator_auth_account_links").all();
				let atWrite: unknown[] | undefined;
				hook.beforeBatch = () => {
					change(base.db, keyId);
					atWrite = links();
				};
				// Act
				const result = await f.links.finalizeAuthLinkAttempt(relink.proof, reconnectConfig);
				// Assert
				if (name === "nothing changes") {
					expect(result).toMatchObject({ kind: "applied" });
					return;
				}
				expect(result).toMatchObject({ kind: "rejected" });
				expect(links()).toEqual(atWrite);
			} finally {
				await base.store.close();
				if (base.db.open) base.db.close();
			}
		},
	);
});
