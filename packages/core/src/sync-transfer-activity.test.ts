import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAdditiveSchemaCompatibility } from "./db.js";
import { SecretScanner } from "./secret-scanner.js";
import { applyBootstrapSnapshot, mergeBootstrapSnapshot } from "./sync-bootstrap.js";
import { applyPeerReplicationOps, applyReplicationOps } from "./sync-replication.js";
import {
	readPeerSyncActivity,
	recordSyncTransferObservation,
	recordSyncTransferReceipts,
	type SyncTransferObservationSource,
} from "./sync-transfer-activity.js";
import { initTestSchema } from "./test-utils.js";
import type { ReplicationOp, SyncResetRequired } from "./types.js";

let db: InstanceType<typeof Database>;
const scanner = new SecretScanner();
const peer = "fixture-peer";
const local = "fixture-local";

beforeEach(() => {
	db = new Database(":memory:");
	initTestSchema(db);
});
afterEach(() => {
	vi.useRealTimers();
	db.close();
});

function op(id: string): ReplicationOp {
	return {
		op_id: id,
		entity_type: "memory_item",
		entity_id: `fixture:${id}`,
		op_type: "upsert",
		payload_json: JSON.stringify({
			title: "Fixture",
			body_text: "Synthetic content",
			visibility: "shared",
		}),
		clock_rev: 1,
		clock_updated_at: "2026-01-01T00:00:00Z",
		created_at: "2026-01-01T00:00:00Z",
		device_id: peer,
		clock_device_id: peer,
		scope_id: null,
	};
}

function push(ops: ReplicationOp[]) {
	return applyPeerReplicationOps({ db, scanner }, ops, local, { peerDeviceId: peer });
}

function pull(ops: ReplicationOp[]) {
	return applyReplicationOps(db, ops, local, scanner, { activityPeerDeviceId: peer });
}

function activity() {
	const result = readPeerSyncActivity(db, [peer]).get(peer);
	if (!result) throw new Error("missing_fixture_activity");
	return result;
}

function reopen() {
	const bytes = db.serialize();
	db.close();
	db = new Database(bytes);
}

function applyObservedFlow(source: SyncTransferObservationSource, ops: ReplicationOp[]) {
	const inboundScopeValidation = { peerDeviceId: peer };
	if (source === "inbound") {
		return applyPeerReplicationOps({ db, scanner }, ops, local, {
			peerDeviceId: peer,
			inboundScopeValidation,
		});
	}
	return applyReplicationOps(db, ops, local, scanner, {
		activityPeerDeviceId: peer,
		inboundScopeValidation,
	});
}

function scopedOp(id: string, scopeId = "fixture-valid-scope"): ReplicationOp {
	const operation = op(id);
	return {
		...operation,
		scope_id: scopeId,
		payload_json: JSON.stringify({ ...JSON.parse(operation.payload_json), scope_id: scopeId }),
	};
}

function grantReceiveFixtureScope(scopeId: string) {
	db.prepare(`INSERT INTO replication_scopes(scope_id, label, kind, authority_type,
		membership_epoch, status, created_at, updated_at)
		VALUES (?, 'Fixture', 'team', 'coordinator', 1, 'active', ?, ?)`).run(
		scopeId,
		"2026-01-01T00:00:00Z",
		"2026-01-01T00:00:00Z",
	);
	for (const device of [local, peer]) {
		db.prepare(`INSERT INTO scope_memberships(scope_id, device_id, role, status,
			membership_epoch, updated_at) VALUES (?, ?, 'member', 'active', 1, ?)`).run(
			scopeId,
			device,
			"2026-01-01T00:00:00Z",
		);
	}
}

function failedReceiveFixture(errorCode: "apply_failed" | "scope_rejected") {
	if (errorCode === "apply_failed") {
		db.exec(`CREATE TRIGGER fail_source_fixture AFTER INSERT ON replication_ops
			WHEN NEW.op_id = 'failed-source-op' BEGIN SELECT RAISE(ABORT, 'fixture apply failure'); END`);
		return {
			operation: scopedOp("failed-source-op"),
			repair: () => db.exec("DROP TRIGGER fail_source_fixture"),
		};
	}
	return {
		operation: scopedOp("failed-source-op", "fixture-rejected-scope"),
		repair: () => grantReceiveFixtureScope("fixture-rejected-scope"),
	};
}

const receiveIsolationCases = (["initiated", "inbound"] as const).flatMap((source) =>
	(["apply_failed", "scope_rejected"] as const).flatMap((errorCode) =>
		[false, true].map((hasOtherOperation) => ({ source, errorCode, hasOtherOperation })),
	),
);

it.each(receiveIsolationCases)(
	"keeps $source $errorCode after the other flow succeeds (nonempty: $hasOtherOperation) until its own retry",
	({ source, errorCode, hasOtherOperation }) => {
		// Arrange: persist an actual failed apply before the other request source runs.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
		grantReceiveFixtureScope("fixture-valid-scope");
		const fixture = failedReceiveFixture(errorCode);
		const failed = applyObservedFlow(source, [fixture.operation]);
		const afterFailure = activity().receive;
		reopen();
		const otherSource = source === "initiated" ? "inbound" : "initiated";
		const otherOps = hasOtherOperation ? [scopedOp("other-source-op")] : [];

		// Act: a heartbeat or applied operation from the other source cannot resolve this error.
		vi.setSystemTime(new Date("2026-11-02T11:00:00Z"));
		const otherSuccess = applyObservedFlow(otherSource, otherOps);
		const afterOtherSuccess = activity().receive;
		const duplicate = applyObservedFlow(otherSource, otherOps);
		fixture.repair();
		vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
		const retry = applyObservedFlow(source, [fixture.operation]);
		const replay = applyObservedFlow(otherSource, [fixture.operation]);

		// Assert: only the owner's success clears its failure, and cross-source retries count once.
		expect(failed.applied).toBe(0);
		if (errorCode === "scope_rejected") expect(failed.rejected).toBe(1);
		else expect(failed.errors).toHaveLength(1);
		expect(afterFailure).toMatchObject({ errorCode, operations24h: 0, lastSuccessAt: null });
		expect(otherSuccess).toMatchObject({
			applied: Number(hasOtherOperation),
			errors: [],
			rejected: 0,
		});
		expect(afterOtherSuccess).toMatchObject({
			errorCode,
			operations24h: Number(hasOtherOperation),
			observedSince: "2026-11-02T10:00:00.000Z",
			lastAttemptAt: "2026-11-02T11:00:00.000Z",
			lastSuccessAt: "2026-11-02T11:00:00.000Z",
		});
		expect(duplicate).toMatchObject({ applied: 0, skipped: Number(hasOtherOperation), errors: [] });
		expect(retry).toMatchObject({ applied: 1, errors: [], rejected: 0 });
		expect(replay).toMatchObject({ applied: 0, skipped: 1, errors: [] });
		expect(activity().receive).toMatchObject({
			errorCode: null,
			operations24h: 1 + Number(hasOtherOperation),
			lastSuccessAt: "2026-11-02T12:00:00.000Z",
		});
		expect(activity().send).toMatchObject({
			errorCode: null,
			operations24h: null,
			lastSuccessAt: null,
		});
	},
);

it.each(
	(["initiated", "inbound"] as const).flatMap((source) =>
		(["apply_failed", "scope_rejected"] as const).map((errorCode) => ({ source, errorCode })),
	),
)(
	"prioritizes unresolved $source $errorCode over a newer generic failure from the other source",
	({ source, errorCode }) => {
		// Arrange: the specific failure predates a generic error in the other flow.
		const otherSource = source === "initiated" ? "inbound" : "initiated";
		recordSyncTransferObservation(db, peer, "receive", {
			source,
			errorCode,
			now: new Date("2026-11-02T10:00:00Z"),
		});
		reopen();

		// Act: recovering one source must reveal, rather than clear, the other source's error.
		recordSyncTransferObservation(db, peer, "receive", {
			source: otherSource,
			errorCode: "exchange_failed",
			now: new Date("2026-11-02T11:00:00Z"),
		});
		const bothFailed = activity().receive;
		recordSyncTransferObservation(db, peer, "receive", {
			source,
			now: new Date("2026-11-02T12:00:00Z"),
		});
		const oneRecovered = activity().receive;
		recordSyncTransferObservation(db, peer, "receive", {
			source: otherSource,
			now: new Date("2026-11-02T13:00:00Z"),
		});

		// Assert
		expect(bothFailed).toMatchObject({
			errorCode,
			lastSuccessAt: null,
			lastAttemptAt: "2026-11-02T11:00:00.000Z",
		});
		expect(oneRecovered).toMatchObject({
			errorCode: "exchange_failed",
			lastSuccessAt: "2026-11-02T12:00:00.000Z",
		});
		expect(activity().receive).toMatchObject({
			errorCode: null,
			lastSuccessAt: "2026-11-02T13:00:00.000Z",
			observedSince: "2026-11-02T10:00:00.000Z",
		});
	},
);

it("records inbound-only applied operations without inventing send history", () => {
	expect(push([op("inbound")]).applied).toBe(1);
	expect(activity()).toMatchObject({
		receive: { operations24h: 1, errorCode: null, lastSuccessAt: expect.any(String) },
		send: { operations24h: null, lastSuccessAt: null },
	});
});

it.each(["push-first", "pull-first"])("deduplicates %s retries across reopen", (order) => {
	const first = order === "push-first" ? push : pull;
	const second = order === "push-first" ? pull : push;
	expect(first([op("duplicate")]).applied).toBe(1);
	reopen();
	expect(second([op("duplicate")]).skipped).toBe(1);
	expect(second([op("duplicate")]).skipped).toBe(1);
	expect(activity().receive.operations24h).toBe(1);
});

it("retains committed mutations on partial failure and excludes skipped operations", () => {
	db.exec(`CREATE TRIGGER fail_fixture AFTER INSERT ON replication_ops
		WHEN NEW.op_id = 'fail' BEGIN SELECT RAISE(ABORT, 'private detail'); END`);
	const skipped = { ...op("skipped"), op_type: "unsupported" };
	const own = { ...op("own"), device_id: local, clock_device_id: local };
	const result = push([op("applied"), op("fail"), skipped, own]);
	expect(result).toMatchObject({ applied: 1, skipped: 2, errors: [expect.any(String)] });
	expect(activity().receive).toMatchObject({
		operations24h: 1,
		errorCode: "apply_failed",
		lastSuccessAt: null,
	});
	expect(JSON.stringify(activity())).not.toContain("private detail");
	reopen();
	expect(activity().receive.operations24h).toBe(1);
	db.exec("DROP TRIGGER fail_fixture");
	expect(push([op("applied"), op("fail"), skipped, own]).applied).toBe(1);
	expect(activity().receive).toMatchObject({ operations24h: 2, errorCode: null });
});

it("keeps receipt and content atomic when the enclosing transaction rolls back", () => {
	expect(() =>
		db.transaction(() => {
			push([op("rolled-back")]);
			throw new Error("rollback fixture");
		})(),
	).toThrow("rollback fixture");
	expect(db.prepare("SELECT count(*) FROM memory_items").pluck().get()).toBe(0);
	expect(activity().receive.operations24h).toBeNull();
});

it("reports historical upgraded data as unknown and preserves data on repeated migration", () => {
	applyReplicationOps(db, [op("historical")], local, scanner);
	ensureAdditiveSchemaCompatibility(db);
	ensureAdditiveSchemaCompatibility(db);
	expect(activity().receive.operations24h).toBeNull();
	expect(activity().receive.lastSuccessAt).toBeNull();
	expect(db.prepare("SELECT count(*) FROM replication_ops").pluck().get()).toBe(1);
});

it("records empty successful receive checks without clearing a send failure", () => {
	recordSyncTransferObservation(db, peer, "send", { errorCode: "exchange_failed" });
	push([]);
	expect(activity()).toMatchObject({
		receive: { operations24h: 0, lastSuccessAt: expect.any(String) },
		send: { errorCode: "exchange_failed", lastSuccessAt: null },
	});
});

it("records rejected inbound scopes without counting mutations", () => {
	const rejected = { ...op("rejected"), scope_id: "missing-scope" };
	const result = applyPeerReplicationOps({ db, scanner }, [rejected], local, {
		peerDeviceId: peer,
		inboundScopeValidation: { peerDeviceId: peer },
	});
	expect(result.rejected).toBe(1);
	expect(activity().receive).toMatchObject({
		operations24h: 0,
		errorCode: "scope_rejected",
		lastSuccessAt: null,
	});
});

it("retains previous successful exchange time when a later exchange fails", () => {
	const success = new Date("2026-11-01T12:00:00Z");
	recordSyncTransferObservation(db, peer, "receive", { now: success });
	recordSyncTransferObservation(db, peer, "receive", {
		errorCode: "exchange_failed",
		now: new Date("2026-11-02T12:00:00Z"),
	});
	expect(activity().receive).toMatchObject({
		lastSuccessAt: success.toISOString(),
		lastAttemptAt: "2026-11-02T12:00:00.000Z",
		errorCode: "exchange_failed",
	});
});

it.each(["scope_rejected", "apply_failed"] as const)(
	"preserves %s through generic failure until a successful observation clears it",
	(errorCode) => {
		// Arrange: the apply layer has already recorded the specific cause.
		const initial = new Date("2026-11-02T10:00:00Z");
		const failed = new Date("2026-11-02T11:00:00Z");
		const recovered = new Date("2026-11-02T12:00:00Z");
		recordSyncTransferObservation(db, peer, "receive", { errorCode, now: initial });

		// Act: the exchange layer adds a generic failure for the same direction.
		recordSyncTransferObservation(db, peer, "receive", {
			errorCode: "exchange_failed",
			now: failed,
		});
		const afterFailure = activity().receive;
		recordSyncTransferObservation(db, peer, "receive", { now: recovered });

		// Assert: generic failure cannot hide the cause, but actual success clears it.
		expect(afterFailure).toMatchObject({
			errorCode,
			lastAttemptAt: failed.toISOString(),
			lastSuccessAt: null,
		});
		expect(activity().receive).toMatchObject({
			errorCode: null,
			lastAttemptAt: recovered.toISOString(),
			lastSuccessAt: recovered.toISOString(),
		});
	},
);

it.each(["apply_failed", "scope_rejected", "exchange_failed"] as const)(
	"preserves %s while recording partial success until ordinary success resolves it",
	(errorCode) => {
		// Arrange: an earlier failure remains unresolved when only one window succeeds.
		recordSyncTransferObservation(db, peer, "receive", {
			errorCode,
			now: new Date("2026-11-02T10:00:00Z"),
		});

		// Act: partial success updates timestamps, and a later full success resolves the error.
		recordSyncTransferObservation(db, peer, "receive", {
			preserveError: true,
			now: new Date("2026-11-02T11:00:00Z"),
		});
		const partial = activity().receive;
		recordSyncTransferObservation(db, peer, "receive", {
			now: new Date("2026-11-02T12:00:00Z"),
		});

		// Assert: preservation affects the error, not evidence that the window succeeded.
		expect(partial).toMatchObject({
			errorCode,
			lastAttemptAt: "2026-11-02T11:00:00.000Z",
			lastSuccessAt: "2026-11-02T11:00:00.000Z",
		});
		expect(activity().receive).toMatchObject({
			errorCode: null,
			lastAttemptAt: "2026-11-02T12:00:00.000Z",
			lastSuccessAt: "2026-11-02T12:00:00.000Z",
		});
	},
);

it.each(["apply_failed", "scope_rejected"] as const)(
	"keeps %s priority over generic failure with preservation enabled",
	(errorCode) => {
		// Arrange: preservation must also work when no previous observation exists.
		recordSyncTransferObservation(db, peer, "receive", {
			preserveError: true,
			now: new Date("2026-11-02T09:00:00Z"),
		});
		const initial = activity().receive;
		recordSyncTransferObservation(db, peer, "receive", {
			errorCode,
			now: new Date("2026-11-02T10:00:00Z"),
		});

		// Act: preservation cannot replace a specific error with a generic exchange failure.
		recordSyncTransferObservation(db, peer, "receive", {
			errorCode: "exchange_failed",
			preserveError: true,
			now: new Date("2026-11-02T11:00:00Z"),
		});

		// Assert: a first success stays healthy, while later errors keep their existing priority.
		expect(initial).toMatchObject({
			errorCode: null,
			lastSuccessAt: "2026-11-02T09:00:00.000Z",
		});
		expect(activity().receive).toMatchObject({
			errorCode,
			lastAttemptAt: "2026-11-02T11:00:00.000Z",
			lastSuccessAt: "2026-11-02T09:00:00.000Z",
		});
	},
);

it("counts by local observation time and excludes expired and future receipts", () => {
	const now = new Date("2026-11-02T12:00:00Z");
	recordSyncTransferObservation(db, peer, "send", { now });
	recordSyncTransferReceipts(db, peer, "send", ["old"], { now: new Date("2026-10-01T00:00:00Z") });
	recordSyncTransferReceipts(db, peer, "send", ["future"], {
		now: new Date("2026-12-01T00:00:00Z"),
	});
	recordSyncTransferReceipts(db, peer, "send", ["recent", "recent"], { now });
	expect(
		readPeerSyncActivity(db, [peer], { now: now.toISOString() }).get(peer)?.send.operations24h,
	).toBe(1);
});

it("reads more peers than a single parameter batch and includes unknown peers", () => {
	const ids = Array.from({ length: 805 }, (_, index) => `peer-${index}`);
	recordSyncTransferObservation(db, "peer-804", "receive");
	const result = readPeerSyncActivity(db, ids);
	expect(result.size).toBe(805);
	expect(result.get("peer-804")?.receive.operations24h).toBe(0);
	expect(result.get("peer-0")?.receive.operations24h).toBeNull();
});

describe("snapshot activity", () => {
	const reset: SyncResetRequired = {
		reset_required: true,
		reason: "generation_mismatch",
		generation: 2,
		snapshot_id: "fixture-snapshot",
		baseline_cursor: null,
		retained_floor_cursor: null,
		scope_id: "fixture-scope",
	};
	it("keeps snapshot revisions separate from incremental operations and deduplicates retries", () => {
		const incoming = op("snapshot");
		const items = [
			{
				...incoming,
				payload_json: JSON.stringify({ title: "Snapshot", scope_id: "fixture-scope" }),
			},
		];
		applyBootstrapSnapshot(db, peer, items, reset, scanner);
		expect(activity().receive).toMatchObject({ operations24h: 0, snapshotItems24h: 1 });
		reopen();
		applyBootstrapSnapshot(db, peer, items, reset, scanner);
		mergeBootstrapSnapshot(db, peer, items, reset, scanner);
		expect(activity().receive).toMatchObject({ operations24h: 0, snapshotItems24h: 1 });
	});
	it("records an empty successful snapshot check", () => {
		applyBootstrapSnapshot(db, peer, [], reset, scanner);
		expect(activity().receive).toMatchObject({
			operations24h: 0,
			snapshotItems24h: 0,
			lastSuccessAt: expect.any(String),
		});
	});
});
