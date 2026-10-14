import { act } from "preact/test-utils";
import { vi } from "vitest";
import type { AccountOperation, AccountView } from "../lib/api/account";

export const privateUrl = "https://coordinator.example/auth/link/start?code=private-fixture";
export const operation = (state: AccountOperation["state"] = "starting"): AccountOperation => ({
	operationId: "op-one",
	contextId: "context-one",
	groupId: "group-one",
	state,
	failure: null,
	browserUrlAvailable: state === "awaiting_browser",
	startedAt: "2026-01-01T00:00:00Z",
	deadlineAt: "2026-01-01T00:05:00Z",
	finishedAt: null,
});
export const status = (overrides: Partial<AccountView> = {}): AccountView => ({
	version: 1,
	contextId: "context-one",
	setup: "ready",
	groups: ["group-one"],
	selectedGroupId: "group-one",
	local: {
		deviceId: "device-one",
		fingerprint: "fingerprint",
		identityId: "identity-one",
		identityLabel: "Local identity",
		deviceLabel: "Laptop",
	},
	coordinator: { origin: "https://coordinator.example" },
	remote: {
		kind: "status",
		coordinatorId: "coordinator-one",
		identityId: "identity-one",
		state: "unlinked",
		identityMatches: true,
		account: null,
	},
	canLink: true,
	blockedReason: null,
	operation: null,
	checkedAt: "2026-01-01T00:00:00Z",
	...overrides,
});
export const response = (body: unknown, code = 200) =>
	new Response(JSON.stringify(body), { status: code });
export function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
export const settle = async () => {
	// Drain response promises, then requests started by the resulting effects.
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
};
export const tick = async () => {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1000);
	});
	await settle();
};
