import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type HeadlessLinkApproval,
	type LinkCoordinatorAccountHeadlessOptions,
	linkCoordinatorAccountHeadless,
} from "./coordinator-account-link-headless-runtime.js";
import { createLocalDevice } from "./coordinator-account-link-headless-test-fixtures.js";
import { CoordinatorAccountLinkError } from "./coordinator-account-link-runtime.js";
import {
	approveInBrowser,
	type HeadlessDeviceFixture,
	linkRows,
	NOW,
	ORIGIN,
	SUBJECT,
	setupHeadlessDevice,
} from "./coordinator-device-headless-link-test-fixtures.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(() => {
		throw new Error("external key stores forbidden");
	}),
}));
vi.mock("node:timers/promises", async (importOriginal) => {
	const timers = await importOriginal<typeof import("node:timers/promises")>();
	return { ...timers, setTimeout: vi.fn(timers.setTimeout) };
});

let f: HeadlessDeviceFixture;
let local: ReturnType<typeof createLocalDevice>;
beforeEach(async () => {
	vi.spyOn(Date, "now").mockReturnValue(NOW);
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("external network forbidden"));
	f = await setupHeadlessDevice("SQLite");
	local = createLocalDevice(f.keyA);
});
afterEach(() => {
	try {
		expect(globalThis.fetch).not.toHaveBeenCalled();
	} finally {
		vi.restoreAllMocks();
		local.cleanup();
		if (f.db.open) f.db.close();
	}
});

/** Runs the device side against the in-process coordinator; the browser approves each code. */
function linkAgainstCoordinator(approve: LinkCoordinatorAccountHeadlessOptions["approve"]) {
	let browser: Promise<unknown> = Promise.resolve();
	// Each poll waits for the browser half, which runs while the device waits.
	vi.mocked(delay).mockImplementation(async () => {
		await browser;
		return undefined;
	});
	return linkCoordinatorAccountHeadless({
		dbPath: local.dbPath,
		keysDir: local.keysDir,
		groupId: "group-a",
		coordinatorUrl: ORIGIN,
		expectedIdentityId: "identity-a",
		expectedAuthority: "controller_attestation",
		expectedCoordinatorId: f.cfg.coordinatorId,
		fetch: async (input, init) => f.app.fetch(new Request(input, init)),
		onCode: (code) => {
			browser = approveInBrowser(f, code.code);
		},
		approve,
	});
}

it("links through the coordinator after the person approves in a browser and here", async () => {
	// Arrange
	const approvals: HeadlessLinkApproval[] = [];
	// Act
	const result = await linkAgainstCoordinator(async (approval) => {
		approvals.push(approval);
		return true;
	});
	// Assert
	expect(result).toMatchObject({ identityId: "identity-a", state: "finalized" });
	expect(approvals).toEqual([
		{
			issuer: f.cfg.issuer,
			subject: SUBJECT,
			email: "ada@example.test",
			emailVerified: true,
			displayName: "Ada Example",
		},
	]);
	expect(linkRows(f)).toEqual([
		expect.objectContaining({
			subject: SUBJECT,
			identity_id: "identity-a",
			provenance_attempt: result.attemptId,
		}),
	]);
});

it("cancels the attempt at the coordinator when the person declines on the device", async () => {
	// Act
	const error = await linkAgainstCoordinator(async () => false).catch((caught: unknown) => caught);
	// Assert
	expect(error).toBeInstanceOf(CoordinatorAccountLinkError);
	expect((error as CoordinatorAccountLinkError).code).toBe("link_declined");
	expect(linkRows(f)).toEqual([]);
	expect(f.db.prepare("SELECT state FROM coordinator_auth_link_attempts").all()).toEqual([
		{ state: "failed" },
	]);
});
