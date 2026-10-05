import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { BetterSqliteCoordinatorStore } from "./better-sqlite-coordinator-store.js";
import type { CoordinatorAuthBrowserTransactionStartInput as Start } from "./coordinator-auth-browser-transaction-contract.js";
import {
	browserConfig,
	materials,
	transactionRows,
} from "./coordinator-auth-browser-transaction-test-fixtures.js";
import {
	AUTH_LINK_SCHEMA_SQL,
	type CoordinatorAuthLinkCreateInput as Create,
} from "./coordinator-auth-link-contract.js";
import {
	attempt,
	authorize,
	backendTest,
	browserHash,
	device,
	type LinkFixture,
	NOW,
	rows,
	snapshot,
	status,
	TABLES,
	TTL,
} from "./coordinator-auth-link-test-fixtures.js";
import { sqliteD1 } from "./coordinator-auth-store-test-fixtures.js";
import { D1CoordinatorStore } from "./d1-coordinator-store.js";

// Hashes are trusted commitments, not raw browser codes or OIDC proofs.
const codeHash = "8".repeat(64);
const otherHash = "9".repeat(64);
const protectedAttempt = () => attempt({ browserStartHash: codeHash });
const start = (value = 1): Start => ({
	...materials(value),
	purpose: "link",
	attemptId: "attempt-a",
	browserStartHash: codeHash,
});
const malformed = [null, undefined, "", "8".repeat(63), "A".repeat(64), "z".repeat(64)];

async function contenders(f: LinkFixture, backend: "SQLite" | "D1") {
	if (backend === "D1")
		return {
			fixture: f,
			second: new D1CoordinatorStore(sqliteD1(f.db), { authClock: () => f.now }),
			close: async () => {},
		};
	const directory = mkdtempSync(join(tmpdir(), "codemem-start-race-"));
	const path = join(directory, "race.sqlite");
	await f.db.backup(path);
	const first = new BetterSqliteCoordinatorStore(path, { authClock: () => f.now });
	const second = new BetterSqliteCoordinatorStore(path, { authClock: () => f.now });
	return {
		fixture: { ...f, store: first, db: first.db },
		second,
		close: async () => {
			await first.close();
			await second.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

for (const backend of ["SQLite", "D1"] as const) {
	describe(`${backend} browser start commitment`, () => {
		const test = backendTest(backend);
		test("persists only a private immutable commitment and exact public status", async ({
			fixture: f,
		}) => {
			// Arrange
			await authorize(f);
			const grants = f.db.prepare("SELECT * FROM enrolled_devices").all();
			// Act
			const created = await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
			const before = snapshot(f);
			f.now += 100;
			const retry = await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
			const removed = await f.store.createAuthLinkAttempt(attempt(), f.cfg);
			const changed = await f.store.createAuthLinkAttempt(
				attempt({ browserStartHash: otherHash }),
				f.cfg,
			);
			const polled = await f.store.getAuthLinkAttemptStatus("attempt-a", device, f.cfg);
			// Assert
			expect(created).toEqual({
				kind: "created",
				status: status("pending"),
				identityId: "identity-a",
			});
			expect(retry).toEqual({ ...created, kind: "existing" });
			expect(removed).toEqual({ kind: "rejected", error: "attempt_conflict" });
			expect(changed).toEqual(removed);
			expect(polled).toEqual(status("pending"));
			expect(rows(f, TABLES[0])[0]).toMatchObject({
				browser_start_hash: codeHash,
				created_at_ms: NOW,
				expires_at_ms: NOW + TTL,
			});
			expect(snapshot(f)).toEqual(before);
			expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(grants);
		});
		test.for(malformed)(
			"rejects malformed create commitment %# without writes",
			async (browserStartHash, { fixture: f }) => {
				// Arrange
				await authorize(f);
				const input = { ...attempt(), browserStartHash } as unknown as Create;
				// Act
				const result = await f.store.createAuthLinkAttempt(input, f.cfg);
				// Assert
				expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
				expect(snapshot(f)).toEqual([[], [], []]);
			},
		);
		test.for(["create", "start"] as const)(
			"rejects optional commitment getters at %s without invoking them",
			async (stage, { fixture: f }) => {
				// Arrange
				await authorize(f);
				await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
				const before = snapshot(f);
				const getter = vi.fn(() => codeHash);
				const input = stage === "create" ? protectedAttempt() : start();
				Object.defineProperty(input, "browserStartHash", { get: getter });
				// Act
				const result =
					stage === "create"
						? await f.store.createAuthLinkAttempt(input as Create, f.cfg)
						: await f.store.startAuthBrowserTransaction(input as Start, browserConfig);
				// Assert
				expect(result).toEqual({ kind: "rejected", error: "invalid_input" });
				expect(getter).not.toHaveBeenCalled();
				expect(snapshot(f)).toEqual(before);
				expect(transactionRows(f)).toEqual([]);
			},
		);
	});
	describe(`${backend} protected browser proof`, () => {
		const test = backendTest(backend);
		test.for(["omitted", "wrong", "runtime", "completion", ...malformed] as const)(
			"rejects missing or invalid browser proof %# without orphan SDK material",
			async (proof, { fixture: f }) => {
				// Arrange
				await authorize(f);
				await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
				await f.store.createAuthLinkAttempt(
					attempt({ attemptId: "unrelated", runtimeVerifierHash: "e".repeat(64) }),
					f.cfg,
				);
				const before = snapshot(f);
				const { browserStartHash: _hash, ...without } = start() as Start & {
					browserStartHash: string;
				};
				const alternateProofs: Record<string, string> = {
					wrong: otherHash,
					runtime: attempt().runtimeVerifierHash,
					completion: "d".repeat(64),
				};
				let supplied = proof;
				if (typeof proof === "string" && alternateProofs[proof]) supplied = alternateProofs[proof];
				const input = proof === "omitted" ? without : { ...without, browserStartHash: supplied };
				// Act
				const result = await f.store.startAuthBrowserTransaction(input as Start, browserConfig);
				const blind = await f.store.claimAuthLinkAttempt(
					{ attemptId: "attempt-a", browserTransactionHash: browserHash },
					f.cfg,
				);
				// Assert
				expect(result).toEqual({
					kind: "rejected",
					error:
						proof === "omitted" ||
						(typeof proof === "string" && Object.hasOwn(alternateProofs, proof))
							? "attempt_unavailable"
							: "invalid_input",
				});
				expect(blind).toEqual({ kind: "rejected", error: "attempt_unavailable" });
				expect(snapshot(f)).toEqual(before);
				expect(transactionRows(f)).toEqual([]);
			},
		);
		test("correct proof atomically claims with its original binder and never grants authority", async ({
			fixture: f,
		}) => {
			// Arrange
			await authorize(f);
			await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
			const grants = f.db.prepare("SELECT * FROM enrolled_devices").all();
			f.now += 100;
			const input = start();
			// Act
			const result = await f.store.startAuthBrowserTransaction(input, browserConfig);
			const stored = transactionRows(f);
			const bound = await f.store.resolveAuthLinkBrowserTransaction(
				{ attemptId: "attempt-a", binderHash: input.binderHash },
				browserConfig,
			);
			const wrongBinder = await f.store.resolveAuthLinkBrowserTransaction(
				{ attemptId: "attempt-a", binderHash: otherHash },
				browserConfig,
			);
			const wrongAttempt = await f.store.resolveAuthLinkBrowserTransaction(
				{ attemptId: "other", binderHash: input.binderHash },
				browserConfig,
			);
			const replay = await f.store.startAuthBrowserTransaction(start(2), browserConfig);
			// Assert
			expect(result).toEqual({ kind: "started", expiresAtMs: NOW + TTL });
			expect(stored).toHaveLength(1);
			expect(stored[0]).toMatchObject({
				state: "pending",
				state_hash: input.stateHash,
				binder_hash: input.binderHash,
				nonce: input.nonce,
				pkce_verifier: input.pkceVerifier,
				expires_at_ms: NOW + TTL,
			});
			expect(stored[0].browser_transaction_hash).toMatch(/^[0-9a-f]{64}$/);
			expect(bound).toEqual({ browserTransactionHash: stored[0].browser_transaction_hash });
			expect(wrongBinder).toBeNull();
			expect(wrongAttempt).toBeNull();
			expect(replay.kind).toBe("rejected");
			expect(transactionRows(f)).toEqual(stored);
			expect(rows(f, TABLES[0])[0]).toMatchObject({
				state: "browser_claimed",
				browser_start_hash: codeHash,
				browser_transaction_hash: stored[0].browser_transaction_hash,
			});
			expect(rows(f, TABLES[1])).toEqual([]);
			expect(rows(f, TABLES[2])).toEqual([]);
			expect(f.db.prepare("SELECT * FROM coordinator_auth_sessions").all()).toEqual([]);
			expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(grants);
		});
	});
	describe(`${backend} legacy compatibility and scope`, () => {
		const test = backendTest(backend);
		test("legacy NULL rows allow trusted old claim/start but reject supplied code", async ({
			fixture: f,
		}) => {
			// Arrange
			await authorize(f);
			await f.store.createAuthLinkAttempt(attempt(), f.cfg);
			const before = snapshot(f);
			const { browserStartHash: _hash, ...legacyStart } = start() as Start & {
				browserStartHash: string;
			};
			// Act
			const denied = await f.store.startAuthBrowserTransaction(start(), browserConfig);
			const afterDenied = snapshot(f);
			const orphans = transactionRows(f);
			const accepted = await f.store.startAuthBrowserTransaction(legacyStart, browserConfig);
			await f.store.createAuthLinkAttempt(
				attempt({ attemptId: "legacy-claim", runtimeVerifierHash: otherHash }),
				f.cfg,
			);
			const claimed = await f.store.claimAuthLinkAttempt(
				{ attemptId: "legacy-claim", browserTransactionHash: browserHash },
				f.cfg,
			);
			// Assert
			expect(denied).toEqual({ kind: "rejected", error: "attempt_unavailable" });
			expect(afterDenied).toEqual(before);
			expect(orphans).toEqual([]);
			expect(accepted).toEqual({ kind: "started", expiresAtMs: NOW + TTL });
			expect(claimed).toEqual({
				kind: "applied",
				status: status("browser_claimed", "legacy-claim"),
			});
			expect(rows(f, TABLES[0]).every((row) => row.browser_start_hash === null)).toBe(true);
		});
		test("signin ignores extra code metadata and cannot claim a link attempt", async ({
			fixture: f,
		}) => {
			// Arrange
			await authorize(f);
			await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
			const before = snapshot(f);
			// Act
			const result = await f.store.startAuthBrowserTransaction(
				{ ...materials(), browserStartHash: codeHash } as Start,
				browserConfig,
			);
			const nominated = await f.store.startAuthBrowserTransaction(
				{ ...materials(2), attemptId: "attempt-a", browserStartHash: codeHash } as unknown as Start,
				browserConfig,
			);
			// Assert
			expect(result).toEqual({ kind: "started", expiresAtMs: NOW + TTL });
			expect(nominated).toEqual({ kind: "rejected", error: "invalid_input" });
			expect(snapshot(f)).toEqual(before);
			expect(transactionRows(f)).toHaveLength(1);
			expect(transactionRows(f)[0]).toMatchObject({ purpose: "signin", attempt_id: null });
		});
		test.for(["namespace", "attempt", "revision", "issuer", "disabled", "expiry"])(
			"rejects wrong %s without inserting a transaction",
			async (variant, { fixture: f }) => {
				// Arrange
				await authorize(f);
				await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
				const before = snapshot(f);
				const config = { ...browserConfig };
				const input = start();
				if (variant === "namespace") config.coordinatorId = "other";
				if (variant === "attempt" && input.purpose === "link") input.attemptId = "other";
				if (variant === "revision") config.revision = otherHash;
				if (variant === "issuer") config.issuer = "https://other.example.test";
				if (variant === "disabled") config.enabled = false;
				if (variant === "expiry") f.now += TTL;
				// Act
				const result = await f.store.startAuthBrowserTransaction(input, config);
				// Assert
				const errors: Record<string, string> = {
					expiry: "attempt_expired",
					revision: "auth_config_changed",
					issuer: "auth_config_changed",
					disabled: "auth_config_changed",
				};
				expect(result).toEqual({
					kind: "rejected",
					error: errors[variant] ?? "attempt_unavailable",
				});
				expect(snapshot(f)).toEqual(before);
				expect(transactionRows(f)).toEqual([]);
			},
		);
	});
	describe(`${backend} atomic starts and retained tickets`, () => {
		const test = backendTest(backend);
		test("competing starts across store instances preserve only the winner's SDK material", async ({
			fixture: f,
		}) => {
			// Arrange: both independent capabilities share this isolated connection.
			await authorize(f);
			await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
			const race = await contenders(f, backend);
			const shared = race.fixture;
			const inputs = [
				start(),
				{ ...start(2), nonce: "m".repeat(43), pkceVerifier: "q".repeat(43) },
			];
			// Act
			try {
				const results = await Promise.all([
					shared.store.startAuthBrowserTransaction(inputs[0], browserConfig),
					race.second.startAuthBrowserTransaction(inputs[1], browserConfig),
				]);
				const winner = inputs[results.findIndex((result) => result.kind === "started")];
				// Assert
				expect(results.filter((result) => result.kind === "started")).toEqual([
					{ kind: "started", expiresAtMs: NOW + TTL },
				]);
				expect(results.filter((result) => result.kind === "rejected")).toHaveLength(1);
				expect(transactionRows(shared)).toEqual([
					expect.objectContaining({
						binder_hash: winner.binderHash,
						state_hash: winner.stateHash,
						nonce: winner.nonce,
						pkce_verifier: winner.pkceVerifier,
					}),
				]);
				expect(rows(shared, TABLES[0])[0].browser_transaction_hash).toBe(
					transactionRows(shared)[0].browser_transaction_hash,
				);
			} finally {
				await race.close();
			}
		});
		test("start tickets remain unique through tombstones and SQL rejects malformed hashes", async ({
			fixture: f,
		}) => {
			// Arrange
			await authorize(f);
			await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
			const before = snapshot(f);
			// Act
			const duplicate = await f.store.createAuthLinkAttempt(
				attempt({ attemptId: "other", runtimeVerifierHash: otherHash, browserStartHash: codeHash }),
				f.cfg,
			);
			const afterDuplicate = snapshot(f);
			await f.store.failAuthLinkAttempt(
				{ attemptId: "attempt-a", requester: device, reason: "cancelled" },
				f.cfg,
			);
			const tombstone = snapshot(f);
			const reused = await f.store.createAuthLinkAttempt(
				attempt({ attemptId: "other", runtimeVerifierHash: otherHash, browserStartHash: codeHash }),
				f.cfg,
			);
			// Assert
			expect(duplicate).toEqual({ kind: "rejected", error: "attempt_conflict" });
			expect(afterDuplicate).toEqual(before);
			expect(reused).toEqual(duplicate);
			expect(snapshot(f)).toEqual(tombstone);
			expect(rows(f, TABLES[0])[0]).toMatchObject({
				state: "failed",
				browser_start_hash: codeHash,
			});
			expect(() =>
				f.db.prepare(`UPDATE ${TABLES[0]} SET browser_start_hash = ?`).run("A".repeat(64)),
			).toThrow();
			expect(snapshot(f)).toEqual(tombstone);
		});
	});
	backendTest(backend)(
		`${backend} rolls back protected SDK insertion when the claim is suppressed`,
		async ({ fixture: f }) => {
			// Arrange: simulate a failed claim inside the atomic SQL batch.
			await authorize(f);
			await f.store.createAuthLinkAttempt(protectedAttempt(), f.cfg);
			const before = snapshot(f);
			f.db.exec(
				"CREATE TRIGGER ignore_protected_claim BEFORE UPDATE ON coordinator_auth_link_attempts WHEN NEW.state = 'browser_claimed' BEGIN SELECT RAISE(IGNORE); END",
			);
			// Act
			const result = f.store.startAuthBrowserTransaction(start(), browserConfig);
			// Assert
			await expect(result).rejects.toThrow("auth_browser_transaction_persistence_incomplete");
			expect(snapshot(f)).toEqual(before);
			expect(transactionRows(f)).toEqual([]);
		},
	);
}

const migrationDirectory = join(
	import.meta.dirname,
	"../../cloudflare-coordinator-worker/migrations",
);
function oldDatabase(db: Database.Database) {
	db.exec(readFileSync(join(migrationDirectory, "0017_add_auth_account_links.sql"), "utf8"));
	db.prepare(
		`INSERT INTO ${TABLES[0]} (coordinator_id,attempt_id,identity_id,group_id,device_id,public_key,fingerprint,controller_attestation_id,controller_review_receipt_id,controller_revision,issuer,auth_config_revision,runtime_verifier_hash,loopback_redirect,state,created_at_ms,expires_at_ms) VALUES ('coordinator-a','legacy','identity-a','group-a','device-a','fixture-key',?,'attestation-a','receipt-a',1,'https://accounts.example.test',?,?, 'http://127.0.0.1:4567/codemem/auth/complete','pending',?,?)`,
	).run("a".repeat(64), "a".repeat(64), "b".repeat(64), NOW, NOW + TTL);
}
function assertUpgrade(db: Database.Database, before: Record<string, unknown>) {
	expect(db.prepare(`SELECT * FROM ${TABLES[0]}`).all()).toEqual([
		{ ...before, browser_start_hash: null },
	]);
	expect(
		db
			.prepare(
				`SELECT name, "notnull" FROM pragma_table_info('${TABLES[0]}') WHERE name = 'browser_start_hash'`,
			)
			.get(),
	).toEqual({ name: "browser_start_hash", notnull: 0 });
	const indexes = db.prepare(`PRAGMA index_list(${TABLES[0]})`).all() as {
		name: string;
		unique: number;
	}[];
	expect(
		indexes.some(
			(index) =>
				index.unique === 1 &&
				JSON.stringify(
					db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name),
				) === JSON.stringify([{ name: "coordinator_id" }, { name: "browser_start_hash" }]),
		),
	).toBe(true);
	expect(() => db.prepare(`UPDATE ${TABLES[0]} SET browser_start_hash = ?`).run("bad")).toThrow();
}

it("upgrades an old isolated SQLite file before index creation and reopens idempotently", async () => {
	// Arrange
	const directory = mkdtempSync(join(tmpdir(), "codemem-start-code-"));
	const path = join(directory, "old.sqlite");
	const old = new Database(path);
	oldDatabase(old);
	const before = old.prepare(`SELECT * FROM ${TABLES[0]}`).get() as Record<string, unknown>;
	old.close();
	let store: BetterSqliteCoordinatorStore | undefined;
	try {
		// Act
		store = new BetterSqliteCoordinatorStore(path);
		// Assert
		assertUpgrade(store.db, before);
		const schema = store.db.prepare(`PRAGMA table_info(${TABLES[0]})`).all();
		await store.close();
		store = new BetterSqliteCoordinatorStore(path);
		expect(store.db.prepare(`PRAGMA table_info(${TABLES[0]})`).all()).toEqual(schema);
		assertUpgrade(store.db, before);
	} finally {
		await store?.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("additive D1 migration preserves old NULL rows and fresh contract enforces the same hash constraint", () => {
	// Arrange
	const db = new Database(":memory:");
	const fresh = new Database(":memory:");
	try {
		oldDatabase(db);
		const before = db.prepare(`SELECT * FROM ${TABLES[0]}`).get() as Record<string, unknown>;
		// Act
		db.exec(
			readFileSync(join(migrationDirectory, "0025_add_auth_link_browser_start_hash.sql"), "utf8"),
		);
		fresh.exec(AUTH_LINK_SCHEMA_SQL);
		// Assert
		assertUpgrade(db, before);
		for (const target of [db, fresh]) {
			const columns = target.prepare(`PRAGMA table_info(${TABLES[0]})`).all() as { name: string }[];
			const copy: Record<string, unknown> = { ...before, browser_start_hash: null };
			const names = columns.map((column) => column.name);
			const insert = target.prepare(
				`INSERT INTO ${TABLES[0]} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
			);
			const next: Record<string, unknown> = {
				...copy,
				attempt_id: "null-2",
				runtime_verifier_hash: otherHash,
			};
			insert.run(...names.map((name) => next[name]));
			if (target === fresh) insert.run(...names.map((name) => copy[name]));
			expect(target.prepare(`SELECT browser_start_hash FROM ${TABLES[0]}`).all()).toEqual([
				{ browser_start_hash: null },
				{ browser_start_hash: null },
			]);
			target
				.prepare(`UPDATE ${TABLES[0]} SET browser_start_hash = ? WHERE attempt_id = 'legacy'`)
				.run(codeHash);
			expect(() =>
				target
					.prepare(`UPDATE ${TABLES[0]} SET browser_start_hash = ? WHERE attempt_id = 'null-2'`)
					.run(codeHash),
			).toThrow();
			expect(() =>
				target
					.prepare(`UPDATE ${TABLES[0]} SET browser_start_hash = ? WHERE attempt_id = 'null-2'`)
					.run("z".repeat(64)),
			).toThrow();
		}
	} finally {
		db.close();
		fresh.close();
	}
});
