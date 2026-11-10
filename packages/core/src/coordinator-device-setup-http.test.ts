import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceKey, signedHeaders } from "./coordinator-device-headless-link-test-fixtures.js";
import {
	LEGACY_SETUP,
	type LinkedLegacySetupFixture,
	legacySetupEvidenceSnapshot,
	legacySetupPreservationSnapshot,
	linkedLegacySetupFixture,
} from "./linked-legacy-setup-test-fixtures.js";

const PATH = "/v1/auth/device-binding";
const QUERY = `${PATH}?group_id=${LEGACY_SETUP.groupId}&identity_id=${encodeURIComponent(LEGACY_SETUP.identityId)}`;
const BODY = { group_id: LEGACY_SETUP.groupId, identity_id: LEGACY_SETUP.identityId };
const ORIGIN = "https://coordinator.example.test";

function bindingEffects(f: LinkedLegacySetupFixture) {
	return [
		"enrolled_devices",
		"coordinator_device_ownership_bindings",
		"coordinator_device_rebind_audit_log",
		"coordinator_identity_group_grants",
		"coordinator_auth_account_links",
		"coordinator_auth_device_claims",
	].map((table) => ({
		table,
		rows: f.coordinator.db.prepare(`SELECT * FROM ${table} ORDER BY 1, 2`).all(),
	}));
}

function registerCompletionTests(fixture: () => LinkedLegacySetupFixture) {
	it("reads ready without changing setup, claims, grants, history or local peer trust", async () => {
		// Arrange: other owned devices and existing grants intentionally remain present.
		const f = fixture();
		const before = bindingEffects(f);
		// Act
		const response = await f.signed(f.keyA, "GET", QUERY);
		// Assert: nonce admission may write only its replay ledger.
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({ kind: "ready" });
		expect(bindingEffects(f)).toEqual(before);
		expect(legacySetupEvidenceSnapshot(f.coordinator, f.local)).toEqual(f.evidenceBefore);
		expect(legacySetupPreservationSnapshot(f.local)).toEqual(f.before);
	});

	it("completes the historical own claim once and recovers the exact receipt by GET and POST", async () => {
		// Arrange
		const f = fixture();
		const otherBinding = f.coordinator.db
			.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id = ?")
			.get(f.keyB.deviceId);
		const grants = f.coordinator.db
			.prepare("SELECT * FROM coordinator_identity_group_grants")
			.all();
		// Act
		const first = await f.signed(f.keyA, "POST", PATH, BODY);
		const result = (await first.json()) as { kind: string; receipt: unknown };
		const after = bindingEffects(f);
		const read = await f.signed(f.keyA, "GET", QUERY);
		const replay = await f.signed(f.keyA, "POST", PATH, BODY);
		// Assert: receipt recovery does not repeat the mutation or change another device/grant.
		expect(first.status).toBe(200);
		expect(result).toMatchObject({
			kind: "completed",
			receipt: {
				coordinator_id: LEGACY_SETUP.coordinatorId,
				device_id: f.keyA.deviceId,
				identity_id: LEGACY_SETUP.identityId,
				enrollment_count: 1,
			},
		});
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({ kind: "complete", receipt: result.receipt });
		expect(replay.status).toBe(200);
		expect(await replay.json()).toEqual({ kind: "complete", receipt: result.receipt });
		expect(bindingEffects(f)).toEqual(after);
		expect(
			f.coordinator.db
				.prepare("SELECT * FROM coordinator_device_ownership_bindings WHERE device_id = ?")
				.get(f.keyB.deviceId),
		).toEqual(otherBinding);
		expect(
			f.coordinator.db.prepare("SELECT * FROM coordinator_identity_group_grants").all(),
		).toEqual(grants);
		expect(legacySetupPreservationSnapshot(f.local)).toEqual(f.before);
	});
}

function registerAdmissionTests(fixture: () => LinkedLegacySetupFixture) {
	it.each(["unsigned", "wrong key", "tampered nonce", "missing nonce", "stale timestamp"] as const)(
		"rejects %s before binding writes",
		async (mode) => {
			// Arrange
			const f = fixture();
			const before = bindingEffects(f);
			const body = JSON.stringify(BODY);
			const key = mode === "wrong key" ? deviceKey(f.keyA.deviceId) : f.keyA;
			const headers: Record<string, string> =
				mode === "unsigned"
					? { "content-type": "application/json" }
					: signedHeaders(key, "POST", PATH, body);
			if (mode === "tampered nonce") headers["X-Opencode-Nonce"] = "changed-after-signing";
			if (mode === "missing nonce") delete headers["X-Opencode-Nonce"];
			if (mode === "stale timestamp") headers["X-Opencode-Timestamp"] = "1";
			// Act
			const response = await f.app.request(`${ORIGIN}${PATH}`, { method: "POST", headers, body });
			// Assert
			expect(response.status).toBe(401);
			expect(bindingEffects(f)).toEqual(before);
		},
	);

	it("rejects a replayed signed nonce while a fresh signed GET still reads readiness", async () => {
		// Arrange
		const f = fixture();
		const headers = signedHeaders(f.keyA, "GET", QUERY);
		const before = bindingEffects(f);
		// Act
		const first = await f.app.request(`${ORIGIN}${QUERY}`, { headers });
		const replay = await f.app.request(`${ORIGIN}${QUERY}`, { headers });
		const fresh = await f.signed(f.keyA, "GET", QUERY);
		// Assert
		expect(first.status).toBe(200);
		expect(replay.status).toBe(401);
		expect(fresh.status).toBe(200);
		expect(await fresh.json()).toEqual({ kind: "ready" });
		expect(bindingEffects(f)).toEqual(before);
	});
}

function registerInputTests(fixture: () => LinkedLegacySetupFixture) {
	it.each([
		{ label: "device from body", value: { ...BODY, device_id: "device-b" } },
		{ label: "signer from body", value: { ...BODY, signer: { deviceId: "device-b" } } },
		{ label: "coordinator injection", value: { ...BODY, coordinator_id: "injected-coordinator" } },
		{ label: "issuer injection", value: { ...BODY, issuer: "https://injected.example.test" } },
		{ label: "revision injection", value: { ...BODY, revision: "f".repeat(64) } },
		{ label: "missing Identity", value: { group_id: LEGACY_SETUP.groupId } },
		{ label: "array body", value: [BODY] },
		{ label: "null body", value: null },
	])("rejects $label rather than trusting client authority", async ({ value }) => {
		// Arrange
		const f = fixture();
		const before = bindingEffects(f);
		// Act
		const response = await f.signed(f.keyA, "POST", PATH, value);
		// Assert
		expect(response.status).toBe(400);
		expect(bindingEffects(f)).toEqual(before);
	});

	it("returns requires_review for an Identity that differs from the committed claim", async () => {
		// Arrange
		const f = fixture();
		const before = bindingEffects(f);
		// Act
		const response = await f.signed(f.keyA, "POST", PATH, {
			...BODY,
			identity_id: "another-identity",
		});
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ kind: "requires_review" });
		expect(bindingEffects(f)).toEqual(before);
	});

	it.each([
		`${PATH}?group_id=${LEGACY_SETUP.groupId}`,
		`${QUERY}&identity_id=another-identity`,
		`${QUERY}&coordinator_id=injected-coordinator`,
	])("rejects malformed or authority-injecting GET query %s", async (query) => {
		// Arrange
		const f = fixture();
		const before = bindingEffects(f);
		// Act
		const response = await f.signed(f.keyA, "GET", query);
		// Assert
		expect(response.status).toBe(400);
		expect(bindingEffects(f)).toEqual(before);
	});

	it("rejects a different group rather than borrowing the claim's enrolled group", async () => {
		// Arrange
		const f = fixture();
		await f.coordinator.store.createGroup("unrelated-group");
		const before = bindingEffects(f);
		// Act
		const response = await f.signed(f.keyA, "POST", PATH, { ...BODY, group_id: "unrelated-group" });
		// Assert
		expect(response.status).toBe(401);
		expect(bindingEffects(f)).toEqual(before);
	});
}

function registerHttpBoundaryTests(fixture: () => LinkedLegacySetupFixture) {
	it.each(["GET", "POST"])(
		"rejects a different origin for %s without setup writes",
		async (method) => {
			// Arrange: the signature remains valid for the path, but the origin is not configured.
			const f = fixture();
			const path = method === "GET" ? QUERY : PATH;
			const body = method === "GET" ? "" : JSON.stringify(BODY);
			const before = bindingEffects(f);
			// Act
			const response = await f.app.request(`https://different.example.test${path}`, {
				method,
				headers: signedHeaders(f.keyA, method, path, body),
				...(method === "GET" ? {} : { body }),
			});
			// Assert
			expect(response.status).toBe(403);
			expect(bindingEffects(f)).toEqual(before);
		},
	);

	it.each([
		{
			label: "POST query",
			path: `${PATH}?ignored=true`,
			type: "application/json",
			body: JSON.stringify(BODY),
			status: 400,
		},
		{
			label: "non-JSON content type",
			path: PATH,
			type: "text/plain",
			body: JSON.stringify(BODY),
			status: 400,
		},
		{
			label: "oversized body",
			path: PATH,
			type: "application/json",
			body: JSON.stringify({ ...BODY, extra: "x".repeat(4096) }),
			status: 413,
		},
	])("rejects $label before setup writes", async ({ path, type, body, status }) => {
		// Arrange
		const f = fixture();
		const before = bindingEffects(f);
		const headers = { ...signedHeaders(f.keyA, "POST", path, body), "content-type": type };
		// Act
		const response = await f.app.request(`${ORIGIN}${path}`, { method: "POST", headers, body });
		// Assert
		expect(response.status).toBe(status);
		expect(bindingEffects(f)).toEqual(before);
	});

	it("rejects a GET carrying a raw HTTP body without setup writes", async () => {
		// Arrange: HTTP permits GET bytes, but Fetch's constructor prohibits creating them directly.
		const f = fixture();
		const before = bindingEffects(f);
		const request = new Request(`${ORIGIN}${QUERY}`, {
			method: "POST",
			body: "{}",
			headers: signedHeaders(f.keyA, "GET", QUERY, "{}"),
		});
		Object.defineProperty(request, "method", { value: "GET" });
		// Act
		const response = await f.app.request(request);
		// Assert
		expect(response.status).toBe(400);
		expect(bindingEffects(f)).toEqual(before);
	});

	it("explicitly refuses HEAD rather than treating it as readiness", async () => {
		// Arrange
		const f = fixture();
		const before = bindingEffects(f);
		// Act
		const response = await f.app.request(`${ORIGIN}${QUERY}`, {
			method: "HEAD",
			headers: signedHeaders(f.keyA, "HEAD", QUERY),
		});
		// Assert
		expect(response.status).toBe(405);
		expect(response.headers.get("Allow")).toBe("GET, POST");
		expect(bindingEffects(f)).toEqual(before);
	});
}

function controllerReadSnapshot(f: LinkedLegacySetupFixture) {
	const tables = f.coordinator.db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'request_nonces' ORDER BY name",
		)
		.all() as { name: string }[];
	return tables.map(({ name }) => ({
		name,
		rows: f.coordinator.db.prepare(`SELECT * FROM "${name}" ORDER BY 1`).all(),
	}));
}

const controllerReadDefects = [
	[
		"missing own controller",
		"DELETE FROM coordinator_auth_controller_attestations WHERE device_id='device-a'",
	],
	[
		"wrong controller Identity",
		"UPDATE coordinator_auth_controller_attestations SET identity_id='another-identity' WHERE device_id='device-a'",
	],
	[
		"revoked controller",
		"UPDATE coordinator_auth_controller_attestations SET revoked_at='2026-01-01T00:00:00.000Z' WHERE device_id='device-a'",
	],
	["revoked account link", "UPDATE coordinator_auth_account_links SET revoked_at_ms=1"],
	[
		"malformed controller origin",
		"UPDATE coordinator_auth_link_attempts SET controller_review_receipt_id='unrelated-review'",
	],
	["missing browser genesis", "UPDATE coordinator_auth_link_attempts SET browser_start_hash=NULL"],
	[
		"missing creation audit",
		"DELETE FROM coordinator_auth_link_audit_log WHERE action='link_created'",
	],
] as const;

function registerConnectReadinessTests(backend: "SQLite" | "D1") {
	it("returns controlled 404 without writes when the pre-0044 backend is not ready", async () => {
		// Arrange: the maintained backend getter refuses ceremonies on the older schema.
		const controller = await linkedLegacySetupFixture(backend, {
			authConfigured: true,
			accountAuthority: "controller_attestation",
		});
		try {
			controller.coordinator.db.exec(
				"DROP TRIGGER coordinator_device_rebind_attempt_pins; ALTER TABLE coordinator_device_rebind_attempts DROP COLUMN start_authority_json",
			);
			const before = controllerReadSnapshot(controller);
			// Act
			const read = await controller.signed(controller.keyA, "GET", QUERY);
			const post = await controller.signed(controller.keyA, "POST", PATH, BODY);
			// Assert: clients negotiate this explicit unavailable-backend result as unsupported.
			expect(read.status).toBe(404);
			expect(await read.json()).toEqual({ error: "not_found" });
			expect(post.status).toBe(404);
			expect(await post.json()).toEqual({ error: "not_found" });
			expect(controllerReadSnapshot(controller)).toEqual(before);
		} finally {
			await controller.close();
		}
	});
	it("does not suggest connecting a different current Identity", async () => {
		// Arrange: the eligible controller's complete origin is valid only for its existing Identity.
		const controller = await linkedLegacySetupFixture(backend, {
			authConfigured: true,
			accountAuthority: "controller_attestation",
		});
		try {
			const before = controllerReadSnapshot(controller);
			// Act
			const read = await controller.signed(
				controller.keyA,
				"GET",
				`${PATH}?group_id=${LEGACY_SETUP.groupId}&identity_id=another-identity`,
			);
			// Assert
			expect(read.status).toBe(200);
			expect(await read.json()).toEqual({ kind: "requires_review" });
			expect(controllerReadSnapshot(controller)).toEqual(before);
		} finally {
			await controller.close();
		}
	});
	it.each(controllerReadDefects)(
		"keeps %s at requires_review without writes",
		async (_label, sql) => {
			// Arrange: mutate a full historical own-controller origin, never manufacture positive proof.
			const controller = await linkedLegacySetupFixture(backend, {
				authConfigured: true,
				accountAuthority: "controller_attestation",
			});
			try {
				controller.coordinator.db.exec(sql);
				const before = controllerReadSnapshot(controller);
				// Act
				const read = await controller.signed(controller.keyA, "GET", QUERY);
				const post = await controller.signed(controller.keyA, "POST", PATH, BODY);
				// Assert: neither hint nor claim completion grants controller ownership.
				expect(read.status).toBe(200);
				expect(await read.json()).toEqual({ kind: "requires_review" });
				expect(post.status).toBe(200);
				expect(await post.json()).toEqual({ kind: "requires_review" });
				expect(controllerReadSnapshot(controller)).toEqual(before);
			} finally {
				await controller.close();
			}
		},
	);

	it("requires review for profile metadata without a controller or active link", async () => {
		// Arrange: display metadata may survive independently of all ownership authority.
		const controller = await linkedLegacySetupFixture(backend, {
			authConfigured: true,
			accountAuthority: "controller_attestation",
		});
		try {
			controller.coordinator.db.exec(`INSERT INTO coordinator_auth_link_profiles(
				coordinator_id,attempt_id,issuer,subject,auth_config_revision,browser_transaction_hash,link_id,display_name,verified_at_ms)
				SELECT coordinator_id,attempt_id,issuer,account_subject,auth_config_revision,browser_transaction_hash,link_id,'Fixture Profile',finalized_at_ms FROM coordinator_auth_link_attempts;
				DELETE FROM coordinator_auth_controller_attestations;
				DELETE FROM coordinator_auth_account_links;`);
			const before = controllerReadSnapshot(controller);
			// Act
			const read = await controller.signed(controller.keyA, "GET", QUERY);
			const post = await controller.signed(controller.keyA, "POST", PATH, BODY);
			// Assert
			expect(read.status).toBe(200);
			expect(await read.json()).toEqual({ kind: "requires_review" });
			expect(post.status).toBe(200);
			expect(await post.json()).toEqual({ kind: "requires_review" });
			expect(controllerReadSnapshot(controller)).toEqual(before);
		} finally {
			await controller.close();
		}
	});
}

describe.each(["SQLite", "D1"] as const)("%s signed device setup HTTP", (backend) => {
	let f: LinkedLegacySetupFixture;
	beforeEach(async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(LEGACY_SETUP.now);
		f = await linkedLegacySetupFixture(backend, { authConfigured: true });
	});
	afterEach(async () => {
		await f?.close();
		vi.useRealTimers();
	});
	registerCompletionTests(() => f);
	registerAdmissionTests(() => f);
	registerInputTests(() => f);
	registerHttpBoundaryTests(() => f);
	registerConnectReadinessTests(backend);

	it("returns requires_review for a revoked account link without changing setup", async () => {
		// Arrange
		f.coordinator.db.prepare("UPDATE coordinator_auth_account_links SET revoked_at_ms = 1").run();
		const before = bindingEffects(f);
		// Act
		const read = await f.signed(f.keyA, "GET", QUERY);
		const complete = await f.signed(f.keyA, "POST", PATH, BODY);
		// Assert
		expect(read.status).toBe(200);
		expect(await read.json()).toEqual({ kind: "requires_review" });
		expect(complete.status).toBe(200);
		expect(await complete.json()).toEqual({ kind: "requires_review" });
		expect(bindingEffects(f)).toEqual(before);
	});

	it("offers eligible controller connection by GET while refusing claim-only POST", async () => {
		// Arrange
		const controller = await linkedLegacySetupFixture(backend, {
			authConfigured: true,
			accountAuthority: "controller_attestation",
		});
		try {
			const before = controllerReadSnapshot(controller);
			// Act
			const read = await controller.signed(controller.keyA, "GET", QUERY);
			const complete = await controller.signed(controller.keyA, "POST", PATH, BODY);
			// Assert
			expect(read.status).toBe(200);
			expect(await read.json()).toEqual({ kind: "connect_required" });
			expect(complete.status).toBe(200);
			expect(await complete.json()).toEqual({ kind: "requires_review" });
			expect(controllerReadSnapshot(controller)).toEqual(before);
		} finally {
			await controller.close();
		}
	});

	it("does not claim completion when server authentication is unconfigured", async () => {
		// Arrange
		const unconfigured = await linkedLegacySetupFixture(backend);
		try {
			const before = bindingEffects(unconfigured);
			// Act
			const response = await unconfigured.signed(unconfigured.keyA, "POST", PATH, BODY);
			// Assert
			expect(response.status).toBe(404);
			expect(bindingEffects(unconfigured)).toEqual(before);
		} finally {
			await unconfigured.close();
		}
	});

	it("does not claim completion when the required auth schema is absent", async () => {
		// Arrange: simulate an old coordinator database, not malformed authority.
		f.coordinator.db.exec("DROP TABLE coordinator_auth_device_claims");
		const before = f.coordinator.db
			.prepare("SELECT * FROM coordinator_device_ownership_bindings")
			.all();
		// Act
		const read = await f.signed(f.keyA, "GET", QUERY);
		const response = await f.signed(f.keyA, "POST", PATH, BODY);
		// Assert
		expect(read.status).toBe(503);
		expect(read.headers.get("X-Codemem-Auth-Error")).toBe(
			"coordinator_auth_schema_upgrade_required",
		);
		expect(response.status).toBe(503);
		expect(response.headers.get("X-Codemem-Auth-Error")).toBe(
			"coordinator_auth_schema_upgrade_required",
		);
		expect(
			f.coordinator.db.prepare("SELECT * FROM coordinator_device_ownership_bindings").all(),
		).toEqual(before);
	});
});
