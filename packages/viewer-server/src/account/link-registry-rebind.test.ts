import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountContext, AccountContextResult } from "./context.js";
import { createAccountLinkRegistry } from "./link-registry.js";
import type { AccountRebindResult, AccountRebindRunner } from "./rebind.js";

const context: AccountContext = {
	contextId: "context-a",
	groupId: "group-a",
	coordinatorUrl: "https://coordinator.example.test",
	dbPath: "/fixture/never-open.sqlite",
	keysDir: "/fixture/never-open-keys",
	deviceId: "device-a",
	fingerprint: "a".repeat(64),
	identityId: "actor-a",
	fileIdentity: { dev: "1", ino: "2" },
};
const rebindUrl = `${context.coordinatorUrl}/auth/rebind/start?attempt_id=a&start_code=b`;
const registries: ReturnType<typeof createAccountLinkRegistry>[] = [];
afterEach(async () => {
	await Promise.all(registries.splice(0).map((registry) => registry.close()));
});

function fixture(rebind?: AccountRebindRunner) {
	const readContext = vi.fn(
		(): AccountContextResult => ({
			setup: "ready",
			groups: ["group-a"],
			selectedGroupId: "group-a",
			coordinator: { origin: context.coordinatorUrl },
			context: structuredClone(context),
		}),
	);
	const registry = createAccountLinkRegistry({ readContext, rebind });
	registries.push(registry);
	const started = registry.start({
		intent: "sign_in",
		context: structuredClone(context),
		expectedCoordinatorId: "coordinator-a",
		expectedAuthority: "device_claim",
	});
	if (!("operation" in started)) throw new Error("expected an operation");
	return { registry, id: started.operation.operationId };
}

async function finished(registry: ReturnType<typeof createAccountLinkRegistry>, id: string) {
	await vi.waitFor(() => expect(registry.get(id)?.finishedAt).not.toBeNull());
	return registry.get(id);
}

describe("sign-in operations", () => {
	it("hands the rebind URL to the browser and succeeds once the device switched", async () => {
		// Arrange
		let release = () => {};
		const rebind = vi.fn<AccountRebindRunner>(async ({ onBrowserStart }) => {
			onBrowserStart(rebindUrl);
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return { kind: "switched", targetIdentityId: "identity-target" };
		});
		const { registry, id } = fixture(rebind);
		// Act
		await vi.waitFor(() => expect(registry.get(id)?.state).toBe("awaiting_browser"));
		const url = registry.browserUrl(id);
		release();
		// Assert
		expect(url).toBe(rebindUrl);
		expect(rebind).toHaveBeenCalledWith(expect.objectContaining({ context }));
		expect(await finished(registry, id)).toMatchObject({ state: "succeeded", failure: null });
	});

	it.each<[string, AccountRebindResult, string, string]>([
		[
			"an unlinked account",
			{ kind: "refused", reason: "account_not_linked" },
			"failed",
			"account_not_linked",
		],
		["the daily limit", { kind: "refused", reason: "daily_limit" }, "failed", "daily_limit"],
		["a retry refusal", { kind: "refused", reason: "retry" }, "failed", "request_failed"],
		[
			"a start the coordinator won't rebind",
			{ kind: "refused", reason: "unavailable", beforeBrowser: true },
			"failed",
			"sign_in_unavailable",
		],
		[
			"a later unavailable refusal",
			{ kind: "refused", reason: "unavailable" },
			"failed",
			"request_failed",
		],
		["an unclear outcome", { kind: "pending" }, "outcome_unknown", "switch_pending"],
	])("reports %s so the person knows what to do", async (_case, result, state, failure) => {
		// Arrange / Act
		const { registry, id } = fixture(async () => result);
		// Assert
		expect(await finished(registry, id)).toMatchObject({ state, failure });
	});

	it("refuses to hand out a URL for another ceremony", async () => {
		// Arrange
		const rebind = vi.fn<AccountRebindRunner>(async ({ onBrowserStart, signal }) => {
			onBrowserStart(`${context.coordinatorUrl}/auth/link/start?attempt_id=a`);
			return signal.aborted ? { kind: "failed" } : { kind: "switched", targetIdentityId: "x" };
		});
		const { registry, id } = fixture(rebind);
		// Act / Assert
		expect(await finished(registry, id)).toMatchObject({
			state: "failed",
			failure: "invalid_response",
		});
	});

	it("reports a changed account context checked before finalize", async () => {
		// Arrange: the coordinator configuration changes while Google sign-in is open.
		let changed = false;
		const rebind = vi.fn<AccountRebindRunner>(async ({ isCurrent }) => {
			changed = true;
			return isCurrent?.() === false
				? { kind: "failed" }
				: { kind: "switched", targetIdentityId: "x" };
		});
		const readContext = vi.fn(
			(): AccountContextResult => ({
				setup: "ready",
				groups: ["group-a"],
				selectedGroupId: "group-a",
				coordinator: { origin: context.coordinatorUrl },
				context: {
					...structuredClone(context),
					coordinatorUrl: changed ? "https://other.example.test" : context.coordinatorUrl,
				},
			}),
		);
		const registry = createAccountLinkRegistry({ readContext, rebind });
		registries.push(registry);
		const started = registry.start({
			intent: "sign_in",
			context: structuredClone(context),
			expectedCoordinatorId: "coordinator-a",
			expectedAuthority: "device_claim",
		});
		if (!("operation" in started)) throw new Error("expected an operation");
		// Act / Assert
		expect(await finished(registry, started.operation.operationId)).toMatchObject({
			state: "failed",
			failure: "context_changed",
		});
	});

	it("is unavailable without a rebind runner", async () => {
		const { registry, id } = fixture();
		expect(await finished(registry, id)).toMatchObject({
			state: "failed",
			failure: "configuration_invalid",
		});
	});
});
