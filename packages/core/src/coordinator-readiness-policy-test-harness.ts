import { expect, it } from "vitest";
import type { RevocationFixture } from "./coordinator-device-revocation-test-harness.js";

type PolicyFixture = Pick<RevocationFixture, "store" | "input" | "rows" | "exec">;
type Run = (use: (f: PolicyFixture) => Promise<void>) => Promise<void>;

async function groups(f: PolicyFixture, ids: string[]) {
	for (const id of ids) await f.store.createGroup(id);
	const prepare = () =>
		f.exec(
			`UPDATE groups SET readiness_generation='prepared' WHERE group_id IN (${ids.map(() => "?").join(",")})`,
			...ids,
		);
	const generations = async () => {
		const rows = (await f.rows("groups")) as {
			group_id: string;
			readiness_generation: string | null;
		}[];
		return ids.map((id) => rows.find((r) => r.group_id === id)?.readiness_generation);
	};
	return { prepare, generations };
}

export function registerPolicyInvalidation(run: Run) {
	registerScopeMove(run);
	registerPolicyFields(run);
	registerRevocation(run);
	registerRollback(run);
}

function registerPolicyFields(run: Run) {
	for (const patch of [
		{ authorityType: "local" },
		{ coordinatorId: "other" },
		{ manifestIssuerDeviceId: "issuer" },
		{ manifestHash: "digest" },
		{ status: "inactive" },
		{ kind: "project" },
		{ groupId: null },
	]) {
		it(`policy generation: changing ${Object.keys(patch)[0]} clears the group once`, () =>
			run(async (f) => {
				const groupId = f.input.groupId,
					scopeId = `${groupId}-scope`;
				const { prepare, generations } = await groups(f, [groupId, `${groupId}-neighbor`]);
				await f.store.createScope({ scopeId, groupId, label: "Scope" });
				await prepare();
				await f.store.updateScope({ scopeId, ...patch });
				expect(await generations()).toEqual([null, "prepared"]);
				await prepare();
				await f.store.updateScope({ scopeId, ...patch });
				expect(await generations()).toEqual(["prepared", "prepared"]);
			}));
	}
}

function registerScopeMove(run: Run) {
	it("policy generation: a scope move clears source and destination; presentation edits and retries preserve both", () =>
		run(async (f) => {
			const source = f.input.groupId,
				target = `${source}-target`;
			const { prepare, generations } = await groups(f, [source, target, `${source}-neighbor`]);
			const scopeId = `${source}-scope`;
			await f.store.createScope({ scopeId, label: "Initial", groupId: source });
			await prepare();
			expect(await f.store.updateScope({ scopeId, groupId: target })).toMatchObject({
				group_id: target,
			});
			expect(await generations()).toEqual([null, null, "prepared"]);
			await prepare();
			await f.store.updateScope({ scopeId, label: "Renamed", groupId: target });
			expect(await generations()).toEqual(["prepared", "prepared", "prepared"]);
			await f.store.updateScope({ scopeId, membershipEpoch: 2 });
			expect(await generations()).toEqual(["prepared", null, "prepared"]);
			await prepare();
			await expect(f.store.updateScope({ scopeId, membershipEpoch: 1 })).rejects.toThrow(
				"backwards",
			);
			expect(await generations()).toEqual(["prepared", "prepared", "prepared"]);
			// A losing write must not clear either the live or proposed group.
			await f.exec(
				"CREATE TRIGGER skip_scope_write BEFORE UPDATE ON coordinator_scopes BEGIN SELECT RAISE(IGNORE); END",
			);
			try {
				await expect(f.store.updateScope({ scopeId, groupId: source })).rejects.toThrow(
					"scope_update_conflict",
				);
				expect(await generations()).toEqual(["prepared", "prepared", "prepared"]);
			} finally {
				await f.exec("DROP TRIGGER skip_scope_write");
			}
		}));
}
function registerRevocation(run: Run) {
	it("policy generation: a device revocation follows new ID and canonical key subjects separately", () =>
		run(async (f) => {
			const source = f.input.groupId,
				sameId = `${source}-same-id`,
				keyGroup = `${source}-alias`;
			const unfilled = `${source}-unfilled`;
			const { prepare, generations } = await groups(f, [
				source,
				sameId,
				keyGroup,
				unfilled,
				`${source}-neighbor`,
			]);
			const alias = {
				...f.input,
				groupId: keyGroup,
				deviceId: `${f.input.deviceId}-alias`,
				publicKey: `${f.input.publicKey} alias`,
			};
			await f.store.enrollDevice(source, f.input);
			await f.store.enrollDevice(sameId, { ...f.input, publicKey: "opaque" });
			await f.store.enrollDevice(keyGroup, alias);
			// Historical rows may share the key even before their key ID has been filled.
			await f.store.enrollDevice(unfilled, { ...alias, deviceId: `${alias.deviceId}-legacy` });
			await f.exec("UPDATE enrolled_devices SET key_id=NULL WHERE group_id=?", unfilled);
			const input = { ...f.input, groupId: source };
			await prepare();
			expect(
				await f.store.createDeviceRevocation({ ...input, fingerprint: "stale" }),
			).toMatchObject({ kind: "rejected" });
			expect(await generations()).toEqual(Array(5).fill("prepared"));
			expect(await f.store.createDeviceRevocation(input)).toMatchObject({ kind: "revoked" });
			expect(await generations()).toEqual([null, null, null, null, "prepared"]);
			await prepare();
			await f.store.createDeviceRevocation(input);
			expect(await generations()).toEqual(Array(5).fill("prepared"));
			await f.store.createDeviceRevocation(alias);
			expect(await generations()).toEqual(["prepared", "prepared", null, "prepared", "prepared"]);
		}));
}
function registerRollback(run: Run) {
	for (const action of ["scope", "revocation"] as const)
		it(`policy generation: a failed generation clear rolls back the ${action} write`, () =>
			run(async (f) => {
				const groupId = f.input.groupId;
				const { prepare, generations } = await groups(f, [groupId]);
				const scopeId = `${groupId}-scope`;
				await f.store.createScope({ scopeId, label: "Active", groupId });
				await f.store.enrollDevice(groupId, f.input);
				await prepare();
				// Inject a storage failure at the generation write, after the policy write.
				await f.exec(
					"CREATE TRIGGER fail_generation_clear BEFORE UPDATE OF readiness_generation ON groups BEGIN SELECT RAISE(ABORT,'injected_failure'); END",
				);
				try {
					const write =
						action === "scope"
							? f.store.updateScope({ scopeId, status: "inactive" })
							: f.store.createDeviceRevocation({ ...f.input, groupId });
					await expect(write).rejects.toThrow();
					expect(await generations()).toEqual(["prepared"]);
					expect(await f.rows("coordinator_scopes")).toContainEqual(
						expect.objectContaining({ scope_id: scopeId, status: "active" }),
					);
					expect(await f.rows("coordinator_device_revocations")).not.toContainEqual(
						expect.objectContaining({ evidence_group_id: groupId }),
					);
				} finally {
					await f.exec("DROP TRIGGER fail_generation_clear");
				}
			}));
}
