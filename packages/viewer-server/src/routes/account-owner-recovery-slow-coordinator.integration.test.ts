import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { recoveryFixture, recoveryTests } from "../../test/owner-recovery-service-fixture.js";
import {
	type AccountOwnerRecoveryServiceOptions,
	createAccountOwnerRecoveryService,
} from "../account/owner-recovery-service.js";
import type {
	RecoveryPreview,
	RecoveryProfile,
	RecoveryResult,
} from "../account/owner-recovery-types.js";
import { createApp } from "../index.js";

recoveryTests();
const LOCAL = "http://127.0.0.1:7441";
const BASE = "/api/account/owner-recovery";
const REVIEWS = "/v1/admin/auth-controller-reviews";
// Just over the 3s default that 0.47.0 used; the live scoped review took about 2.6s.
const SLOW_MS = 3_200;
type Fixture = Awaited<ReturnType<typeof recoveryFixture>>;
type ReviewKind = "preview" | "commit";

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

/** Route admin reviews through the real coordinator, delaying the chosen requests first. */
function slowCoordinator(f: Fixture, slow: (kind: ReviewKind, index: number) => boolean) {
	const seen: ReviewKind[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn<typeof fetch>(async (input, init) => {
			const request = new Request(input, init);
			if (new URL(request.url).pathname === REVIEWS) {
				const body = (await request.clone().json()) as Record<string, unknown>;
				const kind = Object.hasOwn(body, "confirm_owner_resolution_digest") ? "commit" : "preview";
				seen.push(kind);
				// An aborted request never reaches the coordinator, as on the live Worker.
				if (slow(kind, seen.length - 1)) await abortableDelay(SLOW_MS, request.signal);
			}
			return f.transport(request);
		}),
	);
	return seen;
}

async function viewer(f: Fixture, options: Partial<AccountOwnerRecoveryServiceOptions> = {}) {
	// The affected workspace used the 3s sync_coordinator_timeout_s default.
	const service = createAccountOwnerRecoveryService({
		...f.serviceOptions,
		readCoordinatorTimeoutS: () => 3,
		...options,
	});
	f.cleanup(() => service.close());
	const app = createApp({
		accountLink: {
			readContext: f.readContext,
			registry: f.registry,
			ownerRecovery: service,
			getListenerAddress: () => ({ host: "127.0.0.1", port: 7441 }),
		},
	});
	const session = await app.request(`${LOCAL}/api/account/session`, {
		headers: { Host: "127.0.0.1:7441" },
	});
	const { csrfToken } = await session.json();
	const headers = {
		Host: "127.0.0.1:7441",
		Origin: LOCAL,
		"X-Codemem-Account-Csrf": csrfToken,
		"Content-Type": "application/json",
	};
	const send = (path: string, body?: unknown) =>
		app.request(`${LOCAL}${path}`, {
			method: body === undefined ? "GET" : "POST",
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
	const profile = async () => {
		const response = await send(BASE);
		expect(response.status).toBe(200);
		return ((await response.json()) as { profile: RecoveryProfile }).profile;
	};
	const preview = async (requestId: string) => {
		const response = await send(`${BASE}/preview`, {
			profile: await profile(),
			existingOwnerId: "identity-a",
			groups: ["group-a"],
			requestId,
			purpose: "review",
		});
		expect(response.status).toBe(200);
		return (await response.json()) as RecoveryPreview;
	};
	const confirm = (review: RecoveryPreview) =>
		send(`${BASE}/confirm`, { preview: review, approvalDigest: review.approvalDigest });
	return { preview, confirm };
}

function attestations(f: Fixture) {
	return f.db.prepare("SELECT count(*) AS n FROM coordinator_auth_controller_attestations").get();
}

it("previews and confirms when each coordinator review takes longer than 3s", async () => {
	// Arrange: slow the first preview and the commit; leave confirm's fresh preview fast.
	const f = await recoveryFixture({ fact: false, maintainedReview: true });
	const seen = slowCoordinator(f, (kind, index) => index === 0 || kind === "commit");
	const app = await viewer(f);
	// Act
	const review = await app.preview("slow-preview");
	const response = await app.confirm(review);
	// Assert
	expect(review.groupPreviews).toMatchObject([{ groupId: "group-a", action: "new" }]);
	expect(response.status).toBe(200);
	const result = (await response.json()) as RecoveryResult;
	expect(result.groups).toMatchObject([{ groupId: "group-a", status: "confirmed" }]);
	expect(seen).toEqual(["preview", "preview", "commit"]);
	expect(f.reviewOwner.mock.calls.map(([input]) => input.timeoutS)).toEqual([10, 10]);
	expect(f.association()).toMatchObject({ ownerIdentityId: "identity-a" });
}, 30_000);

it("reproduces 0.47.0: a 3s commit timeout reports unknown and the coordinator saves nothing", async () => {
	// Arrange: force the old 3s timeout and slow only the commit.
	const f = await recoveryFixture({ fact: false, maintainedReview: true });
	slowCoordinator(f, (kind) => kind === "commit");
	const app = await viewer(f, {
		reviewOwner: (input) => f.reviewOwner({ ...input, timeoutS: 3 }),
	});
	const review = await app.preview("old-timeout");
	const before = attestations(f);
	// Act
	const response = await app.confirm(review);
	// Assert: the commit failed, so the receipt check after it never ran.
	const result = (await response.json()) as RecoveryResult;
	expect(result.groups).toMatchObject([{ groupId: "group-a", status: "unknown" }]);
	expect(f.readRemoteReceiptStatus).not.toHaveBeenCalled();
	expect(attestations(f)).toEqual(before);
	expect(f.association()).toBeNull();
	const next = await app.preview("after-old-timeout");
	expect(next.groupPreviews).toMatchObject([{ groupId: "group-a", action: "new" }]);
}, 30_000);

it("names the fix when ~/.codemem is group-writable instead of reporting the coordinator unavailable", async () => {
	// Arrange: some managed workspaces create ~/.codemem as drwxrwsr-x.
	const f = await recoveryFixture({ fact: false, maintainedReview: true });
	slowCoordinator(f, () => false);
	const app = await viewer(f);
	const state = join(homedir(), ".codemem");
	mkdirSync(state, { recursive: true });
	chmodSync(state, 0o2775);
	const review = await app.preview("shared-home");
	// Act
	const response = await app.confirm(review);
	// Assert
	expect(response.status).toBe(409);
	const body = (await response.json()) as { error: string; detail: string };
	expect(body.error).toBe("account_owner_recovery_storage_unsafe");
	expect(body.detail).toBe(
		`${state} is writable by other users. Run \`chmod go-w ${state}\`, then try again.`,
	);
	expect(
		f.reviewOwner.mock.calls.filter(([input]) => input.confirmOwnerResolutionDigest !== undefined),
	).toHaveLength(0);
});
