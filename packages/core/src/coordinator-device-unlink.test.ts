import { afterEach, expect, it, vi } from "vitest";
import {
	capabilitiesPath,
	cleanupAccountChangeHttpFixtures,
	fixture,
	headers,
	keypair,
	NOW,
	ORIGIN,
} from "./coordinator-account-change-http-test-fixtures.js";

afterEach(cleanupAccountChangeHttpFixtures);
const route = "/v1/auth/account-unlinks";
async function prepared(authority: "device_claim" | "controller_attestation" = "device_claim") {
	const f = await fixture(authority);
	const capability = await (await f.send("GET", capabilitiesPath)).json();
	return {
		...f,
		body: {
			group_id: "group-a",
			identity_id: "identity-a",
			attempt_id: "unlink-a",
			target_link_id: capability.unlink_target,
		},
	};
}
it.each(["device_claim", "controller_attestation"] as const)(
	"%s unlinks through real Ed25519 admission without a browser attempt and retains an exact retry receipt",
	async (authority) => {
		const f = await prepared(authority);
		const claims = f.db.prepare("SELECT * FROM coordinator_auth_device_claims").all();
		const enrollments = f.db.prepare("SELECT * FROM enrolled_devices").all();
		const response = await f.send("POST", route, f.body);
		expect(response.status).toBe(200);
		const receipt = await response.json();
		expect(receipt).toMatchObject({
			state: "completed",
			attemptId: "unlink-a",
			targetLinkId: f.body.target_link_id,
		});
		expect(f.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([]);
		expect(f.db.prepare("SELECT * FROM coordinator_account_change_attempts").all()).toEqual([]);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_device_claims").all()).toEqual(claims);
		expect(f.db.prepare("SELECT * FROM enrolled_devices").all()).toEqual(enrollments);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_account_profiles").all()).toEqual([]);
		expect(f.db.prepare("SELECT * FROM coordinator_auth_link_profiles").all()).toEqual([]);
		expect(
			f.db
				.prepare("SELECT count(*) AS n FROM coordinator_auth_sessions WHERE revoked_at_ms IS NULL")
				.get(),
		).toEqual({ n: 0 });
		const beforeRetry = f.snapshot();
		expect(await (await f.send("POST", route, f.body)).json()).toEqual(receipt);
		expect(f.snapshot()).toEqual(beforeRetry);
		expect(
			(await f.send("POST", route, { ...f.body, target_link_id: "another-link" })).status,
		).toBe(403);
	},
);
it("rejects a stale target and a different enrolled key without effects", async () => {
	const f = await prepared();
	const before = f.snapshot();
	expect((await f.send("POST", route, { ...f.body, target_link_id: "stale-link" })).status).toBe(
		403,
	);
	expect(f.snapshot()).toEqual(before);
	const other = keypair("reader");
	await f.store.enrollDevice("group-a", other);
	f.db.exec("UPDATE enrolled_devices SET identity_id='identity-a' WHERE device_id='reader'");
	const enrolled = f.snapshot();
	expect((await f.send("POST", route, f.body, other)).status).toBe(403);
	expect(f.snapshot()).toEqual(enrolled);
});

it.each(["missing signature", "missing nonce", "body tamper", "replay"])(
	"rejects %s before unlink storage or authenticated rate admission",
	async (mode) => {
		const f = await prepared();
		const body = JSON.stringify(f.body);
		const signed = headers(f.key, "POST", route, body);
		if (mode === "missing signature")
			delete (signed as Record<string, string>)["X-Opencode-Signature"];
		if (mode === "missing nonce") delete (signed as Record<string, string>)["X-Opencode-Nonce"];
		const request = () =>
			f.app.request(`${ORIGIN}${route}`, {
				method: "POST",
				headers: signed,
				body: mode === "body tamper" ? body.replace("unlink-a", "unlink-b") : body,
			});
		if (mode === "replay") expect((await request()).status).toBe(200);
		const before = f.snapshot();
		const unlink = vi.spyOn(f.operations, "unlink");
		const response = await request();
		expect([400, 401, 403, 409]).toContain(response.status);
		expect(unlink).not.toHaveBeenCalled();
		expect(f.snapshot()).toEqual(before);
	},
);
it.each([
	"disabled device",
	"reassigned identity",
	"archived group",
	"admin revoked",
	"wrong identity",
	"extra authority",
])("rechecks %s without unlinking", async (mode) => {
	const f = await prepared();
	if (mode === "disabled device") f.db.exec("UPDATE enrolled_devices SET enabled=0");
	if (mode === "reassigned identity")
		f.db.exec("UPDATE enrolled_devices SET identity_id='other-identity'");
	if (mode === "archived group") f.db.exec("UPDATE groups SET archived_at='now'");
	if (mode === "admin revoked")
		f.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms=?").run(NOW);
	const body = {
		...f.body,
		...(mode === "wrong identity" ? { identity_id: "other-identity" } : {}),
		...(mode === "extra authority" ? { confirmed: true, subject: "account-A" } : {}),
	};
	const before = f.snapshot();
	expect((await f.send("POST", route, body)).ok).toBe(false);
	expect(f.snapshot()).toEqual(before);
});
it.each(["archive", "delete current", "delete profile", "complete receipt"])(
	"rolls back an ignored %s write and permits an exact retry",
	async (stage) => {
		const f = await prepared();
		const before = f.snapshot();
		const batch = f.backend.batch.bind(f.backend);
		const inject = vi.spyOn(f.backend, "batch").mockImplementationOnce((statements) =>
			batch(
				statements.map((statement) => {
					const query = statement.sql;
					const prefixes: Record<string, string> = {
						archive: "INSERT INTO coordinator_auth_account_connection_history",
						"delete current": "DELETE FROM coordinator_auth_account_links",
						"delete profile": "DELETE FROM coordinator_auth_link_profiles",
						"complete receipt":
							"UPDATE coordinator_auth_account_connection_unlinks SET state='completed'",
					};
					const matches = query.startsWith(prefixes[stage] ?? "missing stage");
					return matches ? { sql: "SELECT 1", values: [] } : statement;
				}),
			),
		);
		expect((await f.send("POST", route, f.body)).status).toBe(403);
		expect(inject).toHaveBeenCalled();
		expect(f.snapshot()).toEqual(before);
		expect((await f.send("POST", route, f.body)).status).toBe(200);
	},
);
it("rechecks device authority inside the winning batch rather than trusting a prior capability", async () => {
	const f = await prepared();
	const batch = f.backend.batch.bind(f.backend);
	vi.spyOn(f.backend, "batch").mockImplementationOnce(async (statements) => {
		f.db.exec("UPDATE enrolled_devices SET enabled=0");
		return batch(statements);
	});
	expect((await f.send("POST", route, f.body)).status).toBe(403);
	expect(f.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toHaveLength(1);
	expect(f.db.prepare("SELECT * FROM coordinator_auth_account_connection_unlinks").all()).toEqual(
		[],
	);
});
it("recovers the retained receipt when the atomic batch reply is lost after commit", async () => {
	const f = await prepared();
	const batch = f.backend.batch.bind(f.backend);
	vi.spyOn(f.backend, "batch").mockImplementationOnce(async (statements) => {
		await batch(statements);
		throw new Error("private postcommit failure");
	});
	const response = await f.send("POST", route, f.body);
	expect(response.status).toBe(200);
	const receipt = await response.json();
	const committed = f.snapshot();
	expect(await (await f.send("POST", route, f.body)).json()).toEqual(receipt);
	expect(f.snapshot()).toEqual(committed);
});
it("competing unlink and refresh can end only the pinned connection once", async () => {
	const f = await prepared();
	await f.prepare("refresh");
	const result = await Promise.all([
		f.send("POST", route, f.body),
		f.send("POST", route, { ...f.body, attempt_id: "competing" }),
		f.send("POST", "/v1/auth/account-changes/change-a/finalize", f.finalBody()),
	]);
	expect(result.slice(0, 2).filter((r) => r.ok)).toHaveLength(1);
	expect(
		f.db.prepare("SELECT * FROM coordinator_auth_account_connection_history").all(),
	).toHaveLength(1);
	expect(f.db.prepare("SELECT * FROM coordinator_auth_link_profiles").all()).toEqual([]);
	expect(f.db.prepare("SELECT * FROM coordinator_auth_account_links").all()).toEqual([]);
});
it.each([
	"replace attempt",
	"replace target",
	"replace rowid",
	"negative rowid",
	"edit rowid",
	"edit hash",
	"delete",
])("retains receipt against %s", async (mode) => {
	const f = await prepared();
	expect((await f.send("POST", route, f.body)).status).toBe(200);
	const table = "coordinator_auth_account_connection_unlinks";
	const receipt = f.db.prepare(`SELECT rowid,* FROM ${table}`).get() as Record<string, unknown>;
	const columns = Object.keys(receipt);
	const copy = { ...receipt, state: "committing", completed_at_ms: null };
	if (mode === "replace target") copy.attempt_id = "new-operation";
	if (mode === "replace rowid" || mode === "negative rowid") {
		copy.attempt_id = "new-operation";
		copy.target_link_id = "other-target";
	}
	if (mode === "negative rowid") copy.rowid = -1;
	const mutation = () => {
		if (mode === "delete") return f.db.exec(`DELETE FROM ${table}`);
		if (mode === "edit rowid") return f.db.exec(`UPDATE ${table} SET rowid=rowid+1`);
		if (mode === "edit hash")
			return f.db.exec(`UPDATE ${table} SET request_hash='${"f".repeat(64)}'`);
		return f.db
			.prepare(
				`INSERT OR REPLACE INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
			)
			.run(...columns.map((key) => copy[key]));
	};
	expect(mutation).toThrow();
	expect(f.db.prepare(`SELECT rowid,* FROM ${table}`).get()).toEqual(receipt);
});
