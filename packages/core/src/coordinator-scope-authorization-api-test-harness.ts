import { createPrivateKey, sign } from "node:crypto";
import { expect, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";
import { UNRELATED_PUBLIC_KEY } from "./coordinator-enrollment-revocation-test-harness.js";
import type {
	contractHarness,
	GrantFixture,
} from "./coordinator-identity-group-grant-test-harness.js";
import { D1CoordinatorStore, type D1DatabaseLike } from "./d1-coordinator-store.js";
import { buildCanonicalRequest, verifySignature } from "./sync-auth.js";

type Test = ReturnType<typeof contractHarness>;
export const scopeApiNowMs = Date.parse("2026-10-07T00:00:00Z");
const scopeId = (f: GrantFixture) => `${f.review.groupId}-scope`;
const memberId = (f: GrantFixture, suffix = "requester") => `${f.review.deviceId}-${suffix}`;
const pathFor = (f: GrantFixture, id = scopeId(f)) =>
	`/v1/scopes/${id}/members?group_id=${f.review.groupId}`;
const adminHeaders = { "X-Codemem-Coordinator-Admin": "fixture-admin" };

function appFor(f: GrantFixture) {
	return createCoordinatorApp({
		storeFactory: () => f.store,
		runtime: {
			now: () => new Date(scopeApiNowMs).toISOString(),
			adminSecret: () => "fixture-admin",
		},
		requestVerifier: async (input) =>
			verifySignature({ ...input, bodyBytes: Buffer.from(input.bodyBytes) }),
		requestRateLimit: { limiter: { check: () => ({ allowed: true, retryAfterS: 1 }) } },
	});
}
function headers(f: GrantFixture, path: string, nonce = "scope-api-nonce") {
	// RFC 8032 public test vector, not a live credential.
	const key = createPrivateKey({
		key: Buffer.from(
			"302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
			"hex",
		),
		format: "der",
		type: "pkcs8",
	});
	const timestamp = String(scopeApiNowMs / 1000);
	return {
		"X-Opencode-Device": memberId(f),
		"X-Opencode-Timestamp": timestamp,
		"X-Opencode-Nonce": nonce,
		"X-Opencode-Signature": `v2:${sign(null, buildCanonicalRequest("GET", path, timestamp, nonce, Buffer.alloc(0)), key).toString("base64")}`,
	};
}
async function addMember(f: GrantFixture, suffix: string, id = scopeId(f)) {
	const deviceId = memberId(f, suffix);
	await f.store.enrollDevice(f.review.groupId, {
		deviceId,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: f.review.fingerprint,
	});
	await f.store.grantScopeMembership({
		scopeId: id,
		deviceId,
		effectId: `${id}-${deviceId}`,
		membershipEpoch: 2,
		manifestIssuerDeviceId: "fixture-issuer",
		manifestHash: "fixture-manifest",
	});
}
async function addScope(f: GrantFixture, id = scopeId(f)) {
	await f.store.createScope({
		scopeId: id,
		groupId: f.review.groupId,
		coordinatorId: f.review.coordinatorId,
		label: "Scope",
		membershipEpoch: 2,
		manifestIssuerDeviceId: "fixture-issuer",
		manifestHash: "fixture-manifest",
	});
}
async function seed(f: GrantFixture) {
	await f.store.createGroup(f.review.groupId);
	await addScope(f);
	await addMember(f, "requester");
	await addMember(f, "peer");
}
async function revoke(f: GrantFixture, suffix: string) {
	// ID-only evidence avoids revoking the requester's shared fixture key.
	await f.exec(
		"INSERT INTO coordinator_device_revocations(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at) VALUES(?,?,?,?,?,?,?,?)",
		"device_id",
		memberId(f, suffix),
		`${scopeId(f)}-${suffix}-revoked`,
		f.review.groupId,
		memberId(f, suffix),
		"opaque-evidence",
		f.review.fingerprint,
		new Date(scopeApiNowMs).toISOString(),
	);
}

export function registerScopeAuthorizationApi(test: Test) {
	registerCatalog(test);
	registerMembers(test);
	registerPrivateFailures(test);
	registerSnapshotFormat(test);
	registerRequesterDrift(test);
}
function registerCatalog(test: Test) {
	test.for(["own", "empty"] as const)(
		"catalog is version 1 %s discovery metadata, not member permission",
		async (mode, { fixture: f }) => {
			// Arrange
			await seed(f);
			await addScope(f, `${scopeId(f)}-foreign-membership`);
			if (mode === "empty")
				await f.exec(
					"UPDATE coordinator_scope_memberships SET status = 'revoked' WHERE device_id = ?",
					memberId(f),
				);
			const getter = vi.spyOn(f.store, "getScopeAuthorization");
			const path = `/v1/scopes?group_id=${f.review.groupId}`;
			const scope = (await f.store.listScopes({ groupId: f.review.groupId })).find(
				(s) => s.scope_id === scopeId(f),
			);
			// Act
			const response = await appFor(f).request(path, { headers: headers(f, path) });
			// Assert
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ version: 1, items: mode === "own" ? [scope] : [] });
			expect(getter).not.toHaveBeenCalled();
		},
	);
}
async function addRevokedAlias(f: GrantFixture) {
	await addMember(f, "key-alias");
	await f.exec(
		"UPDATE enrolled_devices SET public_key = ? WHERE device_id = ?",
		`${UNRELATED_PUBLIC_KEY} alias-comment`,
		memberId(f, "key-alias"),
	);
	const evidenceId = `${memberId(f, "key-alias")}-evidence`;
	await f.store.enrollDevice(f.review.groupId, {
		deviceId: evidenceId,
		publicKey: UNRELATED_PUBLIC_KEY,
		fingerprint: f.review.fingerprint,
	});
	expect(
		await f.store.createDeviceRevocation({
			groupId: f.review.groupId,
			deviceId: evidenceId,
			publicKey: UNRELATED_PUBLIC_KEY,
			fingerprint: f.review.fingerprint,
		}),
	).toMatchObject({ kind: "revoked" });
}
function registerMembers(test: Test) {
	test("signed members expose exact current DTOs while raw admin keeps revoked, disabled and historical rows", async ({
		fixture: f,
	}) => {
		// Arrange
		await seed(f);
		for (const suffix of ["revoked", "disabled", "historical"]) await addMember(f, suffix);
		await revoke(f, "revoked");
		await addRevokedAlias(f);
		await f.store.setDeviceEnabled(f.review.groupId, memberId(f, "disabled"), false);
		await f.exec(
			"UPDATE coordinator_scope_memberships SET status = 'revoked' WHERE device_id = ?",
			memberId(f, "historical"),
		);
		const raw = await f.store.listScopeMemberships(scopeId(f), true);
		const snapshot = await f.store.getScopeAuthorization({
			groupId: f.review.groupId,
			scopeId: scopeId(f),
		});
		if (snapshot.kind !== "authorized") throw new Error("Expected authorized fixture");
		const path = pathFor(f);
		// Act
		const response = await appFor(f).request(path, { headers: headers(f, path) });
		const inspection = await appFor(f).request(
			`/v1/admin/groups/${f.review.groupId}/scopes/${scopeId(f)}/members?include_revoked=1`,
			{ headers: adminHeaders },
		);
		// Assert
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			authorization_version: 1,
			scope: snapshot.scope,
			items: snapshot.members.map(({ membership, enrollment, keyId }) => ({
				membership,
				enrollment,
				key_id: keyId,
			})),
		});
		expect(snapshot.members.map((m) => m.membership.device_id)).toEqual(
			[memberId(f, "peer"), memberId(f)].sort(),
		);
		expect(snapshot.members.every((m) => m.keyId === EXPECTED_KEY_ID)).toBe(true);
		expect(inspection.status).toBe(200);
		expect(await inspection.json()).toEqual({ items: raw });
		expect(raw).toHaveLength(6);
		expect(await f.store.listScopeMemberships(scopeId(f), true)).toEqual(raw);
	});
}
function registerPrivateFailures(test: Test) {
	test("revoked requester denies admission before reading current scope authorization", async ({
		fixture: f,
	}) => {
		// Arrange: the real signature remains valid; current central revocation denies admission.
		await seed(f);
		await revoke(f, "requester");
		const getter = vi.spyOn(f.store, "getScopeAuthorization");
		const path = pathFor(f);
		// Act
		const response = await appFor(f).request(path, { headers: headers(f, path) });
		// Assert
		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({ error: "device_revoked" });
		expect(getter).not.toHaveBeenCalled();
	});
	test.for(["unsigned", "invalid"] as const)(
		"%s request cannot read private current authorization",
		async (mode, { fixture: f }) => {
			// Arrange
			await seed(f);
			await revoke(f, "peer");
			const getter = vi.spyOn(f.store, "getScopeAuthorization");
			const path = pathFor(f);
			const requestHeaders =
				mode === "unsigned"
					? {}
					: {
							...headers(f, path),
							"X-Opencode-Signature": `v2:${Buffer.alloc(64).toString("base64")}`,
						};
			// Act
			const response = await appFor(f).request(path, { headers: requestHeaders });
			// Assert
			expect(response.status).toBe(401);
			expect(getter).not.toHaveBeenCalled();
		},
	);
	test.for(["unknown", "not-member"] as const)(
		"%s scope returns masked existing public error",
		async (mode, { fixture: f }) => {
			// Arrange
			await seed(f);
			if (mode === "not-member")
				await f.exec("DELETE FROM coordinator_scope_memberships WHERE device_id = ?", memberId(f));
			const path = pathFor(f, mode === "unknown" ? "absent" : scopeId(f));
			// Act
			const response = await appFor(f).request(path, { headers: headers(f, path) });
			// Assert
			expect(response.status).toBe(mode === "unknown" ? 404 : 403);
			expect(await response.json()).toEqual({
				error: mode === "unknown" ? "scope_not_found" : "scope_membership_required",
			});
		},
	);
	test("unavailable current snapshot returns fixed 503 without diagnostics", async ({
		fixture: f,
	}) => {
		// Arrange
		await seed(f);
		vi.spyOn(f.store, "getScopeAuthorization").mockResolvedValue({
			kind: "rejected",
			error: "scope_authorization_unavailable",
		});
		const path = pathFor(f);
		// Act
		const response = await appFor(f).request(path, { headers: headers(f, path) });
		// Assert
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({ error: "scope_authorization_unavailable" });
	});
}
function registerSnapshotFormat(test: Test) {
	test.for([
		["missing version", "authorizationVersion", undefined],
		["version zero", "authorizationVersion", 0],
		["string version", "authorizationVersion", "1"],
		["raw kind", "kind", "raw"],
		["foreign scope", "scope_id", "foreign"],
		["foreign group", "group_id", "foreign"],
		["throw", "throw", null],
	] as const)(
		"malformed producer $0 returns fixed 503 without raw fallback",
		async ([mode, field, value], { fixture: f }) => {
			// Arrange: start from real authority, then inject an untrusted producer receipt.
			await seed(f);
			const snapshot = await f.store.getScopeAuthorization({
				groupId: f.review.groupId,
				scopeId: scopeId(f),
			});
			if (snapshot.kind !== "authorized") throw new Error("Expected authorized fixture");
			const receipt: Record<string, unknown> = structuredClone(snapshot);
			if (field === "scope_id" || field === "group_id") {
				receipt.scope = { ...snapshot.scope, [field]: value };
			} else if (value === undefined) delete receipt[field];
			else receipt[field] = value;
			const getter = vi.spyOn(f.store, "getScopeAuthorization");
			if (mode === "throw") getter.mockRejectedValue(new Error("private SQL diagnostic"));
			// Deliberately malformed runtime receipt; the cast stays inside this boundary test.
			else
				getter.mockResolvedValue(
					receipt as unknown as Awaited<ReturnType<typeof f.store.getScopeAuthorization>>,
				);
			const raw = vi.spyOn(f.store, "listScopeMemberships");
			const path = pathFor(f);
			// Act
			const response = await appFor(f).request(path, { headers: headers(f, path) });
			// Assert
			expect(getter).toHaveBeenCalledTimes(1);
			expect(response.status).toBe(503);
			expect(await response.json()).toEqual({ error: "scope_authorization_unavailable" });
			expect(raw).not.toHaveBeenCalled();
		},
	);
}
async function driftRequester(f: GrantFixture, mode: string) {
	if (mode === "late-revocation") return revoke(f, "requester");
	if (mode === "membership")
		return f.exec("DELETE FROM coordinator_scope_memberships WHERE device_id = ?", memberId(f));
	if (mode === "removed") return f.store.removeDevice(f.review.groupId, memberId(f));
	if (mode === "disabled") return f.store.setDeviceEnabled(f.review.groupId, memberId(f), false);
	const changes: Record<string, readonly [string, string]> = {
		key: ["public_key", UNRELATED_PUBLIC_KEY],
		"key-alias": ["public_key", `${CANONICAL_PUBLIC_KEY} changed-comment`],
		fingerprint: ["fingerprint", "changed"],
		identity: ["identity_id", "changed"],
	};
	const change = changes[mode];
	if (!change) throw new Error("Unknown drift fixture");
	await f.exec(
		`UPDATE enrolled_devices SET ${change[0]} = ? WHERE device_id = ?`,
		change[1],
		memberId(f),
	);
}
function registerRequesterDrift(test: Test) {
	test.for([
		"key",
		"key-alias",
		"fingerprint",
		"identity",
		"disabled",
		"removed",
		"membership",
		"late-revocation",
	] as const)(
		"admitted requester %s drift cannot authorize a current roster",
		async (mode, { fixture: f }) => {
			// Arrange: mutate only after real signature and nonce admission, before current snapshot capture.
			await seed(f);
			const getter = f.store.getScopeAuthorization.bind(f.store);
			const current = vi
				.spyOn(f.store, "getScopeAuthorization")
				.mockImplementation(async (input) => {
					await driftRequester(f, mode);
					return getter(input);
				});
			const path = pathFor(f);
			// Act
			const response = await appFor(f).request(path, { headers: headers(f, path) });
			// Assert
			expect(current).toHaveBeenCalledTimes(1);
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({ error: "scope_membership_required" });
		},
	);
}

function countDatabaseStatements(db: D1DatabaseLike, count: () => void): D1DatabaseLike {
	type Statement = ReturnType<D1DatabaseLike["prepare"]>;
	const originals = new WeakMap<Statement, Statement>();
	const wrap = (statement: Statement): Statement => {
		const wrapped: Statement = {
			bind: (...values) => wrap(statement.bind(...values)),
			run: () => {
				count();
				return statement.run();
			},
			async raw<T>() {
				count();
				return statement.raw<T>();
			},
			async first<T>() {
				count();
				return statement.first<T>();
			},
			async all<T>() {
				count();
				return statement.all<T>();
			},
		};
		originals.set(wrapped, statement);
		return wrapped;
	};
	return {
		prepare: (sql) => wrap(db.prepare(sql)),
		async batch(statements) {
			// D1's nonce admission uses a write/read batch. Preserve statement identity.
			for (const _statement of statements) count();
			if (!db.batch) throw new Error("Missing fixture batch");
			return db.batch(statements.map((statement) => originals.get(statement) ?? statement));
		},
	};
}
export function registerScopeApiQueryBudget(
	test: Test,
	database: (f: GrantFixture) => D1DatabaseLike,
) {
	test("signed 121-member request stays below 50 queries; catalog does not read each scope snapshot", async ({
		fixture: f,
	}) => {
		// Arrange: count all executed statements, including nonce writes, on the API's database.
		await seed(f);
		let reads = 0;
		const store = new D1CoordinatorStore(
			countDatabaseStatements(database(f), () => {
				reads += 1;
			}),
		);
		const app = appFor({ ...f, store });
		const catalog = `/v1/scopes?group_id=${f.review.groupId}`;
		// Act
		const small = await app.request(catalog, { headers: headers(f, catalog, "small") });
		const smallReads = reads;
		for (let n = 0; n < 119; n += 1) {
			await addMember(f, `bulk-${n}`);
			const id = `${scopeId(f)}-${n}`;
			await addScope(f, id);
			await addMember(f, "requester", id);
		}
		reads = 0;
		const large = await app.request(catalog, { headers: headers(f, catalog, "large") });
		const largeReads = reads;
		reads = 0;
		const path = pathFor(f);
		const members = await app.request(path, { headers: headers(f, path, "members") });
		// Assert
		expect(small.status).toBe(200);
		expect(large.status).toBe(200);
		expect(((await large.json()) as { items: unknown[] }).items).toHaveLength(120);
		expect(largeReads).toBe(smallReads);
		expect(largeReads).toBe(7);
		expect(members.status).toBe(200);
		expect(((await members.json()) as { items: unknown[] }).items).toHaveLength(121);
		expect(reads).toBeGreaterThan(5);
		expect(reads).toBeLessThan(50);
		expect(reads).toBe(10);
	});
}
