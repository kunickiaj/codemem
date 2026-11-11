// Native D1 runs a legacy team completion as one batch: a guard per capture read, then
// the INSERT. A change that lands just before that batch must refuse the completion as
// unavailable. A conflicting binding also fails the INSERT's owner check, so only the
// guards in front of the denial read keep the answer "unavailable".
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ed25519KeyIdForRevocation } from "../../core/src/coordinator-ed25519-key-id-compat.js";
import {
	completions,
	coordinatorId,
	db,
	exec,
	futureGroup,
	recovery,
	reset,
	signer,
	state,
	timestamp,
} from "./legacy-completion-owner-proof-test-fixtures.js";

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date(timestamp));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network forbidden"));
	await reset();
});
afterEach(() => {
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

const CHANGES: Record<string, (keyId: string) => Promise<unknown>> = {
	"history metadata": () =>
		exec(`UPDATE ${completions} SET created_at=? WHERE group_id='history-A'`, "2026-10-09T00:00:00.000Z"),
	"binding to another owner": (keyId) =>
		exec(
			`INSERT INTO coordinator_device_ownership_bindings
			(device_id,key_id,identity_id,coordinator_id,binding_id,provenance,source_ref,bound_at)
			VALUES (?,?,'C',?,'raced-binding','owner_enrollment','raced-source',?)`,
			signer.deviceId,
			keyId,
			coordinatorId,
			timestamp,
		),
};

it.each(Object.keys(CHANGES))(
	"native %s just before the winning batch refuses as unavailable",
	async (name) => {
		// Arrange
		const { h, value } = await recovery();
		const keyId = (await ed25519KeyIdForRevocation(signer.publicKey)) ?? "";
		h.arm(async () => {
			await CHANGES[name]?.(keyId);
		});
		// Act
		const pending = h.complete(value);
		// Assert: no conflict, no completion, and the change stays.
		await expect(pending).rejects.toThrow(/^completion_manifest_unavailable$/u);
		expect(h.injected()).toBe(true);
		expect(await state()).toEqual(h.afterMutation());
		expect(
			await db
				.prepare(`SELECT group_id FROM ${completions} WHERE group_id=?`)
				.bind(futureGroup)
				.first(),
		).toBeNull();
	},
);
