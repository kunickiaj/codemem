import { expect, it, vi } from "vitest";
import type { Store } from "./coordinator-auth-store-test-fixtures.js";
import {
	BOUNDARY_READINESS_MAX_PROJECTS_BYTES,
	BOUNDARY_READINESS_MAX_SOURCE_SCOPES,
	type BoundaryReadinessProject,
	fitBoundaryReadinessProjects,
	type PutBoundaryReadinessInput,
} from "./coordinator-boundary-readiness.js";
import { discardReadinessWithoutFeature } from "./coordinator-boundary-readiness-route.js";
import {
	CANONICAL_PUBLIC_KEY,
	EXPECTED_KEY_ID,
} from "./coordinator-ed25519-key-id-test-fixtures.js";

/** A store and a prefix that no other test uses, so tests can share one database. */
export type BoundaryReadinessFixture = {
	store: Store;
	prefix: string;
	exec: (sql: string, ...params: string[]) => Promise<void>;
};

export function boundaryReadinessHarness(
	fixture: (use: (f: BoundaryReadinessFixture) => Promise<void>) => Promise<void>,
) {
	return it.extend<{ fixture: BoundaryReadinessFixture }>({
		fixture: async ({ task: _task }, use) => fixture(use),
	});
}
export type BoundaryReadinessTest = ReturnType<typeof boundaryReadinessHarness>;

/** The clock every fixture injects into its store. */
export const BOUNDARY_READINESS_CLOCK_MS = Date.UTC(2026, 10, 18, 12, 0, 0);
const CLOCK_ISO = new Date(BOUNDARY_READINESS_CLOCK_MS).toISOString();

const boundaryId = (digit: string) => `managed-project:${digit.repeat(64)}`;
const BOUNDARY = boundaryId("a");
const OTHER_BOUNDARY = boundaryId("b");

/** What a record reports when it shows every Project the device holds. */
const NOTHING_LEFT_OUT = {
	omitted_projects: 0,
	invalid_boundary_entries: 0,
	unauthorized_source_scope_ids: [],
	complete: true,
};

interface World {
	exec: BoundaryReadinessFixture["exec"];
	store: Store;
	groupId: string;
	deviceId: string;
	sourceScopeId: string;
}

/** A group with one older scope, and one enrolled device that is a member of it. */
async function world(f: BoundaryReadinessFixture): Promise<World> {
	const groupId = `${f.prefix}-group`;
	const sourceScopeId = `${f.prefix}-source`;
	const deviceId = `${f.prefix}-device`;
	await f.store.createGroup(groupId);
	await addScope(f.store, groupId, sourceScopeId);
	await enroll(f.store, groupId, deviceId);
	await grant(f.store, sourceScopeId, deviceId);
	return { exec: f.exec, store: f.store, groupId, deviceId, sourceScopeId };
}

async function addScope(store: Store, groupId: string, scopeId: string) {
	await store.createScope({
		scopeId,
		label: scopeId,
		groupId,
		authorityType: "coordinator",
		membershipEpoch: 1,
	});
}

async function enroll(store: Store, groupId: string, deviceId: string) {
	await store.enrollDevice(groupId, {
		deviceId,
		publicKey: CANONICAL_PUBLIC_KEY,
		fingerprint: "fixture-fingerprint",
	});
}

async function grant(store: Store, scopeId: string, deviceId: string) {
	await store.grantScopeMembership({
		scopeId,
		deviceId,
		effectId: `grant:${scopeId}:${deviceId}`,
		membershipEpoch: 1,
	});
}

function project(
	w: World,
	overrides: Partial<BoundaryReadinessProject> = {},
): BoundaryReadinessProject {
	return {
		source_scope_id: w.sourceScopeId,
		boundary_scope_id: BOUNDARY,
		state: "waiting",
		own_rows_in_source: 412,
		own_rows_in_boundary: 0,
		...overrides,
	};
}

function put(w: World, overrides: Partial<PutBoundaryReadinessInput> = {}) {
	return w.store.putBoundaryReadiness({
		groupId: w.groupId,
		deviceId: w.deviceId,
		sequence: 1,
		projects: [project(w)],
		...overrides,
	});
}

const stored = (w: World) =>
	w.store.getBoundaryReadiness({ groupId: w.groupId, deviceId: w.deviceId });

function registerStoring(test: BoundaryReadinessTest) {
	test("has no record for a device that never sent one", async ({ fixture }) => {
		const w = await world(fixture);

		expect(await stored(w)).toBeNull();
	});

	test("stores a record with the Projects of an older scope the device is in", async ({
		fixture,
	}) => {
		const w = await world(fixture);

		const result = await put(w);

		expect(result).toEqual({ kind: "stored", sequence: 1, rejected: [] });
		expect(await stored(w)).toEqual({
			group_id: w.groupId,
			device_id: w.deviceId,
			sequence: 1,
			...NOTHING_LEFT_OUT,
			updated_at: CLOCK_ISO,
			projects: [project(w)],
		});
	});

	test("stores a record with no Projects, which says the device runs the migration code", async ({
		fixture,
	}) => {
		const w = await world(fixture);

		const result = await put(w, { projects: [] });

		expect(result).toEqual({ kind: "stored", sequence: 1, rejected: [] });
		expect(await stored(w)).toMatchObject({ sequence: 1, projects: [] });
	});

	test("replaces every Project of the earlier record when a newer one arrives", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await put(w);

		const result = await put(w, {
			sequence: 2,
			projects: [project(w, { boundary_scope_id: OTHER_BOUNDARY, state: "adopted" })],
		});

		expect(result).toMatchObject({ kind: "stored", sequence: 2 });
		expect((await stored(w))?.projects).toEqual([
			project(w, { boundary_scope_id: OTHER_BOUNDARY, state: "adopted" }),
		]);
	});

	test("keeps one Project listed under two older scopes as two entries", async ({ fixture }) => {
		const w = await world(fixture);
		const second = `${fixture.prefix}-second-source`;
		await addScope(w.store, w.groupId, second);
		await grant(w.store, second, w.deviceId);

		await put(w, { projects: [project(w), project(w, { source_scope_id: second })] });

		expect((await stored(w))?.projects).toHaveLength(2);
	});

	test("keeps each device's record apart", async ({ fixture }) => {
		const w = await world(fixture);
		const other = { ...w, deviceId: `${fixture.prefix}-other-device` };
		await enroll(w.store, w.groupId, other.deviceId);
		await grant(w.store, w.sourceScopeId, other.deviceId);
		await put(w);

		await put(other, { sequence: 7, projects: [] });

		expect(await stored(w)).toMatchObject({ sequence: 1, projects: [project(w)] });
		expect(await stored(other)).toMatchObject({ sequence: 7, projects: [] });
	});
}

function registerOrdering(test: BoundaryReadinessTest) {
	for (const sequence of [2, 1]) {
		test(`does not replace a record at sequence 2 with one at sequence ${sequence}`, async ({
			fixture,
		}) => {
			const w = await world(fixture);
			await put(w, { sequence: 2 });

			const result = await put(w, {
				sequence,
				projects: [project(w, { boundary_scope_id: OTHER_BOUNDARY })],
			});

			expect(result).toEqual({ kind: "stale", sequence: 2 });
			expect(await stored(w)).toMatchObject({ sequence: 2, projects: [project(w)] });
		});
	}
}

function registerEnrollmentChecks(test: BoundaryReadinessTest) {
	test("refuses a device with no enrollment in the group", async ({ fixture }) => {
		const w = await world(fixture);
		const stranger = { ...w, deviceId: `${fixture.prefix}-stranger` };

		const result = await put(stranger, { projects: [] });

		expect(result).toEqual({ kind: "not_enrolled" });
		expect(await stored(stranger)).toBeNull();
	});

	test("refuses a device whose enrollment is disabled", async ({ fixture }) => {
		const w = await world(fixture);
		await w.store.setDeviceEnabled(w.groupId, w.deviceId, false);

		const result = await put(w, { projects: [] });

		expect(result).toEqual({ kind: "not_enrolled" });
		expect(await stored(w)).toBeNull();
	});
}

function registerProjectChecks(test: BoundaryReadinessTest) {
	test("leaves out a Project under an older scope the device is not a member of", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const foreign = `${fixture.prefix}-foreign-source`;
		await addScope(w.store, w.groupId, foreign);
		const entry = project(w, { source_scope_id: foreign, boundary_scope_id: OTHER_BOUNDARY });

		const result = await put(w, { projects: [project(w), entry] });

		expect(result).toEqual({
			kind: "stored",
			sequence: 1,
			rejected: [
				{
					source_scope_id: foreign,
					boundary_scope_id: OTHER_BOUNDARY,
					reason: "source_scope_not_authorized",
				},
			],
		});
		expect((await stored(w))?.projects).toEqual([project(w)]);
	});

	test("leaves out a Project under an older scope the device was removed from", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await w.store.revokeScopeMembership({
			scopeId: w.sourceScopeId,
			deviceId: w.deviceId,
			effectId: `revoke:${w.sourceScopeId}:${w.deviceId}`,
		});

		const result = await put(w);

		expect(result).toMatchObject({
			kind: "stored",
			rejected: [{ reason: "source_scope_not_authorized" }],
		});
		expect((await stored(w))?.projects).toEqual([]);
	});

	test("leaves out a Project under a scope that does not exist", async ({ fixture }) => {
		const w = await world(fixture);

		const result = await put(w, {
			projects: [project(w, { source_scope_id: `${fixture.prefix}-missing` })],
		});

		expect(result).toMatchObject({
			kind: "stored",
			rejected: [{ reason: "source_scope_not_authorized" }],
		});
	});

	for (const boundary of ["team:group:default", "managed-project:abc", `${BOUNDARY}0`]) {
		test(`leaves out a Project whose boundary ID is ${boundary.slice(0, 24)}`, async ({
			fixture,
		}) => {
			const w = await world(fixture);

			const result = await put(w, { projects: [project(w, { boundary_scope_id: boundary })] });

			expect(result).toMatchObject({
				kind: "stored",
				rejected: [{ boundary_scope_id: boundary, reason: "boundary_scope_invalid" }],
			});
			expect((await stored(w))?.projects).toEqual([]);
		});
	}
}

const INVALID_RECORDS: {
	name: string;
	change: (w: World) => Partial<PutBoundaryReadinessInput>;
}[] = [
	{ name: "a sequence below one", change: () => ({ sequence: 0 }) },
	{ name: "a sequence that is not a whole number", change: () => ({ sequence: 1.5 }) },
	{ name: "an empty device ID", change: () => ({ deviceId: "" }) },
	{ name: "a negative count of omitted Projects", change: () => ({ omittedProjects: -1 }) },
	{
		name: "an unknown Project state",
		change: (w) => ({ projects: [project(w, { state: "done" as never })] }),
	},
	{
		name: "a negative row count",
		change: (w) => ({ projects: [project(w, { own_rows_in_source: -1 })] }),
	},
	{
		name: "the same Project and older scope twice",
		change: (w) => ({ projects: [project(w), project(w, { state: "adopted" })] }),
	},
];

function registerInvalidInput(test: BoundaryReadinessTest) {
	for (const { name, change } of INVALID_RECORDS) {
		test(`rejects a record with ${name}, and stores nothing`, async ({ fixture }) => {
			const w = await world(fixture);

			await expect(put(w, change(w))).rejects.toThrow("invalid_input");

			expect(await stored(w)).toBeNull();
		});
	}
}

function registerDiscard(test: BoundaryReadinessTest) {
	test("discards a device's record and its Projects", async ({ fixture }) => {
		const w = await world(fixture);
		await put(w);

		const discarded = await w.store.discardBoundaryReadiness({
			groupId: w.groupId,
			deviceId: w.deviceId,
		});

		expect(discarded).toBe(true);
		expect(await stored(w)).toBeNull();
	});

	test("reports that there was nothing to discard", async ({ fixture }) => {
		const w = await world(fixture);

		const discarded = await w.store.discardBoundaryReadiness({
			groupId: w.groupId,
			deviceId: w.deviceId,
		});

		expect(discarded).toBe(false);
	});

	test("leaves another device's record when one is discarded", async ({ fixture }) => {
		const w = await world(fixture);
		const other = { ...w, deviceId: `${fixture.prefix}-other-device` };
		await enroll(w.store, w.groupId, other.deviceId);
		await put(w);
		await put(other, { projects: [] });

		await w.store.discardBoundaryReadiness({ groupId: w.groupId, deviceId: w.deviceId });

		expect(await stored(other)).toMatchObject({ sequence: 1 });
	});

	test("accepts a first sequence again after a discard, as a downgraded device restarts", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await put(w, { sequence: 9 });
		await w.store.discardBoundaryReadiness({ groupId: w.groupId, deviceId: w.deviceId });

		const result = await put(w, { sequence: 1 });

		expect(result).toMatchObject({ kind: "stored", sequence: 1 });
	});
}

/** More Projects than one record holds: distinct boundaries, in the order the device lists them. */
function manyProjects(w: World, count: number): BoundaryReadinessProject[] {
	return Array.from({ length: count }, (_, index) =>
		project(w, { boundary_scope_id: `managed-project:${index.toString(16).padStart(64, "0")}` }),
	);
}

function registerSizeLimit(test: BoundaryReadinessTest) {
	test("stores how many Projects the device left out, and replaces the count with the next record", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await put(w, { omittedProjects: 12 });
		expect(await stored(w)).toMatchObject({ omitted_projects: 12 });

		await put(w, { sequence: 2 });

		expect(await stored(w)).toMatchObject({ omitted_projects: 0 });
	});

	test("stores the largest record a device can build, with the rest counted", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const all = manyProjects(w, 2500);
		const fitted = fitBoundaryReadinessProjects(all);
		expect(fitted.omittedProjects).toBeGreaterThan(0);
		expect(fitted.projects).toEqual(all.slice(0, fitted.projects.length));

		const result = await put(w, fitted);

		expect(result).toMatchObject({ kind: "stored", rejected: [] });
		const record = await stored(w);
		expect(record?.projects).toHaveLength(fitted.projects.length);
		expect(record?.omitted_projects).toBe(all.length - fitted.projects.length);
	});

	test("refuses a record one Project larger than fits, and keeps the stored one", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await put(w);
		const all = manyProjects(w, 2500);
		const tooMany = all.slice(0, fitBoundaryReadinessProjects(all).projects.length + 1);
		expect(JSON.stringify(tooMany).length).toBeGreaterThan(BOUNDARY_READINESS_MAX_PROJECTS_BYTES);

		await expect(put(w, { sequence: 2, projects: tooMany })).rejects.toThrow(
			"boundary_readiness_too_large",
		);

		expect(await stored(w)).toMatchObject({ sequence: 1, projects: [project(w)] });
	});
}

function registerWhatARecordLeavesOut(test: BoundaryReadinessTest) {
	test("is not complete when the device left Projects out, and complete again without them", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await put(w, { omittedProjects: 3 });
		expect(await stored(w)).toMatchObject({ omitted_projects: 3, complete: false });

		await put(w, { sequence: 2 });

		expect(await stored(w)).toMatchObject({ omitted_projects: 0, complete: true });
	});

	test("is not complete when an entry had a malformed boundary ID", async ({ fixture }) => {
		const w = await world(fixture);

		await put(w, {
			projects: [project(w), project(w, { boundary_scope_id: "managed-project:abc" })],
		});

		expect(await stored(w)).toMatchObject({ invalid_boundary_entries: 1, complete: false });
	});

	test("names the older scopes it was refused for, so a later grant there can be noticed", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const foreign = [`${fixture.prefix}-foreign-b`, `${fixture.prefix}-foreign-a`];
		for (const scopeId of foreign) await addScope(w.store, w.groupId, scopeId);

		await put(w, {
			projects: [
				project(w),
				...foreign.map((scopeId) => project(w, { source_scope_id: scopeId })),
				project(w, { source_scope_id: foreign[0], boundary_scope_id: OTHER_BOUNDARY }),
			],
		});

		expect(await stored(w)).toMatchObject({
			unauthorized_source_scope_ids: foreign.toSorted(),
			complete: true,
			projects: [project(w)],
		});
	});
}

function registerAuthorizationReads(test: BoundaryReadinessTest) {
	test("refuses the record when an authorization read fails, and keeps the stored one", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		await put(w);
		const read = vi
			.spyOn(w.store, "getScopeAuthorization")
			.mockResolvedValueOnce({ kind: "rejected", error: "scope_authorization_unavailable" });

		try {
			await expect(put(w, { sequence: 2, projects: [] })).resolves.toMatchObject({
				kind: "stored",
			});
			await expect(
				put(w, { sequence: 3, projects: [project(w, { boundary_scope_id: OTHER_BOUNDARY })] }),
			).rejects.toThrow("boundary_readiness_authorization_unavailable");
		} finally {
			read.mockRestore();
		}

		expect(await stored(w)).toMatchObject({ sequence: 2, projects: [], complete: true });
	});

	test("reads authorization only for scopes the device is a member of", async ({ fixture }) => {
		const w = await world(fixture);
		const read = vi.spyOn(w.store, "getScopeAuthorization");

		try {
			await put(w, {
				projects: [
					project(w),
					project(w, { boundary_scope_id: "managed-project:abc" }),
					...["x", "y", "z"].map((name) =>
						project(w, { source_scope_id: `${fixture.prefix}-not-a-member-${name}` }),
					),
				],
			});

			expect(read).toHaveBeenCalledTimes(1);
			expect(read).toHaveBeenCalledWith({ groupId: w.groupId, scopeId: w.sourceScopeId });
		} finally {
			read.mockRestore();
		}
	});

	test("refuses a record that names more older scopes than one request may read", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const projects = Array.from({ length: BOUNDARY_READINESS_MAX_SOURCE_SCOPES + 1 }, (_, index) =>
			project(w, { source_scope_id: `${fixture.prefix}-scope-${index}` }),
		);

		await expect(put(w, { projects })).rejects.toThrow("boundary_readiness_too_large");
		expect(await stored(w)).toBeNull();
	});
}

/** The readiness record contract, for the SQLite store and both D1 runtimes. */
export function registerBoundaryReadinessContract(test: BoundaryReadinessTest): void {
	registerVerifiedRecords(test);
	registerStoring(test);
	registerOrdering(test);
	registerEnrollmentChecks(test);
	registerProjectChecks(test);
	registerInvalidInput(test);
	registerDiscard(test);
	registerSizeLimit(test);
	registerWhatARecordLeavesOut(test);
	registerAuthorizationReads(test);
}

const coordinatorId = "https://readiness.example.test";
async function preparation(w: World) {
	const generation = crypto.randomUUID();
	await w.exec(
		"UPDATE groups SET readiness_generation=?,readiness_coordinator_id=? WHERE group_id=?",
		generation,
		coordinatorId,
		w.groupId,
	);
	const binding = {
		coordinatorId,
		generation,
		revision: 6,
		keyId: EXPECTED_KEY_ID,
		publicKey: CANONICAL_PUBLIC_KEY,
		filterEvidence: "present" as const,
	};
	const verified = () =>
		w.store.getVerifiedBoundaryReadiness({
			coordinatorId,
			generation,
			groupId: w.groupId,
			deviceId: w.deviceId,
		});
	return { binding, verified };
}

function registerVerifiedRecords(test: BoundaryReadinessTest) {
	registerLegacyHeartbeat(test);
	registerSignerChanges(test);
	registerSequenceFloor(test);
	registerDowngradeOrdering(test);
	registerInventoryRollback(test);
	registerPreparationChanges(test);
}

async function enrollPeer(w: World) {
	const peer = { ...w, deviceId: `${w.deviceId}-peer` };
	await enroll(w.store, w.groupId, peer.deviceId);
	return peer;
}

function registerLegacyHeartbeat(test: BoundaryReadinessTest) {
	test("the verified read checks the device discard marker even with a retained header", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const peer = await enrollPeer(w);
		const { binding, verified } = await preparation(w);
		expect(await put(w, { binding, projects: [] })).toMatchObject({ kind: "stored" });
		// Keep an otherwise valid empty inventory to isolate the read predicate from deletion.
		await w.exec(
			"CREATE TRIGGER retain_header BEFORE DELETE ON coordinator_boundary_readiness BEGIN SELECT RAISE(IGNORE); END",
		);
		try {
			await discardReadinessWithoutFeature(w.store, w);
			expect(await stored(w)).toMatchObject({ sequence: 1, complete: true });
			expect(await verified()).toBeNull();
			expect(await put(peer, { binding, projects: [] })).toMatchObject({ kind: "stored" });
		} finally {
			await w.exec("DROP TRIGGER retain_header");
		}
	});
	test("an unrelated legacy heartbeat preserves the prepared generation and verified inventory", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const peer = await enrollPeer(w);
		const { binding, verified } = await preparation(w);
		expect(await put(w, { binding })).toMatchObject({ kind: "stored" });
		const presence = {
			groupId: peer.groupId,
			deviceId: peer.deviceId,
			capabilities: {},
			addresses: [],
			ttlS: 180,
		};
		for (let i = 0; i < 2; i++) {
			await discardReadinessWithoutFeature(w.store, presence);
			await w.store.upsertPresence(presence);
		}
		expect(await verified()).toMatchObject({ sequence: 1, group_generation: binding.generation });
		expect(await put(w, { binding, sequence: 2 })).toMatchObject({ kind: "stored" });
		expect(await put(peer, { binding, sequence: 8, projects: [] })).toEqual({
			kind: "binding_mismatch",
		});
	});
}

function registerSignerChanges(test: BoundaryReadinessTest) {
	test("revoking a signing key blocks both a later write and use of the stored record", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const { binding, verified } = await preparation(w);
		expect(await put(w, { binding })).toMatchObject({ kind: "stored" });
		await w.exec(
			`INSERT INTO coordinator_device_revocations(subject_kind,subject_value,revocation_id,evidence_group_id,evidence_device_id,evidence_public_key,evidence_fingerprint,created_at)
			VALUES('ed25519_key',?,?,?,?,?,'fixture','now')`,
			binding.keyId,
			crypto.randomUUID(),
			w.groupId,
			w.deviceId,
			binding.publicKey,
		);
		try {
			expect(await put(w, { sequence: 2, binding })).toEqual({ kind: "binding_mismatch" });
			expect(await verified()).toBeNull();
		} finally {
			await w.exec(
				"DELETE FROM coordinator_device_revocations WHERE evidence_group_id=?",
				w.groupId,
			);
		}
	});
	test("a changed enrollment key blocks delayed evidence and withdraws a previous acknowledgement even with the same generation", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const { binding, verified } = await preparation(w);
		expect(await put(w, { binding })).toMatchObject({ kind: "stored" });
		expect(await verified()).not.toBeNull();
		await w.exec(
			"UPDATE enrolled_devices SET key_id=? WHERE group_id=? AND device_id=?",
			"a".repeat(64),
			w.groupId,
			w.deviceId,
		);
		expect(await put(w, { binding, sequence: 2 })).toEqual({ kind: "binding_mismatch" });
		expect(await verified()).toBeNull();
		expect(await stored(w)).toMatchObject({ sequence: 1 });
	});
}

function registerSequenceFloor(test: BoundaryReadinessTest) {
	test("only current bound evidence survives a decision read; a legacy replacement cannot inherit the binding", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const { binding, verified } = await preparation(w);
		await put(w);
		expect(await verified()).toBeNull();
		expect(await put(w, { sequence: 2, binding })).toMatchObject({ kind: "stored" });
		expect(await verified()).toMatchObject({
			sequence: 2,
			group_generation: binding.generation,
			key_id: EXPECTED_KEY_ID,
			filter_evidence: "present",
			refresh_revision: 6,
			projects: [project(w)],
		});
		await put(w, { sequence: 3, projects: [] });
		expect(await verified()).toBeNull();
	});
	test("a downgrade after a higher sequence commits withdraws it and requires a new preparation", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const peer = await enrollPeer(w);
		const { binding, verified } = await preparation(w);
		expect(await put(w, { binding, sequence: 4 })).toMatchObject({ kind: "stored" });
		expect(await put(w, { binding: { ...binding, revision: 5 }, sequence: 5 })).toEqual({
			kind: "binding_mismatch",
		});
		expect(await put(w, { binding, sequence: 5 })).toMatchObject({ kind: "stored" });
		expect(await verified()).toMatchObject({ sequence: 5 });
		await w.store.discardBoundaryReadiness(w);
		expect(await verified()).toBeNull();
		expect(await put(w, { binding, sequence: 6 })).toEqual({ kind: "binding_mismatch" });
		expect(await put(peer, { binding, projects: [] })).toMatchObject({ kind: "stored" });
		const next = await preparation(w);
		expect(await put(w, { binding: next.binding, sequence: 6 })).toMatchObject({ kind: "stored" });
		expect(await verified()).toBeNull();
	});
}

function registerDowngradeOrdering(test: BoundaryReadinessTest) {
	test("a downgrade before an in-flight higher sequence commits fences even the first inventory", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const peer = await enrollPeer(w);
		const { binding, verified } = await preparation(w);
		const access = w.store.listDeviceScopeMemberships.bind(w.store);
		const discard = vi
			.spyOn(w.store, "listDeviceScopeMemberships")
			.mockImplementationOnce(async (...args) => {
				const memberships = await access(...args);
				expect(await w.store.discardBoundaryReadiness(w)).toBe(false);
				return memberships;
			});
		try {
			expect(await put(w, { binding, sequence: 8 })).toEqual({ kind: "binding_mismatch" });
			expect(await verified()).toBeNull();
			expect(await stored(w)).toBeNull();
			expect(await put(peer, { binding, projects: [] })).toMatchObject({ kind: "stored" });
		} finally {
			discard.mockRestore();
		}
	});
	test("a failed inventory delete rolls back the device marker and a retry fences only that device", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const peer = await enrollPeer(w);
		const { binding, verified } = await preparation(w);
		await put(w, { binding });
		await w.exec(
			"CREATE TRIGGER reject_discard BEFORE DELETE ON coordinator_boundary_readiness BEGIN SELECT RAISE(ABORT,'injected_failure'); END",
		);
		try {
			await expect(w.store.discardBoundaryReadiness(w)).rejects.toThrow();
			expect(await verified()).toMatchObject({ sequence: 1, projects: [project(w)] });
		} finally {
			await w.exec("DROP TRIGGER reject_discard");
		}
		expect(await put(w, { binding, sequence: 2 })).toMatchObject({ kind: "stored" });
		expect(await w.store.discardBoundaryReadiness(w)).toBe(true);
		expect(await put(peer, { binding, projects: [] })).toMatchObject({ kind: "stored" });
	});
}

function registerInventoryRollback(test: BoundaryReadinessTest) {
	test("a short Project insert rolls back the replacement header, inventory and binding", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const { binding, verified } = await preparation(w);
		await put(w, { binding });
		const previous = await verified();
		expect(previous).toMatchObject({ sequence: 1, projects: [project(w)] });
		await w.exec(
			"CREATE TRIGGER skip_project BEFORE INSERT ON coordinator_boundary_readiness_projects WHEN NEW.own_rows_in_source=13 BEGIN SELECT RAISE(IGNORE); END",
		);
		try {
			const projects = [
				project(w, { own_rows_in_source: 2 }),
				project(w, { boundary_scope_id: OTHER_BOUNDARY, own_rows_in_source: 13 }),
			];
			await expect(put(w, { binding, sequence: 2, projects })).rejects.toThrow();
			expect(await verified()).toEqual(previous);
			expect(await stored(w)).toMatchObject({ sequence: 1, projects: [project(w)] });
		} finally {
			await w.exec("DROP TRIGGER skip_project");
		}
		expect(await put(w, { binding, sequence: 2 })).toMatchObject({ kind: "stored" });
	});
}

function registerPreparationChanges(test: BoundaryReadinessTest) {
	test("a different coordinator cannot consume a record even if the generation matches", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const { binding, verified } = await preparation(w);
		expect(await put(w, { binding })).toMatchObject({ kind: "stored" });
		const other = "https://elsewhere.example.test";
		await w.exec("UPDATE groups SET readiness_coordinator_id=? WHERE group_id=?", other, w.groupId);
		expect(await verified()).toBeNull();
		expect(
			await w.store.getVerifiedBoundaryReadiness({
				groupId: w.groupId,
				deviceId: w.deviceId,
				coordinatorId: other,
				generation: binding.generation,
			}),
		).toBeNull();
	});
	test("rotating preparation withdraws previous evidence and refuses delayed writes", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const previous = await preparation(w);
		await put(w, { binding: previous.binding });
		const next = await preparation(w);
		expect(await previous.verified()).toBeNull();
		expect(await next.verified()).toBeNull();
		expect(await put(w, { binding: previous.binding, sequence: 3 })).toEqual({
			kind: "binding_mismatch",
		});
		expect(await put(w, { binding: next.binding, sequence: 2 })).toMatchObject({ kind: "stored" });
	});
	registerDelayedWrite(test);
}

function registerDelayedWrite(test: BoundaryReadinessTest) {
	test("a write checks the enrolled key, audience and group after the inventory authorization reads", async ({
		fixture,
	}) => {
		const w = await world(fixture);
		const { binding, verified } = await preparation(w);
		const other = await world({ ...fixture, prefix: `${fixture.prefix}-other` });
		for (const changed of [
			{ keyId: "0".repeat(64) },
			{ publicKey: `${CANONICAL_PUBLIC_KEY} other` },
			{ coordinatorId: "https://other.example.test" },
		]) {
			expect(await put(w, { binding: { ...binding, ...changed } })).toEqual({
				kind: "binding_mismatch",
			});
		}
		expect(await put(other, { binding })).toEqual({ kind: "binding_mismatch" });
		await put(w, { binding });
		const access = w.store.listDeviceScopeMemberships.bind(w.store);
		const change = vi
			.spyOn(w.store, "listDeviceScopeMemberships")
			.mockImplementationOnce(async (...args) => {
				const scopes = await access(...args);
				await enroll(w.store, w.groupId, `${w.deviceId}-new`);
				return scopes;
			});
		try {
			expect(await put(w, { binding, sequence: 2 })).toEqual({ kind: "binding_mismatch" });
			expect(await verified()).toBeNull();
			expect(await stored(w)).toMatchObject({ sequence: 1 });
		} finally {
			change.mockRestore();
		}
	});
}
