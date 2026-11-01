import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	RELAY_ADMISSION_CLOCK_SQL,
	readRelayAdmissionNonceReceipt,
} from "./relay-admission-clock.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import {
	type MetadataSeedOptions,
	metadataSeed,
} from "./relay-admission-metadata-test-fixtures.js";
import {
	buildRelayAdmissionNonceStatement,
	captureRelayAdmissionParticipants,
	RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL,
} from "./relay-admission-participant-nonce.js";
import {
	PARTICIPANT_CREATED_AT,
	PARTICIPANT_DEVICE_INSERT,
	PARTICIPANT_GROUP_INSERT,
	PARTICIPANT_KEYS,
	PARTICIPANT_REVOCATION_INSERT,
	PARTICIPANT_TEST_SCHEMA_SQL,
	participantFixture,
	participantRows,
} from "./relay-admission-participant-nonce-test-fixtures.js";
import { readRelayAdmissionReadinessStamp } from "./relay-admission-readiness.js";

afterEach(() => vi.restoreAllMocks());

describe("capture only the requested relay participants", () => {
	it.each(["registration", "source", "relay", "responder"] as const)(
		"owns canonical wire-key hashes for %s",
		async (role) => {
			// Arrange
			const f = await participantFixture({ role, groupId: "e\u0301-組" });
			// Act
			const reversed = await captureRelayAdmissionParticipants(
				role === "registration" ? [f.rows[0]] : [...f.rows].reverse(),
				f.context,
			);
			// Assert: expected SHA-256 values cover the canonical 51-byte SSH wire, not raw/SPKI/text.
			expect(reversed).toEqual(f.input.participants);
			expect(reversed?.source).toEqual({ ...f.rows[0], keyId: PARTICIPANT_KEYS[0].keyId });
			expect(Object.isFrozen(reversed?.source)).toBe(true);
			if (role !== "registration") expect(reversed?.target?.keyId).toBe(PARTICIPANT_KEYS[1].keyId);
		},
	);

	it.each([
		["non-array", null],
		["missing", []],
		["duplicate", [0, 0]],
		["extra", [0, 1, 0]],
		["missing target", [0]],
	] as const)("rejects %s backend rows", async (_name, indices) => {
		// Arrange
		const rows = participantRows();
		const input = indices?.map((index) => rows[index]) ?? null;
		// Act
		const result = await captureRelayAdmissionParticipants(input, {
			groupId: "group-A",
			sourceDeviceId: "source",
			targetDeviceId: "target",
		});
		// Assert
		expect(result).toBeNull();
	});

	it.each([
		["group_id", "other"],
		["device_id", "other"],
		["public_key", "opaque"],
		["public_key", "ssh-rsa AAAA"],
		["public_key", "ssh-ed25519 AAAA"],
		["fingerprint", null],
		["identity_id", undefined],
		["identity_id", 1],
		["enabled", "1"],
		["enabled", true],
		["enabled", 0],
		["enabled", 2],
	] as const)("rejects malformed %s=%j on either requested row", async (field, value) => {
		// Arrange
		for (const index of [0, 1]) {
			const rows = participantRows();
			Reflect.set(rows[index], field, value);
			// Act
			const result = await captureRelayAdmissionParticipants(rows, {
				groupId: "group-A",
				sourceDeviceId: "source",
				targetDeviceId: "target",
			});
			// Assert
			expect(result).toBeNull();
		}
	});

	it.each(["", " group-A", "group-A ", "a\0b", "a\x1fb", "a\x7fb", "\ud800", "組".repeat(43)])(
		"rejects invalid group context %j",
		async (groupId) => {
			// Arrange
			const rows = participantRows(groupId);
			// Act
			const result = await captureRelayAdmissionParticipants([rows[0]], {
				groupId,
				sourceDeviceId: "source",
			});
			// Assert
			expect(result).toBeNull();
		},
	);

	it.each(["", "has space", "é", "x".repeat(65), "a\n"])(
		"rejects invalid device context %j",
		async (sourceDeviceId) => {
			// Arrange
			const rows = participantRows("group-A", sourceDeviceId);
			// Act
			const result = await captureRelayAdmissionParticipants([rows[0]], {
				groupId: "group-A",
				sourceDeviceId,
			});
			// Assert
			expect(result).toBeNull();
		},
	);

	it("rejects identical source and target and extra registration participants", async () => {
		// Arrange
		const rows = participantRows();
		// Act
		const same = await captureRelayAdmissionParticipants([rows[0]], {
			groupId: "group-A",
			sourceDeviceId: "source",
			targetDeviceId: "source",
		});
		const extra = await captureRelayAdmissionParticipants(rows, {
			groupId: "group-A",
			sourceDeviceId: "source",
		});
		// Assert
		expect([same, extra]).toEqual([null, null]);
	});
});

describe("capture owns snapshots across hashing", () => {
	it("snapshots both tuples and all context before the first hash yields", async () => {
		// Arrange
		const rows = participantRows();
		const original = rows.map((row) => ({ ...row }));
		const context = { groupId: "group-A", sourceDeviceId: "source", targetDeviceId: "target" };
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return digest(...args);
		});
		// Act
		const pending = captureRelayAdmissionParticipants(rows, context);
		await entered.promise;
		for (const row of rows)
			Object.assign(row, {
				group_id: "changed",
				device_id: "changed",
				public_key: "bad",
				fingerprint: "changed",
				identity_id: "changed",
				enabled: 0,
			});
		Object.assign(context, {
			groupId: "changed",
			sourceDeviceId: "changed",
			targetDeviceId: "changed",
		});
		release.resolve();
		const result = await pending;
		// Assert
		expect(result).toEqual({
			source: { ...original[0], keyId: PARTICIPANT_KEYS[0].keyId },
			target: { ...original[1], keyId: PARTICIPANT_KEYS[1].keyId },
		});
	});

	it.each([0, 1])("does not repair initially invalid row %i during hashing", async (index) => {
		// Arrange: a later hash must never repair an invalid initial primitive.
		const rows = participantRows();
		rows[index].enabled = 0;
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, "digest").mockImplementationOnce(async (...args) => {
			rows[index].enabled = 1;
			return digest(...args);
		});
		// Act
		const result = await captureRelayAdmissionParticipants(rows, {
			groupId: "group-A",
			sourceDeviceId: "source",
			targetDeviceId: "target",
		});
		// Assert
		expect(result).toBeNull();
	});

	it("returns null without diagnostics on crypto failure", async () => {
		// Arrange
		vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("private backend detail"));
		const log = vi.spyOn(console, "error").mockImplementation(() => {});
		// Act
		const result = await captureRelayAdmissionParticipants([participantRows()[0]], {
			groupId: "group-A",
			sourceDeviceId: "source",
		});
		// Assert
		expect(result).toBeNull();
		expect(log).not.toHaveBeenCalled();
	});
});

describe("compile untrusted decoded claims into conditional SQL only", () => {
	it.each(["registration", "source", "relay", "responder"] as const)(
		"preserves the fixed twelve-bind ABI for %s",
		async (role) => {
			// Arrange
			const f = await participantFixture({ role, sourceDeviceId: "source'\\;--" });
			// Act
			const { sql, bindings, association } = f.statement;
			// Assert
			expect(bindings).toEqual([
				f.rows[0].device_id,
				"b".repeat(32),
				"c".repeat(32),
				130_000,
				"a".repeat(64),
				"group-A",
				"f".repeat(64),
				1,
				expect.any(String),
				role === "registration" ? null : expect.any(String),
				100_000,
				role === "registration" ? null : 155_000,
			]);
			expect(JSON.parse(String(bindings[8]))).toEqual(f.input.participants.source);
			if (role !== "registration")
				expect(JSON.parse(String(bindings[9]))).toEqual(f.input.participants.target);
			expect(association).toEqual({
				deviceId: f.rows[0].device_id,
				nonce: "b".repeat(32),
				attemptId: "c".repeat(32),
			});
			for (let slot = 1; slot <= 12; slot++) expect(sql).toMatch(new RegExp(`\\?${slot}(?![0-9])`));
			expect(sql).not.toContain(f.rows[0].device_id);
			expect(sql.match(/INSERT\s+INTO\s+request_nonces/gi)).toHaveLength(1);
			expect(sql).toContain(RELAY_ADMISSION_CLOCK_SQL);
			expect(Object.keys(f.statement).sort()).toEqual(["association", "bindings", "sql"]);
		},
	);

	it.each([
		["attemptId", "A".repeat(32)],
		["attemptId", "c".repeat(31)],
		["attemptId", null],
		["policyRevision", 0],
		["policyRevision", -1],
		["policyRevision", 1.5],
		["policyRevision", Number.MAX_SAFE_INTEGER + 1],
		["policyRevision", "1"],
	] as const)("rejects invalid trusted %s=%j", async (field, value) => {
		// Arrange
		const f = await participantFixture();
		Reflect.set(f.input, field, value);
		// Act
		const statement = buildRelayAdmissionNonceStatement(f.input);
		// Assert
		expect(statement).toBeNull();
	});

	it.each(["authorityId", "groupId", "relayAudienceId"] as const)(
		"rejects a mismatched explicit namespace %s",
		async (field) => {
			// Arrange
			const f = await participantFixture();
			Reflect.set(f.input.namespace, field, "different");
			// Act
			const result = buildRelayAdmissionNonceStatement(f.input);
			// Assert
			expect(result).toBeNull();
		},
	);
});

describe("compiler revalidates decoded claims and captures", () => {
	it.each([
		["kind", "registration"],
		["timestamp", "0100"],
		["nonce", "B".repeat(32)],
		["signatureBytes", new Uint8Array(63)],
		["bodyBytes", new TextEncoder().encode("[]")],
	] as const)("rejects inconsistent decoded %s", async (field, value) => {
		// Arrange
		const f = await participantFixture();
		Reflect.set(f.input.check, field, value);
		// Act
		const result = buildRelayAdmissionNonceStatement(f.input);
		// Assert
		expect(result).toBeNull();
	});

	it.each([
		"createdAt",
		"admitBefore",
		"routeNotAfter",
		"sourceDeviceId",
		"sourceKeyId",
		"targetDeviceId",
		"targetKeyId",
		"role",
	])("rejects value.%s inconsistent with original bytes", async (field) => {
		// Arrange
		const f = await participantFixture();
		Reflect.set(f.input.check.value, field, field.endsWith("Id") ? "9".repeat(64) : 999);
		// Act
		const result = buildRelayAdmissionNonceStatement(f.input);
		// Assert
		expect(result).toBeNull();
	});

	it.each(["source", "target"] as const)(
		"rejects %s key-ID substitution, swapped captures and missing route target",
		async (side) => {
			// Arrange
			const f = await participantFixture();
			if (!f.input.participants.target) throw new Error("missing route fixture target");
			// Production callers must use capture-helper provenance. These frozen
			// adversarial copies pass the shape check and exercise claim matching.
			const changed = Object.freeze({
				...f.input.participants,
				[side]: Object.freeze({ ...f.input.participants[side], keyId: "9".repeat(64) }),
			});
			// Act
			const mismatch = buildRelayAdmissionNonceStatement({ ...f.input, participants: changed });
			const swapped = buildRelayAdmissionNonceStatement({
				...f.input,
				participants: Object.freeze({
					source: f.input.participants.target,
					target: f.input.participants.source,
				}),
			});
			const missing = buildRelayAdmissionNonceStatement({
				...f.input,
				participants: Object.freeze({ ...f.input.participants, target: null }),
			});
			// Assert
			expect([mismatch, swapped, missing]).toEqual([null, null, null]);
		},
	);

	it("requires a null registration target and owns output after input mutation", async () => {
		// Arrange
		const f = await participantFixture({ role: "registration" });
		const before = JSON.stringify(f.statement);
		// Act
		const extra = buildRelayAdmissionNonceStatement({
			...f.input,
			participants: Object.freeze({ ...f.input.participants, target: f.input.participants.source }),
		});
		f.input.check.bodyBytes.fill(0);
		Reflect.set(f.input.check.value, "deviceId", "changed");
		f.input.attemptId = "d".repeat(32);
		f.input.namespace.groupId = "changed";
		// Assert
		expect(extra).toBeNull();
		expect(JSON.stringify(f.statement)).toBe(before);
	});
});

let db: Database.Database;
let now: number;
function setupSqlite() {
	db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) db.exec(sql);
	now = 110_000;
	db.function("strftime", (format, when) => {
		if (when !== "now") throw new Error("unexpected clock input");
		if (format === "%s") return String(Math.floor(now / 1000));
		if (format === "%f")
			return `${String(Math.floor(now / 1000) % 60).padStart(2, "0")}.${String(now % 1000).padStart(3, "0")}`;
		if (format === "%Y-%m-%dT%H:%M:%fZ") return new Date(now).toISOString();
		throw new Error("unexpected clock format");
	});
}
const params = (values: readonly (string | number | null)[]) =>
	Object.fromEntries(values.map((value, index) => [index + 1, value]));
function seed(
	f: Awaited<ReturnType<typeof participantFixture>>,
	options: MetadataSeedOptions = {},
) {
	db.prepare(PARTICIPANT_GROUP_INSERT).run(params([f.context.groupId, PARTICIPANT_CREATED_AT]));
	for (const row of f.rows)
		db.prepare(PARTICIPANT_DEVICE_INSERT).run(
			params([...Object.values(row), PARTICIPANT_CREATED_AT]),
		);
	for (const entry of metadataSeed({
		authorityObserved: 100_000,
		realmObserved: 100_000,
		...options,
	}))
		db.prepare(entry.sql).run(params(entry.values));
}
const insert = (f: Awaited<ReturnType<typeof participantFixture>>) =>
	db.prepare(f.statement.sql).get(params(f.statement.bindings));
const ledger = () => db.prepare("SELECT * FROM request_nonces").all();

describe("single conditional nonce INSERT on disposable SQLite", () => {
	beforeEach(setupSqlite);
	afterEach(() => db.close());
	it.each(["registration", "source", "relay", "responder"] as const)(
		"inserts one storage receipt for %s and no replay fallback",
		async (role) => {
			// Arrange
			const f = await participantFixture({ role });
			seed(f);
			// Act
			const row = insert(f);
			const receipt = readRelayAdmissionNonceReceipt(row, f.statement.association);
			const retry = buildRelayAdmissionNonceStatement({ ...f.input, attemptId: "d".repeat(32) });
			if (!retry || !receipt) throw new Error("missing positive compiler or receipt result");
			const replay = db.prepare(retry.sql).get(params(retry.bindings));
			// Assert: this is storage evidence only. No signature or budget gate ran.
			expect(receipt).toMatchObject({ decidedAtMs: now, deviceId: "source" });
			expect(readRelayAdmissionReadinessStamp(row, receipt)).toMatchObject({
				revision: 1,
				state: "ready",
			});
			expect(readRelayAdmissionNonceReceipt(row, retry.association)).toBeNull();
			expect(replay).toBeUndefined();
			expect(ledger()).toHaveLength(1);
		},
	);

	it("capture SQL reads six raw columns for only requested IDs, including disabled participants", () => {
		// Arrange
		db.prepare(PARTICIPANT_GROUP_INSERT).run(params(["group-A", PARTICIPANT_CREATED_AT]));
		const rows = participantRows();
		rows[1].enabled = 0;
		for (const row of [...rows, { ...rows[0], device_id: "bystander" }])
			db.prepare(PARTICIPANT_DEVICE_INSERT).run(
				params([...Object.values(row), PARTICIPANT_CREATED_AT]),
			);
		// Act
		const route = db
			.prepare(RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL)
			.all(params(["group-A", "source", "target"]));
		const registration = db
			.prepare(RELAY_ADMISSION_CAPTURE_PARTICIPANTS_SQL)
			.all(params(["group-A", "source", null]));
		// Assert
		expect(route).toEqual(expect.arrayContaining(rows));
		expect(route).toHaveLength(2);
		expect(registration).toEqual([rows[0]]);
	});
});

describe("current participant tuples on disposable SQLite", () => {
	beforeEach(setupSqlite);
	afterEach(() => db.close());
	it.each([0, 1] as const)(
		"denies participant %i identity changing from a string to NULL",
		async (index) => {
			// Arrange: recapture the initial string identity so equality succeeds before mutation.
			const f = await participantFixture();
			f.rows[index].identity_id = "linked-before-capture";
			const participants = await captureRelayAdmissionParticipants(f.rows, f.context);
			if (!participants) throw new Error("linked participant capture rejected");
			const statement = buildRelayAdmissionNonceStatement({ ...f.input, participants });
			if (!statement) throw new Error("linked participant statement rejected");
			seed(f);
			// Act: clear only the disposable nonce so replay cannot explain the second denial.
			const positive = db.prepare(statement.sql).get(params(statement.bindings));
			db.exec("DELETE FROM request_nonces");
			db.prepare("UPDATE enrolled_devices SET identity_id=NULL WHERE device_id=?1").run(
				params([f.rows[index].device_id]),
			);
			const changed = db.prepare(statement.sql).get(params(statement.bindings));
			// Assert
			expect(readRelayAdmissionNonceReceipt(positive, statement.association)).not.toBeNull();
			expect(changed).toBeUndefined();
			expect(ledger()).toEqual([]);
		},
	);

	it.each(
		["source", "target"].flatMap((deviceId) =>
			[
				["public_key", PARTICIPANT_KEYS[deviceId === "source" ? 1 : 0].publicKey],
				["fingerprint", "changed"],
				["identity_id", "linked"],
				["enabled", 0],
				["group_id", "other"],
				["device_id", "replacement"],
			].map(([column, value]) => ({ deviceId, column, value })),
		),
	)(
		"denies changed tuple $deviceId.$column at the SQL step",
		async ({ deviceId, column, value }) => {
			// Arrange: every case has a fresh database and a pre-mutation capture.
			const f = await participantFixture();
			seed(f);
			// Act: column names above are a static test allowlist, never packet data.
			db.prepare(`UPDATE enrolled_devices SET ${column}=?1 WHERE device_id=?2`).run(
				params([value, deviceId]),
			);
			const result = insert(f);
			// Assert
			expect(result).toBeUndefined();
			expect(ledger()).toEqual([]);
		},
	);

	it.each(["source", "target"])(
		"applies global device and canonical-key revocations to %s",
		async (deviceId) => {
			// Arrange
			const f = await participantFixture();
			seed(f);
			const keyId = deviceId === "source" ? PARTICIPANT_KEYS[0].keyId : PARTICIPANT_KEYS[1].keyId;
			for (const [kind, value] of [
				["device_id", deviceId],
				["ed25519_key", keyId],
			]) {
				// Act: evidence deliberately belongs to another group.
				db.prepare(PARTICIPANT_REVOCATION_INSERT).run(params([kind, value]));
				const row = insert(f);
				// Assert
				expect(row).toBeUndefined();
				expect(ledger()).toEqual([]);
				db.prepare("DELETE FROM coordinator_device_revocations").run();
			}
		},
	);
});

describe("final SQL clock and metadata checks", () => {
	beforeEach(setupSqlite);
	afterEach(() => db.close());
	it.each([94_999, 95_000, 100_000, 129_999, 130_000, 155_000])(
		"enforces time boundaries at SQL clock %i",
		async (decisionMs) => {
			// Arrange
			const f = await participantFixture();
			seed(f, { authorityObserved: 90_000, realmObserved: 90_000 });
			now = decisionMs;
			vi.spyOn(Date, "now").mockReturnValue(999_999_999);
			// Act
			const row = insert(f);
			// Assert
			const allowed = decisionMs >= 95_000 && decisionMs < 130_000;
			expect(row !== undefined).toBe(allowed);
			expect(ledger()).toHaveLength(Number(allowed));
		},
	);

	it.each([
		{ operatorState: "disabled" },
		{ realmState: "disabled" },
		{ audienceState: "revoked" },
		{ healthState: "tripped" },
		{ authorityObserved: 0 },
		{ omit: "realmHealth" },
	] satisfies MetadataSeedOptions[])("denies metadata %j without inserting", async (options) => {
		// Arrange
		const f = await participantFixture();
		seed(f, options);
		// Act
		const row = insert(f);
		// Assert
		expect(row).toBeUndefined();
		expect(ledger()).toEqual([]);
	});

	it.each(["archive", "missing group", "policy revision"])(
		"denies %s changed after compilation",
		async (change) => {
			// Arrange
			const f = await participantFixture();
			seed(f);
			// Act
			if (change === "archive") db.exec("UPDATE groups SET archived_at='archived'");
			if (change === "missing group") db.exec("DELETE FROM groups");
			if (change === "policy revision")
				db.exec("UPDATE relay_admission_authority_policy SET policy_revision=2");
			const row = insert(f);
			// Assert
			expect(row).toBeUndefined();
			expect(ledger()).toEqual([]);
		},
	);
});
