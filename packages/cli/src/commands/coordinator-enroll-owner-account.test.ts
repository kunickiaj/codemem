import { expect, it, vi } from "vitest";
import {
	mocks,
	OwnerProfileEnrollmentError,
	parse,
	preparedReviewDigest,
} from "./coordinator-enroll-owner.test-fixture.js";

const resume = ["--resume", "--review-digest", preparedReviewDigest];
const account = [...resume, "--account-admission"];
const printed = () => JSON.stringify(Object.values(mocks.log).flatMap((log) => log.mock.calls));

it("passes explicit account admission and displays the private upload, device and local fingerprint without a launcher", async () => {
	// Arrange: core calls back before returning any verified receipt.
	const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const url = "https://coordinator.example/auth/owner/admit";
	const metadata = {
		requestFile: "private-request.json",
		deviceId: "reviewed-device",
		fingerprint: "a".repeat(64),
	};
	mocks.enrollOwnerProfile.mockImplementationOnce(async (options) => {
		expect(options.admissionMode).toBe("account");
		expect(options.capability).toBeUndefined();
		await options.onBrowserStart(url, metadata);
		expect(mocks.log.success).not.toHaveBeenCalled();
		return {
			kind: "adopted",
			identityId: "verified-identity",
			bindingId: "verified-binding",
			groups: ["group"],
		};
	});
	// Act: account admission remains an interactive, explicitly reviewed resume.
	await parse(account);
	// Assert: only safe local upload instructions precede the verified result.
	expect(process.exitCode).toBeUndefined();
	expect(mocks.enrollOwnerProfile).toHaveBeenCalledOnce();
	expect(mocks.log.message).toHaveBeenCalledWith(
		`${url}\nPrivate request file: ${metadata.requestFile}\nDevice: ${metadata.deviceId}\nLocal fingerprint: ${metadata.fingerprint}`,
		{ output: process.stderr },
	);
	expect(printed()).toMatch(/Upload the private capability-request.json file.*unchanged/);
	expect(printed()).toMatch(/browser confirmation alone does not finish enrollment/);
	expect(printed()).toMatch(/No Team or Project access is added/);
	expect(mocks.log.success).toHaveBeenCalledExactlyOnceWith(
		expect.stringContaining("Verified coordinator Identity: verified-identity"),
		{ output: process.stderr },
	);
	expect(mocks.execFile).not.toHaveBeenCalled();
	expect(stdout).not.toHaveBeenCalled();
	expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});

it("refuses account handoff without the required upload metadata and never claims completion", async () => {
	// Arrange: an incomplete callback must not be confused with browser success.
	mocks.enrollOwnerProfile.mockImplementationOnce(async (options) => {
		await options.onBrowserStart("https://coordinator.example/auth/owner/admit");
		throw new Error("unreachable");
	});
	// Act: invoke account admission with a core callback missing its local evidence.
	await parse(account);
	// Assert: show fixed recovery guidance, not an unusable upload link or success.
	expect(process.exitCode).toBe(1);
	expect(mocks.log.message).not.toHaveBeenCalled();
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(mocks.log.error).toHaveBeenCalledOnce();
});

it.each([
	["--prepare", "--account-admission"],
	["--prepare", "--account-admission", "--json"],
	["--prepare", "--resume", "--account-admission"],
	["--account-admission"],
	["--resume", "--account-admission"],
	[...account, "--capability", "private-capability"],
	[...account, "--capability", ""],
	[...account, "--json"],
])("rejects incompatible account CLI combination %# before profile reads", async (...args) => {
	// Arrange: intercept JSON usage output as well as interactive diagnostics.
	const json = vi.spyOn(console, "log").mockImplementation(() => {});
	// Act: validate account mode selectors before resolving any profile.
	await parse(args);
	// Assert: no database/config/key work or enrollment can start.
	expect(process.exitCode).toBe(2);
	expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
	expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
	expect(mocks.resolveDbPath).not.toHaveBeenCalled();
	expect(mocks.resolveKeyPaths).not.toHaveBeenCalled();
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(printed()).not.toContain("private-capability");
	if (args.includes("--json")) {
		expect(json).toHaveBeenCalledOnce();
		expect(JSON.parse(String(json.mock.calls[0]?.[0]))).toMatchObject({ error: "usage_error" });
		expect(mocks.log.error).not.toHaveBeenCalled();
	} else expect(mocks.log.error).toHaveBeenCalledOnce();
});

it.each([{ selector: [] }, { selector: ["--account-admission"] }])(
	"rejects non-TTY resume without falling back to another admission mode ($selector)",
	async ({ selector }) => {
		// Arrange: a pipe cannot receive a private interactive enrollment ceremony.
		Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
		// Act: try both the default operator path and explicit account admission.
		await parse([...resume, ...selector]);
		// Assert: account mode does not bypass the existing interactive requirement.
		expect(process.exitCode).toBe(2);
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
	},
);

it.each([false, true])(
	"keeps prepare available without a TTY, with JSON=%j and default operator compatibility",
	async (json) => {
		// Arrange: prepare publishes only a review, never browser-start secrets.
		Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: false });
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const result = {
			kind: "prepared",
			review: {
				actorId: "local:device",
				deviceId: "device",
				publicKey: "public",
				localMemoryCount: 1,
				retainedForeignMemoryCount: 1,
			},
			reviewDigest: preparedReviewDigest,
			requestFile: "private-request.json",
		};
		mocks.enrollOwnerProfile.mockResolvedValueOnce(result);
		// Act: the account flag is unnecessary and prohibited until resume.
		await parse(json ? ["--prepare", "--json"] : ["--prepare"]);
		// Assert: the default admission selector and prepare output retain compatibility.
		expect(process.exitCode).toBeUndefined();
		expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				mode: "prepare",
				admissionMode: "operator",
				capability: undefined,
			}),
		);
		expect(mocks.log.success).not.toHaveBeenCalled();
		if (json) {
			expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject(result);
			expect(mocks.log.message).not.toHaveBeenCalled();
		} else {
			expect(stdout).not.toHaveBeenCalled();
			expect(printed()).toContain("upload during --resume --account-admission");
		}
	},
);

it("keeps omitted account selection on the original operator browser path", async () => {
	// Arrange: the default operator callback still accepts its original URL-only API.
	const url = "https://coordinator.example/auth/owner/start?start_code=private-code";
	mocks.enrollOwnerProfile.mockImplementationOnce(async (options) => {
		expect(options.admissionMode).toBe("operator");
		expect(options.capability).toBe("private-capability");
		await options.onBrowserStart(url);
		return {
			kind: "adopted",
			identityId: "verified-identity",
			bindingId: "binding",
			groups: ["group"],
		};
	});
	// Act: use the old flags with no account selector.
	await parse([...resume, "--capability", "private-capability"]);
	// Assert: URL-only delivery remains available and capability stays out of output.
	expect(process.exitCode).toBeUndefined();
	expect(mocks.log.message).toHaveBeenCalledWith(url, { output: process.stderr });
	expect(printed()).not.toContain("private-capability");
	expect(printed()).not.toContain("Private request file:");
	expect(mocks.execFile).not.toHaveBeenCalled();
});

it.each(["unclassified", "fresh_prepare_required", "retained_request_incomplete"])(
	"redacts account errors for %s and removes signal handlers",
	async (code) => {
		// Arrange: neither arbitrary nor classified exception messages are trusted output.
		const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
		const error =
			code === "unclassified"
				? new Error("unsafe")
				: new OwnerProfileEnrollmentError(
						code as "fresh_prepare_required" | "retained_request_incomplete",
					);
		error.message = "private-browser-code completion-secret provider-token";
		mocks.enrollOwnerProfile.mockRejectedValueOnce(error);
		// Act: failures after account selection still use the fixed recovery vocabulary.
		await parse(account);
		// Assert: never print transport/provider details or a verified identity.
		expect(process.exitCode).toBe(1);
		expect(mocks.log.error).toHaveBeenCalledOnce();
		expect(printed()).not.toMatch(/private-browser-code|completion-secret|provider-token/);
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
	},
);

it.each(["SIGINT", "SIGTERM"] as const)(
	"cancels account enrollment on %s without reporting browser confirmation as success",
	async (signal) => {
		// Arrange: mock core observes the actual cancellation signal passed by the CLI.
		mocks.enrollOwnerProfile.mockImplementationOnce(async (options) => {
			expect(options.signal.aborted).toBe(false);
			process.emit(signal);
			expect(options.signal.aborted).toBe(true);
			throw new OwnerProfileEnrollmentError("fresh_prepare_required");
		});
		// Act: interrupt the interactive account resume without sending an OS signal.
		await parse(account);
		// Assert: cancellation is failure, not a successful owner assignment.
		expect(process.exitCode).toBe(1);
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(mocks.log.error).toHaveBeenCalledOnce();
	},
);
