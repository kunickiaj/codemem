import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as account from "../lib/api/account";
import { useMyAccount } from "./my-account-flow";
import { operation, settle, status } from "./my-account-test-utils";

vi.mock("../lib/api/account", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/api/account")>()),
	getAccountStatus: vi.fn(),
	startAccountLink: vi.fn(),
	getAccountOperation: vi.fn(),
	getAccountBrowserUrl: vi.fn(),
	cancelAccountLink: vi.fn(),
}));

// Planned server annotation: display context stays separate from mutation authority.
// Until the DTO adds this optional field, keep the contract local to this regression.
type AssociatedView = account.AccountView & { operationContextId?: string };
const ACTOR_CONTEXT = "actor-context-C";
const OWNER_CONTEXT = "hashed-owner-display-context-A";
const GROUP = "group-one";
const states = ["outcome_unknown", "succeeded", "failed", "cancelled"] as const;
const intents = ["connect", "refresh", "disconnect"] as const;
const lifecycles = ["initial load", "status refresh", "reload"] as const;
let mount: HTMLDivElement;
let flow: ReturnType<typeof useMyAccount>;

function FlowProbe() {
	flow = useMyAccount();
	return null;
}

function associatedView(candidate: account.AccountOperation | null = null): AssociatedView {
	return {
		...status(),
		contextId: OWNER_CONTEXT,
		operationContextId: ACTOR_CONTEXT,
		local: { deviceId: "device-c", fingerprint: "fingerprint-c", identityId: "actor-c" },
		accountOwner: { identityId: "identity-a", memoryActorId: "actor-c" },
		remote: {
			kind: "status",
			coordinatorId: "coordinator-one",
			authority: "controller_attestation",
			identityId: "identity-a",
			identityMatches: true,
			state: "linked",
			account: { displayName: "Owner A" },
		},
		canLink: false,
		blockedReason: candidate?.state === "outcome_unknown" ? "operation_active" : "already_linked",
		operation: candidate,
	};
}

function actorOperation(state: (typeof states)[number], intent: account.AccountIntent) {
	return {
		...operation(state),
		intent,
		contextId: ACTOR_CONTEXT,
		failure: state === "outcome_unknown" ? "cancellation_unconfirmed" : null,
		finishedAt: "2026-01-01T00:01:00Z",
	} satisfies account.AccountOperation;
}

async function probe() {
	await act(async () => render(<FlowProbe />, mount));
	await settle();
}

async function loadView(view: AssociatedView, lifecycle: (typeof lifecycles)[number]) {
	if (lifecycle === "initial load") {
		vi.mocked(account.getAccountStatus).mockResolvedValue(view);
		await probe();
		return;
	}
	vi.mocked(account.getAccountStatus).mockResolvedValue(associatedView());
	await probe();
	vi.mocked(account.getAccountStatus).mockResolvedValue(view);
	if (lifecycle === "reload") {
		act(() => render(null, mount));
		await probe();
		return;
	}
	await act(async () => {
		await flow.refresh();
	});
	await settle();
}

function assertReadOnlyOwnerView() {
	expect(flow.view).toMatchObject({
		contextId: OWNER_CONTEXT,
		local: { identityId: "actor-c" },
		accountOwner: { identityId: "identity-a", memoryActorId: "actor-c" },
		canLink: false,
	});
	expect(flow.view).not.toHaveProperty("managementActions");
	expect(account.startAccountLink).not.toHaveBeenCalled();
	expect(account.cancelAccountLink).not.toHaveBeenCalled();
	expect(account.getAccountBrowserUrl).not.toHaveBeenCalled();
	expect(window.open).not.toHaveBeenCalled();
	expect(fetch).not.toHaveBeenCalled();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.resetAllMocks();
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Unexpected network request");
		}),
	);
	vi.spyOn(window, "open").mockReturnValue(null);
	mount = document.createElement("div");
	document.body.append(mount);
});
afterEach(() => {
	act(() => render(null, mount));
	mount.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe.each(lifecycles)("associated owner operation visibility after %s", (lifecycle) => {
	describe.each(intents)("original actor C's %s operation", (intent) => {
		it.each(states)(
			"retains %s without interpreting A's linked status as C's outcome",
			async (state) => {
				// Arrange: backend attaches C's operation to a separately hashed A display view.
				const candidate = actorOperation(state, intent);
				const view = associatedView(candidate);
				// Act: use the actual hook, including its initial-load/refresh effects.
				await loadView(view, lifecycle);
				await act(async () => {
					await flow.link();
					await flow.change("refresh");
					await flow.change("disconnect", view);
				});
				// Assert: retaining an old result is not permission to mutate owner A.
				expect(flow.operation).toEqual(candidate);
				expect(flow.operation?.contextId).toBe(ACTOR_CONTEXT);
				expect(flow.operation?.contextId).not.toBe(flow.view?.contextId);
				expect(flow.pendingOperation).toBeNull();
				assertReadOnlyOwnerView();
			},
		);
	});
	it.each([
		"unrelated context",
		"wrong group",
		"no selected group",
		"no annotation",
		"wrong annotation",
	])("does not adopt an operation with %s", async (mismatch) => {
		// Arrange: an owner association must not relax exact operation-context/group matching.
		const candidate = actorOperation("outcome_unknown", "refresh");
		const view = associatedView(candidate);
		if (mismatch === "unrelated context") candidate.contextId = "unrelated-actor-context";
		if (mismatch === "wrong group") candidate.groupId = "other-group";
		if (mismatch === "no selected group") view.selectedGroupId = null;
		if (mismatch === "no annotation") delete view.operationContextId;
		if (mismatch === "wrong annotation") view.operationContextId = "unrelated-actor-context";
		// Act
		await loadView(view, lifecycle);
		// Assert
		expect(flow.operation).toBeNull();
		expect(flow.pendingOperation).toBeNull();
		expect(account.getAccountOperation).not.toHaveBeenCalled();
		assertReadOnlyOwnerView();
	});
	it("leaves an associated owner view without an operation unchanged", async () => {
		// Arrange
		const view = associatedView();
		// Act
		await loadView(view, lifecycle);
		// Assert
		expect(flow.view).toEqual(view);
		expect(flow.operation).toBeNull();
		expect(flow.pendingOperation).toBeNull();
		expect(account.getAccountOperation).not.toHaveBeenCalled();
		assertReadOnlyOwnerView();
	});
});

it.each(["current", "unrelated"])(
	"preserves legacy ordinary-view matching for a %s operation",
	async (match) => {
		// Arrange: an ordinary actor view has no owner association or annotation.
		const candidate = actorOperation("outcome_unknown", "connect");
		if (match === "unrelated") candidate.contextId = "unrelated-actor-context";
		const view = status({ contextId: ACTOR_CONTEXT, operation: candidate, canLink: false });
		vi.mocked(account.getAccountStatus).mockResolvedValue(view);
		// Act
		await probe();
		// Assert
		expect(flow.operation).toEqual(match === "current" ? candidate : null);
		expect(flow.view?.selectedGroupId).toBe(GROUP);
		expect(account.startAccountLink).not.toHaveBeenCalled();
		expect(account.getAccountOperation).not.toHaveBeenCalled();
	},
);
