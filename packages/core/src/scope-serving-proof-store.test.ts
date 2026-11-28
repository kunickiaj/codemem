import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
	prepareScopeServingStore,
	storeScopeServingEnvelope,
} from "./scope-serving-proof-store.js";

const prep = {
	coordinatorId: "fixture-coordinator",
	groupId: "fixture-group",
	generation: "ff17dd9b-53e5-4e75-bf66-38b62e4f4ca4",
};
const envelope = {
	...prep,
	scopeId: "s",
	deviceId: "d",
	keyId: "ab".repeat(32),
	envelope: Buffer.from("fixture"),
};
let db: InstanceType<typeof Database>;
beforeEach(() => {
	db = new Database(":memory:");
});
afterEach(() => db.close());

it("only purges legacy evidence belonging to the prepared group and coordinator", () => {
	db.exec(
		`CREATE TABLE scope_membership_authorization_evidence(coordinator_id TEXT,group_id TEXT)`,
	);
	const insert = db.prepare("INSERT INTO scope_membership_authorization_evidence VALUES (?,?)");
	insert.run(prep.coordinatorId, prep.groupId);
	insert.run(prep.coordinatorId, "other-group");
	insert.run("other-coordinator", prep.groupId);
	prepareScopeServingStore(db, prep);
	storeScopeServingEnvelope(db, envelope);
	prepareScopeServingStore(db, prep);
	expect(
		db
			.prepare("SELECT * FROM scope_membership_authorization_evidence ORDER BY coordinator_id")
			.all(),
	).toEqual([
		{ coordinator_id: prep.coordinatorId, group_id: "other-group" },
		{ coordinator_id: "other-coordinator", group_id: prep.groupId },
	]);
	expect(db.prepare("SELECT envelope FROM scope_serving_proofs_v2").pluck().all()).toEqual([
		envelope.envelope,
	]);
});

it("refuses a conflicting preparation or proof without replacing the stored envelope", () => {
	prepareScopeServingStore(db, prep);
	storeScopeServingEnvelope(db, envelope);
	const generation = "67a23165-7e7a-4f3e-9a72-dd2a39a500b1";
	expect(() => prepareScopeServingStore(db, { ...prep, generation })).toThrow("Conflicting");
	expect(() => storeScopeServingEnvelope(db, { ...envelope, generation })).toThrow("Missing");
	expect(db.prepare("SELECT generation FROM scope_serving_proofs_v2").pluck().all()).toEqual([
		prep.generation,
	]);
});
