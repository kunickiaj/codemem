import { expect, it, vi } from "vitest";
import { createCoordinatorApp } from "./coordinator-api.js";
import type { RevocationFixture } from "./coordinator-device-revocation-test-harness.js";
import { projectInvite } from "./coordinator-project-revocation-test-harness.js";
import { recipientInvite } from "./coordinator-recipient-revocation-test-harness.js";
import { fingerprintPublicKey } from "./sync-fingerprint.js";

export { enrollmentDml } from "./coordinator-enrollment-receipt-test-fixtures.js";

type Fixture = RevocationFixture & { counts: number[]; backend: "SQLite" | "D1" };
type Run = (use: (fixture: Fixture) => Promise<void>) => Promise<void>;

async function preparedWrite(f: Fixture, write: () => Promise<unknown>, expected: number[]) {
	const { groupId } = f.input;
	const neighbor = `${groupId}-other`;
	await f.store.createGroup(neighbor);
	await f.exec(
		"UPDATE groups SET readiness_generation='prepared' WHERE group_id IN (?,?)",
		groupId,
		neighbor,
	);
	f.counts.length = 0;
	await write();
	expect(f.counts.filter((count) => count !== 0)).toEqual(expected);
	const groups = await f.rows("groups");
	expect(groups).toContainEqual(
		expect.objectContaining({ group_id: groupId, readiness_generation: null }),
	);
	expect(groups).toContainEqual(
		expect.objectContaining({ group_id: neighbor, readiness_generation: "prepared" }),
	);
}

export function registerReadinessWriterTests(run: Run) {
	registerLegacyRoutes(run);
	registerLegacyWrites(run);
	registerInviteWrites(run);
	registerRemovalWrites(run);
	registerJoinApproval(run);
	registerWriterBoundaries(run);
	registerMembershipWriters(run);
}

async function arrangeScopedDevice(f: Fixture, scopeId: string) {
	const { groupId } = f.input;
	await f.store.createGroup(groupId);
	await f.store.enrollDevice(groupId, f.input);
	await f.store.createScope({
		scopeId,
		label: "Scope",
		groupId,
		authorityType: "coordinator",
		membershipEpoch: 1,
	});
}

function registerMembershipWriters(run: Run) {
	for (const action of ["remove Team member", "bind Team", "grant scope", "revoke scope"] as const)
		it(`recipient change: ${action} clears only its group, and a replay preserves a fresh preparation`, () =>
			run(async (f) => {
				const { groupId, deviceId } = f.input;
				const teamId = `${groupId}-team`;
				const scopeId = `${groupId}-scope`;
				await arrangeScopedDevice(f, scopeId);
				const grant = () =>
					f.store.grantScopeMembership({
						scopeId,
						deviceId,
						effectId: `grant-${groupId}`,
						membershipEpoch: 1,
					});
				if (action === "revoke scope") {
					await grant();
					// Legacy members inherit their group's identity from the scope.
					await f.exec(
						"UPDATE coordinator_scope_memberships SET group_id=NULL WHERE scope_id=? AND device_id=?",
						scopeId,
						deviceId,
					);
				}
				const write = {
					"remove Team member": () =>
						f.store.recordTeamMemberRemoval({ teamId, groupId, identityId: "member" }),
					"bind Team": () => f.store.bindTeamGroup({ teamId, groupId }),
					"grant scope": grant,
					"revoke scope": () =>
						f.store.revokeScopeMembership({
							scopeId,
							deviceId,
							effectId: `revoke-${groupId}`,
							membershipEpoch: 2,
						}),
				}[action];
				await preparedWrite(f, write, []);
				await f.exec("UPDATE groups SET readiness_generation='again' WHERE group_id=?", groupId);
				await write();
				if (action === "revoke scope")
					expect(
						await f.store.revokeScopeMembership({
							scopeId,
							deviceId: "missing",
							effectId: `absent-${groupId}`,
						}),
					).toBe(false);
				expect(await f.rows("groups")).toContainEqual(
					expect.objectContaining({ group_id: groupId, readiness_generation: "again" }),
				);
			}));
}

function registerWriterBoundaries(run: Run) {
	it("does not clear a preparation when no enrollment matches", () =>
		run(async (f) => {
			const { groupId, deviceId } = f.input;
			await f.store.createGroup(groupId);
			await f.exec("UPDATE groups SET readiness_generation='prepared' WHERE group_id=?", groupId);
			expect(await f.store.renameDevice(groupId, deviceId, "absent")).toBe(false);
			expect(f.counts).toEqual([0]);
			expect(await f.rows("groups")).toContainEqual(
				expect.objectContaining({ group_id: groupId, readiness_generation: "prepared" }),
			);
		}));
	it("cannot commit an enrollment without migration 0056", () =>
		run(async (f) => {
			const { groupId, deviceId } = f.input;
			await f.store.createGroup(groupId);
			await f.exec("ALTER TABLE groups DROP COLUMN readiness_generation");
			try {
				await expect(f.store.enrollDevice(groupId, f.input)).rejects.toThrow();
				expect(await f.store.getEnrollment(groupId, deviceId)).toBeNull();
			} finally {
				await f.exec("ALTER TABLE groups ADD COLUMN readiness_generation TEXT");
			}
		}));
	it("a two-group removal returns its own two-row receipt and clears both generations", () =>
		run(async (f) => {
			const { groupId, deviceId } = f.input;
			const second = `${groupId}-second`;
			for (const group of [groupId, second]) {
				await f.store.createGroup(group);
				await f.store.enrollDevice(group, f.input);
			}
			await f.exec("UPDATE groups SET readiness_generation='prepared' WHERE group_id=?", second);
			const target = await f.store.previewDeviceRemoval({ deviceIds: [deviceId] });
			if (target.kind !== "ready") throw new Error("fixture removal preview unavailable");
			await preparedWrite(
				f,
				() =>
					f.store.removeDeviceEnrollments({
						deviceIds: [deviceId],
						expectedDigest: target.expected_digest,
					}),
				[2],
			);
			expect(await f.rows("groups")).toContainEqual(
				expect.objectContaining({ group_id: second, readiness_generation: null }),
			);
		}));
}

function registerLegacyWrites(run: Run) {
	it("preserves each legacy enrollment receipt with an active group generation", () =>
		run(async (f) => {
			const { store, input } = f;
			const { groupId, deviceId } = input;
			await store.createGroup(groupId);
			await preparedWrite(f, () => store.enrollDevice(groupId, input), [1]);
			await preparedWrite(
				f,
				() => store.enrollDevice(groupId, { ...input, displayName: "updated" }),
				[1],
			);
			const publicKey = `${input.publicKey} annotated`;
			await preparedWrite(
				f,
				() =>
					store.enrollDevice(groupId, {
						...input,
						publicKey,
						fingerprint: fingerprintPublicKey(publicKey),
					}),
				[1, 1],
			);
			await preparedWrite(f, () => store.renameDevice(groupId, deviceId, "renamed"), [1]);
			await preparedWrite(f, () => store.setDeviceEnabled(groupId, deviceId, false), [1]);
			await preparedWrite(f, () => store.setDeviceEnabled(groupId, deviceId, true), [1]);
			await preparedWrite(f, () => store.archiveGroup(groupId), []);
			await preparedWrite(f, () => store.unarchiveGroup(groupId), []);
			await preparedWrite(f, () => store.removeDevice(groupId, deviceId), [1]);
		}));
}

function registerInviteWrites(run: Run) {
	for (const kind of ["add_device", "team_member", "project"] as const) {
		for (const existing of [false, true])
			it(`${kind} acceptance (${existing ? "update" : "insert"}) and identity repair keep single-row receipts`, () =>
				run(async (f) => {
					const { groupId, deviceId } = f.input;
					const accept = await acceptance(f, kind);
					if (existing) await f.store.enrollDevice(groupId, f.input);
					await preparedWrite(f, accept, f.backend === "D1" && !existing ? [1, 1] : [1]);
					await f.exec(
						"UPDATE enrolled_devices SET identity_id=NULL WHERE group_id=? AND device_id=?",
						groupId,
						deviceId,
					);
					await preparedWrite(f, accept, [1]);
				}));
	}
}

function registerRemovalWrites(run: Run) {
	for (const method of ["remove", "fill"] as const)
		it(`${method} reports one enrollment change`, () =>
			run(async (f) => {
				const { groupId, deviceId, publicKey, fingerprint } = f.input;
				await f.store.createGroup(groupId);
				if (method === "fill") {
					await f.exec(
						"INSERT INTO enrolled_devices(group_id,device_id,public_key,fingerprint,created_at) VALUES(?,?,?,?, 'then')",
						groupId,
						deviceId,
						publicKey,
						fingerprint,
					);
					await preparedWrite(f, () => f.store.fillEnrollmentKeyIds(), [1]);
					return;
				}
				await f.store.enrollDevice(groupId, f.input);
				const target = await f.store.previewDeviceRemoval({ deviceIds: [deviceId] });
				if (target.kind !== "ready") throw new Error("fixture removal preview unavailable");
				await preparedWrite(
					f,
					() =>
						f.store.removeDeviceEnrollments({
							deviceIds: [deviceId],
							expectedDigest: target.expected_digest,
						}),
					[1],
				);
			}));
}

function registerJoinApproval(run: Run) {
	for (const mode of ["insert", "update", "reset"] as const)
		it(`join approval: ${mode}`, () =>
			run(async (f) => {
				const { groupId, deviceId } = f.input;
				await f.store.createGroup(groupId);
				if (mode !== "insert") await f.store.enrollDevice(groupId, f.input);
				const publicKey = mode === "reset" ? `${f.input.publicKey} commented` : f.input.publicKey;
				const invite = await f.store.createInvite({
					groupId,
					policy: "approval_required",
					expiresAt: "2099-01-01T00:00:00Z",
				});
				const request = await f.store.createJoinRequest({
					groupId,
					deviceId,
					publicKey,
					fingerprint: fingerprintPublicKey(publicKey),
					token: invite.token,
				});
				await preparedWrite(
					f,
					() =>
						postLegacy(f, "/v1/admin/join-requests/approve", { request_id: request.request_id }),
					mode === "reset" ? [1, 1] : [1],
				);
			}));
}

function registerLegacyRoutes(run: Run) {
	for (const path of ["/v1/admin/devices", "/v1/join"])
		it(`${path} accepts the old enrollment request with an active generation`, () =>
			run(async (f) => {
				const { groupId, deviceId, publicKey, fingerprint } = f.input;
				await f.store.createGroup(groupId);
				const invite = await f.store.createInvite({
					groupId,
					policy: "auto_admit",
					expiresAt: "2099-01-01T00:00:00Z",
				});
				const body = {
					device_id: deviceId,
					public_key: publicKey,
					fingerprint,
					...(path === "/v1/join" ? { token: invite.token } : { group_id: groupId }),
				};
				await preparedWrite(f, () => postLegacy(f, path, body), [1]);
			}));
}

async function postLegacy(f: Fixture, path: string, body: Record<string, unknown>) {
	const close = vi.spyOn(f.store, "close").mockResolvedValue();
	const app = createCoordinatorApp({
		storeFactory: () => f.store,
		requestVerifier: async () => false,
		runtime: { adminSecret: () => "fixture-admin", now: () => "2026-10-06T00:00:00Z" },
	});
	try {
		const response = await app.request(path, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Codemem-Coordinator-Admin": "fixture-admin",
			},
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(200);
	} finally {
		close.mockRestore();
	}
}

async function acceptance(f: Fixture, kind: "add_device" | "team_member" | "project") {
	if (kind === "project") {
		const { input } = await projectInvite(
			f,
			`share_${crypto.randomUUID().replaceAll("-", "")}00000000`,
		);
		return () => f.store.consumeProjectInvite(input);
	}
	const { input } = await recipientInvite(f, kind);
	return () => f.store.consumeRecipientInvite(input);
}
