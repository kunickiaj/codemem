import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeRelayCheckPacket } from "./relay-admission-codec.js";
import {
	decideRelayAdmission,
	type RelayAdmissionDecisionDependencies,
} from "./relay-admission-decision.js";
import { decisionFixture, decisionSeed } from "./relay-admission-decision-test-fixtures.js";
import { RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS } from "./relay-admission-metadata-schema.js";
import {
	PARTICIPANT_REVOCATION_INSERT,
	PARTICIPANT_TEST_SCHEMA_SQL,
} from "./relay-admission-participant-nonce-test-fixtures.js";

type Bindings = readonly (string | number | null)[];
const params = (values: Bindings) =>
	Object.fromEntries(values.map((value, index) => [index + 1, value]));
let db: Database.Database;
let now: number;
const ledger = () => db.prepare("SELECT * FROM request_nonces").all();

function corruptReturning(raw: unknown, shape: string): unknown {
	if (shape === "null") return null;
	if (shape === "array") return [raw];
	if (shape === "envelope") return { results: [raw] };
	if (shape === "throw") throw new Error("commit acknowledgement lost");
	if (typeof raw !== "object" || raw === null) throw new Error("missing fixture receipt");
	const row = { ...raw };
	if (shape === "incomplete") {
		Reflect.deleteProperty(row, "createdAt");
		return row;
	}
	const changes: Record<string, [string, string | number]> = {
		attempt: ["attemptId", "0".repeat(32)],
		device: ["deviceId", "other"],
		nonce: ["nonce", "0".repeat(32)],
		policy: ["policyRevision", 2],
		readiness: ["readinessObservedAtMs", 0],
	};
	const change = changes[shape];
	if (!change) throw new Error("unknown receipt corruption fixture");
	const [key, value] = change;
	Reflect.set(row, key, value);
	return row;
}

beforeEach(() => {
	db = new Database(":memory:");
	db.pragma("foreign_keys = ON");
	db.exec(PARTICIPANT_TEST_SCHEMA_SQL);
	for (const sql of RELAY_ADMISSION_METADATA_SCHEMA_STATEMENTS) db.exec(sql);
	now = 110_000;
	// Control only this disposable backend's SQL clock, including its inserted timestamp.
	db.function("strftime", (format, when) => {
		if (when !== "now") throw new Error("unexpected clock input");
		if (format === "%s") return String(Math.floor(now / 1000));
		if (format === "%f")
			return `${String(Math.floor(now / 1000) % 60).padStart(2, "0")}.${String(now % 1000).padStart(3, "0")}`;
		if (format === "%Y-%m-%dT%H:%M:%fZ") return new Date(now).toISOString();
		throw new Error("unexpected clock format");
	});
});
afterEach(() => {
	vi.restoreAllMocks();
	db.close();
});

async function setup(
	options: Parameters<typeof decisionFixture>[0] = {},
	metadata: Parameters<typeof decisionSeed>[2] = {},
) {
	const f = await decisionFixture(options);
	for (const { sql, values } of decisionSeed(f, now, metadata)) db.prepare(sql).run(params(values));
	const calls: string[] = [];
	const deps = {
		database: {
			query: vi.fn(async (sql: string, bindings: Bindings): Promise<unknown> => {
				calls.push("query");
				return db.prepare(sql).all(params(bindings));
			}),
			insertReturning: vi.fn(async (sql: string, bindings: Bindings): Promise<unknown> => {
				calls.push("insert");
				return db.prepare(sql).get(params(bindings)) ?? null;
			}),
		},
		budgets: {
			reserveIngress: vi.fn(async () => {
				calls.push("ingress");
				return "reserved" as const;
			}),
			reserveVerifiedDevice: vi.fn(async () => {
				calls.push("verified");
				return "reserved" as const;
			}),
		},
	} satisfies RelayAdmissionDecisionDependencies;
	return { f, deps, calls };
}

describe("private relay admission decision", () => {
	it.each(["registration", "source", "relay", "responder"] as const)(
		"admits SOURCE-signed %s once",
		async (role) => {
			// Arrange
			const { f, deps, calls } = await setup({ role });
			const verify = vi.spyOn(crypto.subtle, "verify");
			// Act
			const result = await decideRelayAdmission(f.request, deps);
			const replay = await decideRelayAdmission(f.request, deps);
			// Assert: all roles authenticate the source, never the network forwarder.
			expect(result).not.toBeNull();
			expect(result).toMatchObject({
				receipt: { deviceId: "source", nonce: f.nonce, decidedAtMs: now },
				readiness: { state: "ready", revision: 1 },
			});
			expect(replay).toBeNull();
			if (role === "registration")
				expect(result).toMatchObject({ kind: "registration", socketExpiresInMs: 900_000 });
			else expect(result).toMatchObject({ kind: "admission", remainingMs: 45_000 });
			expect(ledger()).toHaveLength(1);
			expect(verify).toHaveBeenCalledTimes(2);
			expect(calls.slice(0, 5)).toEqual(["ingress", "query", "query", "verified", "insert"]);
			expect(deps.budgets.reserveIngress).toHaveBeenCalledWith({
				namespace: f.request.namespace,
				ingressKey: "trusted-ingress",
				expected: f.request.expected,
			});
			expect(deps.budgets.reserveVerifiedDevice).toHaveBeenCalledWith({
				namespace: f.request.namespace,
				ingressKey: "trusted-ingress",
				expected: f.request.expected,
				deviceId: "source",
				keyId: f.sourceKeyId,
			});
		},
	);

	it("uses the final SQL clock despite an unrelated application clock", async () => {
		// Arrange
		const { f, deps } = await setup();
		vi.spyOn(Date, "now").mockReturnValue(9_000_000_000_000);
		deps.budgets.reserveVerifiedDevice.mockImplementation(async () => {
			now = 120_123;
			return "reserved";
		});
		// Act
		const result = await decideRelayAdmission(f.request, deps);
		// Assert
		expect(result).toMatchObject({
			receipt: { decidedAtMs: 120_123, createdAt: "1970-01-01T00:02:00.123Z" },
		});
		expect(ledger()).toHaveLength(1);
	});

	it.each(["reserveIngress", "reserveVerifiedDevice"] as const)(
		"denies missing %s",
		async (stage) => {
			// Arrange
			const { f, deps } = await setup();
			Reflect.deleteProperty(deps.budgets, stage);
			// Act
			const result = await decideRelayAdmission(f.request, deps);
			// Assert
			expect(result).toBeNull();
			expect(deps.database.insertReturning).not.toHaveBeenCalled();
			expect(ledger()).toEqual([]);
		},
	);

	it.each(["reserveIngress", "reserveVerifiedDevice"] as const)(
		"denies every unsuccessful %s result",
		async (stage) => {
			// Arrange
			const { f, deps } = await setup();
			const digest = vi.spyOn(crypto.subtle, "digest");
			const dependency: RelayAdmissionDecisionDependencies = deps;
			// Act / Assert: no budget failure is retried or interpreted as permission.
			for (const outcome of ["denied", "unknown", "throw"] as const) {
				if (!dependency.budgets) throw new Error("missing fixture budgets");
				Reflect.set(dependency.budgets, stage, async () => {
					if (outcome === "throw") throw new Error("private budget detail");
					return outcome;
				});
				expect(await decideRelayAdmission(f.request, dependency)).toBeNull();
			}
			expect(deps.database.insertReturning).not.toHaveBeenCalled();
			if (stage === "reserveIngress") {
				expect(deps.database.query).not.toHaveBeenCalled();
				expect(digest).not.toHaveBeenCalled();
			}
		},
	);

	it("denies an absent budget provider before queries and hashing", async () => {
		// Arrange
		const { f, deps } = await setup();
		Reflect.deleteProperty(deps, "budgets");
		const digest = vi.spyOn(crypto.subtle, "digest");
		// Act
		const result = await decideRelayAdmission(f.request, deps);
		// Assert
		expect(result).toBeNull();
		expect(deps.database.query).not.toHaveBeenCalled();
		expect(digest).not.toHaveBeenCalled();
	});
});

describe("relay admission rejects untrusted context", () => {
	it.each(["packet", "expected", "namespace", "deviceHeader", "externalPathname"] as const)(
		"rejects invalid %s",
		async (field) => {
			// Arrange
			const { f, deps } = await setup();
			Reflect.set(f.request, field, null);
			// Act
			const result = await decideRelayAdmission(f.request, deps);
			// Assert
			expect(result).toBeNull();
			expect(deps.database.insertReturning).not.toHaveBeenCalled();
		},
	);

	it.each(["header", "path", "role", "namespace", "signature"])(
		"denies mismatched %s before the verified budget",
		async (change) => {
			// Arrange
			const { f, deps } = await setup({ role: "relay" });
			if (change === "header") f.request.deviceHeader = "target";
			if (change === "path") f.request.externalPathname = "/other/v1/relay/admission-check";
			if (change === "role") f.request.expected = { kind: "admission", role: "responder" };
			if (change === "namespace") f.request.namespace.groupId = "other";
			if (change === "signature")
				f.request.packet = encodeRelayCheckPacket({
					bodyBytes: f.bodyBytes,
					timestamp: String(f.createdAt),
					nonce: f.nonce,
					signatureBytes: new Uint8Array(64),
				});
			// Act
			const result = await decideRelayAdmission(f.request, deps);
			// Assert
			expect(result).toBeNull();
			expect(deps.budgets.reserveVerifiedDevice).not.toHaveBeenCalled();
			expect(deps.database.insertReturning).not.toHaveBeenCalled();
			expect(ledger()).toEqual([]);
		},
	);
});

describe("relay admission snapshot and final gates", () => {
	it("owns request values and dependency methods before ingress yields", async () => {
		// Arrange
		const { f, deps } = await setup();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		deps.budgets.reserveIngress.mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			return "reserved";
		});
		// Act
		const pending = decideRelayAdmission(f.request, deps);
		await entered.promise;
		f.request.namespace.groupId = "changed";
		Reflect.set(f.request.expected, "role", "responder");
		Reflect.set(f.request.packet, "body", "changed");
		Reflect.set(f.request.packet, "signature", "changed");
		f.request.deviceHeader = "target";
		f.request.externalPathname = "/changed";
		deps.database.query = vi.fn().mockRejectedValue(new Error("replacement port"));
		deps.budgets.reserveVerifiedDevice = vi.fn().mockRejectedValue(new Error("replacement budget"));
		release.resolve();
		const result = await pending;
		// Assert
		expect(result).not.toBeNull();
		expect(ledger()).toHaveLength(1);
		expect(deps.database.query).not.toHaveBeenCalled();
		expect(deps.budgets.reserveVerifiedDevice).not.toHaveBeenCalled();
	});

	it.each([
		"UPDATE relay_admission_authority_policy SET operator_state='disabled',policy_revision=2",
		"missing policy",
		"UPDATE relay_admission_readiness SET state='paused',revision=2 WHERE scope='authority'",
		"UPDATE relay_admission_readiness SET observed_at_ms=0,revision=2 WHERE scope='authority'",
	])("denies preflight %s without participant hashing", async (sql) => {
		// Arrange
		const { f, deps } = await setup({}, sql === "missing policy" ? { omit: "policy" } : {});
		if (sql !== "missing policy") db.exec(sql);
		const digest = vi.spyOn(crypto.subtle, "digest");
		// Act
		const result = await decideRelayAdmission(f.request, deps);
		// Assert
		expect(result).toBeNull();
		expect(deps.database.query).toHaveBeenCalledTimes(1);
		expect(digest).not.toHaveBeenCalled();
		expect(deps.database.insertReturning).not.toHaveBeenCalled();
	});

	it.each([
		"UPDATE enrolled_devices SET enabled=0 WHERE device_id='target'",
		"UPDATE enrolled_devices SET public_key='changed' WHERE device_id='source'",
		"UPDATE enrolled_devices SET identity_id='linked' WHERE device_id='source'",
		"UPDATE relay_admission_authority_policy SET policy_revision=2",
		"UPDATE relay_admission_readiness SET state='paused',revision=2 WHERE scope='authority'",
		"UPDATE groups SET archived_at='archived'",
		"expired",
		"revoked",
	])("rechecks %s after successful crypto and before nonce insertion", async (sql) => {
		// Arrange
		const { f, deps } = await setup();
		const verify = vi.spyOn(crypto.subtle, "verify");
		deps.budgets.reserveVerifiedDevice.mockImplementation(async () => {
			if (sql === "expired") now = 130_000;
			else if (sql === "revoked")
				db.prepare(PARTICIPANT_REVOCATION_INSERT).run(params(["device_id", "target"]));
			else db.exec(sql);
			return "reserved";
		});
		// Act
		const result = await decideRelayAdmission(f.request, deps);
		// Assert
		expect(result).toBeNull();
		expect(verify).toHaveBeenCalledOnce();
		expect(deps.database.insertReturning).toHaveBeenCalledOnce();
		expect(ledger()).toEqual([]);
	});

	it("gives simultaneous replay attempts exactly one decision", async () => {
		// Arrange
		const { f, deps } = await setup();
		// Act
		const results = await Promise.all([
			decideRelayAdmission(f.request, deps),
			decideRelayAdmission(f.request, deps),
		]);
		// Assert
		expect(results.filter((result) => result !== null)).toHaveLength(1);
		expect(ledger()).toHaveLength(1);
	});
});

describe("relay admission backend contract", () => {
	it.each(["preflight", "participants"])(
		"denies failed %s queries without insertion",
		async (stage) => {
			// Arrange
			const { f, deps } = await setup();
			const query = deps.database.query.getMockImplementation();
			if (!query) throw new Error("missing query fixture");
			let count = 0;
			deps.database.query.mockImplementation(async (...args) => {
				count++;
				if (count === (stage === "preflight" ? 1 : 2)) throw new Error("private query detail");
				return query(...args);
			});
			// Act
			const result = await decideRelayAdmission(f.request, deps);
			// Assert
			expect(result).toBeNull();
			expect(deps.budgets.reserveVerifiedDevice).not.toHaveBeenCalled();
			expect(deps.database.insertReturning).not.toHaveBeenCalled();
		},
	);

	it("orders ingress, preflight, participants, hashes, crypto, verified budget, and insert", async () => {
		// Arrange
		const { f, deps, calls } = await setup();
		const digest = crypto.subtle.digest.bind(crypto.subtle);
		const verify = crypto.subtle.verify.bind(crypto.subtle);
		vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
			calls.push("hash");
			return digest(...args);
		});
		vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
			calls.push("crypto");
			return verify(...args);
		});
		// Act
		const result = await decideRelayAdmission(f.request, deps);
		// Assert
		expect(result).not.toBeNull();
		expect(calls.slice(0, 3)).toEqual(["ingress", "query", "query"]);
		expect(calls.slice(3, -3).every((stage) => stage === "hash")).toBe(true);
		expect(calls.slice(-3)).toEqual(["crypto", "verified", "insert"]);
	});

	it.each([
		"null",
		"array",
		"envelope",
		"throw",
		"incomplete",
		"attempt",
		"device",
		"nonce",
		"policy",
		"readiness",
	])("denies a %s RETURNING result without retrying a committed nonce", async (shape) => {
		// Arrange
		const { f, deps } = await setup();
		const insert = deps.database.insertReturning.getMockImplementation();
		if (!insert) throw new Error("missing insert fixture");
		deps.database.insertReturning.mockImplementation(async (...args) => {
			return corruptReturning(await insert(...args), shape);
		});
		// Act
		const result = await decideRelayAdmission(f.request, deps);
		// Assert
		expect(result).toBeNull();
		expect(deps.database.insertReturning).toHaveBeenCalledOnce();
		expect(ledger()).toHaveLength(1);
	});

	it.each([null, { results: [] }])("denies non-array query results %j", async (rows) => {
		// Arrange
		const { f, deps } = await setup();
		deps.database.query.mockResolvedValue(rows);
		// Act
		const result = await decideRelayAdmission(f.request, deps);
		// Assert
		expect(result).toBeNull();
		expect(deps.database.insertReturning).not.toHaveBeenCalled();
	});
});
