import { expect, vi } from "vitest";
import type { D1DatabaseLike } from "../../core/src/internal/cloudflare-coordinator.js";
import { createCloudflareCoordinatorWorker, createConfiguredCloudflareCoordinatorWorker } from "../src/index.js";
import { config, NOW } from "./device-claim-eligibility-fixture.js";
import { type Fixture, type Test, table } from "./owner-enrollment-qualification-ops-test-harness.js";

const origin = "https://coordinator.example.test";
const path = "/v1/admin/owner-qualifications";
const secret = "fixture-admin-credential";
const review = `controller-v1:${"c".repeat(64)}`;
const body = { attestation_id: review };
const settings = { ...config, issuer: "https://accounts.google.com", clientId: "fixture-client", redirectUri: `${origin}/auth/callback`, ownerEnrollmentEnabled: true };

// Run the real Worker and D1 adapter against the existing proof-validating fixture.
function binding(f: Fixture): D1DatabaseLike {
	return {
		prepare(sql) {
			let values: (string | number | null)[] = [];
			return {
				bind(...next: unknown[]) { values = next as typeof values; return this; },
				first: <T>() => f.backend.first<T>({ sql, values }),
				all: async <T>() => ({ results: await f.query(sql) as T[] }),
				raw: async <T>() => (await f.query(sql)).map(Object.values) as T[],
				run: async () => ({ meta: { changes: await f.backend.run({ sql, values }) } }),
			};
		},
		batch: (statements) => Promise.all(statements.map((s) => s.run())),
	};
}
function runtime(f: Fixture) {
	const env = {
		COORDINATOR_DB: binding(f),
		CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET: secret,
		CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: JSON.stringify(settings),
		CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET: "fixture-client-secret",
		CODEMEM_COORDINATOR_BROWSER_CSRF_KEY: "ab".repeat(32),
	};
	const worker = createConfiguredCloudflareCoordinatorWorker();
	return { env, worker, send: (data: unknown = body, init: RequestInit = {}, suffix = "") => worker.fetch(request(data, init, suffix), env) };
}
function request(data: unknown = body, init: RequestInit = {}, suffix = "") {
	return new Request(`${origin}${path}${suffix}`, {
		method: "POST", body: typeof data === "string" ? data : JSON.stringify(data), ...init,
		headers: { "content-type": "application/json", "X-Codemem-Coordinator-Admin": secret, ...init.headers },
	});
}
async function preview(r: ReturnType<typeof runtime>) {
	const response = await r.send();
	expect(response.status).toBe(200);
	return await response.json() as { evidence_digest: string };
}

export function registerOwnerQualificationRuntimeTests(test: Test) {
	test.beforeEach(async ({ fixture: f }) => {
		vi.spyOn(Date, "now").mockReturnValue(NOW + 100);
		// The historical fixture uses a generic issuer; configured runtime accepts Google only.
		const tables = await f.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' AND name<>'d1_migrations'");
		for (const row of tables) {
			const name = String(row.name);
			if ((await f.query(`PRAGMA table_info(${name})`)).some((c) => c.name === "issuer"))
				await f.corrupt(name, "issuer='https://accounts.google.com'");
		}
		await f.corrupt("coordinator_auth_controller_attestations", `attestation_id='${review}'`);
	});
	test.afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
	registerTransportTests(test);
	test("previews read-only, issues explicitly, and retries the same immutable dual-reference qualification", async ({ fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const before = await f.snapshot();
		const attempts = await f.rows("coordinator_owner_enrollment_attempts");
		// Act
		const p = await preview(r);
		const afterPreview = await f.snapshot();
		const created = await r.send({ ...body, confirm_evidence_digest: p.evidence_digest });
		const receipt = await created.json() as Record<string, unknown>;
		const retry = await r.send({ ...body, confirm_evidence_digest: p.evidence_digest });
		// Assert: no grant, enrollment, controller creation, or historical proof rewrite.
		expect(afterPreview).toEqual(before);
		expect(created.status).toBe(201);
		expect(receipt).toEqual({ state: "created", qualification_id: expect.any(String), attestation_id: review, coordinator_id: config.coordinatorId, evidence_digest: p.evidence_digest });
		expect(retry.status).toBe(200);
		expect(await retry.json()).toEqual({ ...receipt, state: "existing" });
		expect(await f.rows()).toEqual([expect.objectContaining({ qualification_id: receipt.qualification_id, link_id: "claim-a", device_claim_id: "claim-a", controller_attestation_id: review })]);
		expect(await f.snapshot()).toEqual(before);
		expect(await f.rows("coordinator_owner_enrollment_attempts")).toEqual(attempts);
		expect(created.headers.get("cache-control")).toBe("no-store");
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	test.for(["flag", "absent-flag", "missing-config", "disabled", "invalid", "client", "csrf", "database"])("authenticates before unavailable %s context and never falls back", async (fault, { fixture: f }) => {
		// Arrange
		const r = runtime(f);
		if (fault === "flag") r.env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({ ...settings, ownerEnrollmentEnabled: false });
		if (fault === "absent-flag") { const { ownerEnrollmentEnabled: _, ...withoutFlag } = settings; r.env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify(withoutFlag); }
		if (fault === "missing-config") Object.assign(r.env, { CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG: undefined });
		if (fault === "disabled") r.env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({ enabled: false });
		if (fault === "invalid") r.env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = "{";
		if (fault === "client") r.env.CODEMEM_COORDINATOR_OIDC_CLIENT_SECRET = "";
		if (fault === "csrf") r.env.CODEMEM_COORDINATOR_BROWSER_CSRF_KEY = "";
		if (fault === "database") Object.assign(r.env, { COORDINATOR_DB: undefined });
		f.calls.length = 0;
		// Act
		const denied = await r.send("{", { headers: { "X-Codemem-Coordinator-Admin": "wrong" } });
		const unavailable = await r.send();
		// Assert
		expect(denied.status).toBe(401);
		expect(unavailable.status).toBe(503);
		expect(f.calls).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	test.for(["coordinatorId", "issuer"])("requires exact persisted %s namespace", async (field, { fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const changed = { ...settings, [field]: "foreign" };
		r.env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify(changed);
		// Act
		const response = await r.send();
		// Assert: an invalid issuer fails config validation, other valid foreign pins deny evidence.
		expect(response.status).toBe(field === "issuer" ? 503 : 409);
		expect(await f.rows()).toEqual([]);
	});
	test("requires a new digest after verifier rotation without rewriting historical birth revisions", async ({ fixture: f }) => {
		// Arrange: a new Worker may verify an existing live link under a new config revision.
		const a = runtime(f);
		const oldPreview = await preview(a);
		const before = await f.snapshot();
		const b = runtime(f);
		b.env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({ ...settings, revision: "b".repeat(64), clientId: "rotated-client" });
		// Act
		const newPreview = await preview(b);
		const stale = await b.send({ ...body, confirm_evidence_digest: oldPreview.evidence_digest });
		const afterStale = await f.rows();
		const issued = await b.send({ ...body, confirm_evidence_digest: newPreview.evidence_digest });
		// Assert: current verifier settings and retained source facts both bind the digest.
		expect(newPreview.evidence_digest).not.toBe(oldPreview.evidence_digest);
		expect(stale.status).toBe(409);
		expect(await stale.json()).toEqual({ error: "preview_changed" });
		expect(afterStale).toEqual([]);
		expect(issued.status).toBe(201);
		expect(await issued.json()).toMatchObject({ state: "created", evidence_digest: newPreview.evidence_digest });
		expect(await f.rows()).toHaveLength(1);
		expect(await f.snapshot()).toEqual(before);
		for (const name of ["coordinator_auth_account_links", "coordinator_auth_device_claims"])
			expect(await f.rows(name)).toEqual([expect.objectContaining({ auth_config_revision: settings.revision })]);
	});
	test.for(["config", "secret", "database", "csrf"])("pins %s across requests and captures settings before authentication awaits", async (field, { fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const original = { ...r.env };
		const replacementPrepare = vi.fn(() => { throw new Error("replacement database must not be touched"); });
		const pending = r.send();
		if (field === "config") r.env.CODEMEM_COORDINATOR_BROWSER_AUTH_CONFIG = JSON.stringify({ ...settings, revision: "b".repeat(64) });
		if (field === "secret") r.env.CODEMEM_SYNC_COORDINATOR_ADMIN_SECRET = "replacement";
		if (field === "database") r.env.COORDINATOR_DB = { prepare: replacementPrepare, batch: vi.fn() };
		if (field === "csrf") r.env.CODEMEM_COORDINATOR_BROWSER_CSRF_KEY = "cd".repeat(32);
		f.calls.length = 0;
		// Act
		const captured = await pending;
		const reads = f.calls.length;
		const drifted = await r.send();
		// Assert
		expect(captured.status).toBe(200);
		expect(drifted.status).toBe(field === "secret" ? 401 : 503);
		expect(f.calls.length).toBe(reads);
		expect(replacementPrepare).not.toHaveBeenCalled();
		Object.assign(r.env, original);
		expect((await r.send()).status).toBe(200);
	});
	test.for(["missing-0035", "trigger-0035", "trigger-0036", "connection", "revoked", "wrong-review"])("distinguishes storage failure from evidence denial: %s", async (fault, { fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const p = await preview(r);
		if (fault === "missing-0035") await f.exec(`DROP TABLE ${table}`);
		if (fault === "trigger-0035") await f.exec("DROP TRIGGER owner_enrollment_qualification_insert_active");
		if (fault === "trigger-0036") await f.exec("DROP TRIGGER owner_enrollment_authority_insert");
		if (fault === "connection") await f.exec("DROP TABLE coordinator_auth_account_connection_history");
		if (fault === "revoked") await f.exec(`UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked' WHERE attestation_id='${review}'`);
		const input = fault === "wrong-review" ? { attestation_id: `controller-v1:${"d".repeat(64)}` } : body;
		const schema = await f.query("SELECT name,sql FROM sqlite_master ORDER BY name");
		// Act
		const responses = [await r.send(input), await r.send({ ...input, confirm_evidence_digest: p.evidence_digest })];
		// Assert
		for (const response of responses) expect(response.status).toBe(["revoked", "wrong-review"].includes(fault) ? 409 : 503);
		expect(await f.query("SELECT name,sql FROM sqlite_master ORDER BY name")).toEqual(schema);
	});
	test.for(["revoked", "lost-response"])("contains winning INSERT %s without retrying authority writes", async (fault, { fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const p = await preview(r);
		if (fault === "revoked") f.onInsert(() => f.exec(`UPDATE coordinator_auth_controller_attestations SET revoked_at='revoked' WHERE attestation_id='${review}'`));
		else {
			const run = f.backend.run;
			vi.spyOn(f.backend, "run").mockImplementation(async (s) => {
				const result = await run(s);
				if (s.sql.startsWith(`INSERT INTO ${table}`)) throw new Error("private-write-response");
				return result;
			});
		}
		// Act
		const response = await r.send({ ...body, confirm_evidence_digest: p.evidence_digest });
		// Assert
		expect(response.status).toBe(fault === "revoked" ? 409 : 503);
		expect(await response.json()).toEqual({ error: fault === "revoked" ? "qualification_conflict" : "qualification_outcome_unknown" });
		expect(await f.rows()).toHaveLength(fault === "revoked" ? 0 : 1);
	});
}

function registerTransportTests(test: Test) {
	test("keeps explicit legacy qualification unavailable without dispatching storage or providers", async ({ fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const worker = createCloudflareCoordinatorWorker();
		f.calls.length = 0;
		// Act
		const response = await worker.fetch(request(), r.env);
		// Assert
		expect(response.status).toBe(503);
		expect(f.calls).toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
	test.for([
		["method", 405], ["media", 415], ["encoding", 415], ["query", 400],
		["origin", 400], ["framing", 400], ["length", 400], ["declared", 413],
	] as const)("refuses %s before reading body or D1", async ([fault, status], { fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const headers: Record<string, string> = {};
		if (fault === "media") headers["content-type"] = "text/plain";
		if (fault === "encoding") headers["content-encoding"] = "gzip";
		if (fault === "origin") headers.origin = origin;
		if (fault === "framing") headers["transfer-encoding"] = "chunked";
		if (fault === "length") headers["content-length"] = "-1";
		if (fault === "declared") headers["content-length"] = "4097";
		const req = request(body, { method: fault === "method" ? "PUT" : "POST", headers }, fault === "query" ? "?ignored=1" : "");
		const read = vi.spyOn(req.body!, "getReader");
		f.calls.length = 0;
		// Act
		const response = await r.worker.fetch(req, r.env);
		// Assert
		expect(response.status).toBe(status);
		expect(read).not.toHaveBeenCalled();
		expect(f.calls).toEqual([]);
	});
	test.for([4096, 4097])("enforces streamed UTF-8 byte cap at %s bytes", async (size, { fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const json = JSON.stringify(body);
		const bytes = new TextEncoder().encode(json + " ".repeat(size - json.length));
		const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes.subarray(0, 100)); c.enqueue(bytes.subarray(100)); c.close(); } });
		const req = request(body, { body: stream, duplex: "half" } as RequestInit);
		// Act
		const response = await r.worker.fetch(req, r.env);
		// Assert
		expect(response.status).toBe(size === 4096 ? 200 : 413);
		expect(await f.rows()).toEqual([]);
	});
	test.for(["invalid-json", "invalid-utf8", "short", "long", "aborted"])("rejects body %s before lookup", async (fault, { fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const controller = new AbortController();
		if (fault === "aborted") controller.abort();
		const bytes = fault === "invalid-utf8" ? new Uint8Array([0xff]) : new TextEncoder().encode(fault === "invalid-json" ? "{" : JSON.stringify(body));
		const headers: Record<string, string> = fault === "short" || fault === "long" ? { "content-length": String(bytes.length + (fault === "short" ? 1 : -1)) } : {};
		f.calls.length = 0;
		// Act
		const response = await r.worker.fetch(request(body, { body: bytes, headers, signal: controller.signal }), r.env);
		// Assert
		expect([400, 413]).toContain(response.status);
		expect(f.calls).toEqual([]);
	});
	test.for([false, true])("spends the independent authenticated=%s budget before body/store access", async (authenticated, { fixture: f }) => {
		// Arrange
		const r = runtime(f);
		const headers = { "X-Codemem-Coordinator-Admin": authenticated ? secret : "wrong" };
		const limit = authenticated ? 20 : 60;
		for (let n = 0; n < limit; n++) expect((await r.send("{", { headers })).status).toBe(authenticated ? 400 : 401);
		const req = request(body, { headers });
		const read = vi.spyOn(req.body!, "getReader");
		f.calls.length = 0;
		// Act
		const response = await r.worker.fetch(req, r.env);
		const independent = await r.send("{", { headers: { "X-Codemem-Coordinator-Admin": authenticated ? "wrong" : secret } });
		// Assert
		expect(response.status).toBe(429);
		expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(independent.status).toBe(authenticated ? 401 : 400);
		expect(read).not.toHaveBeenCalled();
		expect(f.calls).toEqual([]);
	});
	test.for(["abort", "deadline"])("refuses a stalled stream on %s without awaiting cancellation", async (fault, { fixture: f }) => {
		// Arrange: the read barrier, not elapsed wall time, schedules interruption.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const timeout = vi.spyOn(globalThis, "setTimeout");
		const r = runtime(f);
		const controller = new AbortController();
		const started = Promise.withResolvers<void>();
		const cancel = vi.fn(() => new Promise<void>(() => {}));
		const stream = new ReadableStream<Uint8Array>({ pull() { started.resolve(); return new Promise<void>(() => {}); }, cancel }, { highWaterMark: 0 });
		f.calls.length = 0;
		// Act
		let settled = false;
		const pending = r.worker.fetch(request(body, { body: stream, signal: controller.signal, duplex: "half" } as RequestInit), r.env).then((response) => { settled = true; return response; });
		await started.promise;
		if (fault === "abort") controller.abort();
		else {
			await vi.advanceTimersByTimeAsync(4999);
			expect(settled).toBe(false);
			await vi.advanceTimersByTimeAsync(1);
		}
		const response = await pending;
		// Assert
		expect(response.status).toBe(413);
		expect(cancel).toHaveBeenCalledOnce();
		expect(f.calls).toEqual([]);
		expect(timeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 5000);
	});
}
