import { expect, it, vi } from "vitest";
import {
	mocks,
	OwnerProfileEnrollmentError,
	parse,
	preparedReviewDigest,
} from "./coordinator-enroll-owner.test-fixture.js";

it("requires a prepare or explicit reviewed resume instead of silently assigning Identity", async () => {
	// Arrange: the fixture provides a configured profile but no selected mode.
	// Act: invoke enrollment without acknowledging a review.
	await parse([]);
	// Assert: usage validation prevents enrollment.
	expect(process.exitCode).toBe(2);
	expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
});
it("passes explicit capability without printing it and displays only verified receipt Identity", async () => {
	// Arrange: retain listener counts before a reviewed resume.
	const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
	// Act: supply the exact acknowledgement and private capability.
	await parse([
		"--resume",
		"--review-digest",
		preparedReviewDigest,
		"--capability",
		"private-capability",
	]);
	// Assert: core receives secrets, while output contains only the verified receipt.
	expect(mocks.enrollOwnerProfile).toHaveBeenCalledWith(
		expect.objectContaining({
			mode: "resume",
			capability: "private-capability",
			reviewedDigest: preparedReviewDigest,
			dbPath: "fixture.sqlite",
			configPath: "fixture-config.json",
		}),
	);
	expect(mocks.log.success).toHaveBeenCalledWith(
		expect.stringContaining("Verified coordinator Identity: verified-identity"),
		{ output: process.stderr },
	);
	expect(JSON.stringify(Object.values(mocks.log).flatMap((log) => log.mock.calls))).not.toContain(
		"private-capability",
	);
	expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});
it("sanitizes credential-bearing operation failures without reporting an Identity", async () => {
	// Arrange: the operation rejects with credential-bearing exception text.
	mocks.enrollOwnerProfile.mockRejectedValueOnce(new Error("private-capability"));
	// Act: resume with a valid review and private capability.
	await parse([
		"--resume",
		"--review-digest",
		preparedReviewDigest,
		"--capability",
		"private-capability",
	]);
	// Assert: failure output does not disclose credentials or claim success.
	expect(process.exitCode).toBe(1);
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain("private-capability");
});
it("displays the private browser link without a launcher or credential-bearing child process", async () => {
	// Arrange: no browser launcher is available; the ceremony still completes manually.
	vi.stubEnv("PATH", "");
	const privateUrl = "https://coordinator.example/auth/owner/start?start_code=private-browser-code";
	mocks.enrollOwnerProfile.mockImplementationOnce(async (options) => {
		await options.onBrowserStart(privateUrl);
		expect(mocks.log.success).not.toHaveBeenCalled();
		return {
			kind: "adopted",
			identityId: "verified-identity",
			bindingId: "binding",
			groups: ["group"],
		};
	});

	// Act: resume an admitted request and use the displayed link.
	await parse([
		"--resume",
		"--review-digest",
		preparedReviewDigest,
		"--capability",
		"private-capability",
	]);

	// Assert: launcher absence neither burns the attempt nor puts secrets in argv.
	expect(process.exitCode).toBeUndefined();
	expect(mocks.execFile).not.toHaveBeenCalled();
	expect(mocks.log.message).toHaveBeenCalledWith(privateUrl, { output: process.stderr });
	expect(mocks.log.success).toHaveBeenCalled();
});
it.each(["prepare", "resume"])("warns to stop profile writers before %s starts", async (mode) => {
	// Arrange: inspect the warning before the core operation can publish any request.
	mocks.enrollOwnerProfile.mockImplementationOnce(async () => {
		const warnings = JSON.stringify(mocks.log.warn.mock.calls);
		expect(warnings).toMatch(/stop/i);
		expect(warnings).toMatch(/capture/i);
		expect(warnings).toMatch(/viewer/i);
		expect(warnings).toMatch(/sync/i);
		expect(warnings).toMatch(/verif/i);
		throw new Error("operation interrupted");
	});

	// Act: both review and adoption need a quiet profile until verified completion.
	await parse(
		mode === "prepare" ? ["--prepare"] : ["--resume", "--review-digest", preparedReviewDigest],
	);

	// Assert: interruption must not report a verified Identity.
	expect(mocks.enrollOwnerProfile).toHaveBeenCalledOnce();
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(process.exitCode).toBe(1);
});
it.each([
	{ code: "fresh_prepare_required" as const, instruction: /--prepare.*NEW --state-dir/ },
	{
		code: "retained_request_incomplete" as const,
		instruction: /retry --resume.*exact finalization/,
	},
])(
	"shows safe recovery instructions for $code without forwarding error text",
	async ({ code, instruction }) => {
		// Arrange: even classified errors cannot supply credential-bearing display text.
		const error = new OwnerProfileEnrollmentError(code);
		error.message = "private-capability private-browser-code";
		mocks.enrollOwnerProfile.mockRejectedValueOnce(error);

		// Act: surface the appropriate recovery branch, not the original exception.
		await parse([
			"--resume",
			"--review-digest",
			preparedReviewDigest,
			"--capability",
			"private-capability",
		]);

		// Assert: only fixed instructions are shown; no successful Identity is claimed.
		const errors = JSON.stringify(mocks.log.error.mock.calls);
		expect(errors).toMatch(instruction);
		expect(errors).toMatch(/unchanged/);
		expect(errors).not.toContain("private-capability");
		expect(errors).not.toContain("private-browser-code");
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	},
);
it("supports structured prepare review without browser-start secrets", async () => {
	// Arrange: capture structured output from a prepared review.
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	mocks.enrollOwnerProfile.mockResolvedValueOnce({
		kind: "prepared",
		review: {
			deviceId: "device",
			publicKey: "public",
			actorId: "local:device",
			captureId: "capture",
			captureAssociation: "pending",
			localMemoryCount: 2,
			retainedForeignMemoryCount: 1,
		},
		reviewDigest: preparedReviewDigest,
		requestFile: "private-request.json",
	});
	// Act: prepare without starting the browser ceremony.
	await parse(["--prepare", "--json"]);
	// Assert: structured review output does not claim verified adoption.
	expect(mocks.enrollOwnerProfile).toHaveBeenCalledWith(
		expect.objectContaining({ mode: "prepare", capability: undefined }),
	);
	expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
		kind: "prepared",
		reviewDigest: preparedReviewDigest,
	});
	expect(mocks.log.success).not.toHaveBeenCalled();
});
it("reports a missing coordinator as a structured prepare usage error without starting enrollment", async () => {
	// Arrange: valid prepare mode reaches config validation before any retained request exists.
	mocks.readCoordinatorSyncConfig.mockReturnValueOnce({});
	const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
	const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

	// Act: prepare with structured output and no configured coordinator.
	await parse(["--prepare", "--json"]);

	// Assert: configuration mistakes require a URL, not retained-artifact recovery.
	expect(process.exitCode).toBe(2);
	expect(stdout).toHaveBeenCalledOnce();
	expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
		error: "usage_error",
		message: expect.stringContaining("--coordinator"),
	});
	expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
	expect(mocks.resolveDbPath).not.toHaveBeenCalled();
	expect(mocks.log.error).not.toHaveBeenCalled();
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect(String(stdout.mock.calls[0]?.[0])).not.toMatch(/retained|review_required|unchanged/i);
	expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});
it("reports a missing coordinator on stderr for a valid interactive reviewed resume", async () => {
	// Arrange: a valid reviewed resume must not fall into enrollment recovery for missing config.
	mocks.readCoordinatorSyncConfig.mockReturnValueOnce({});
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

	// Act: resume interactively with the required review digest.
	await parse(["--resume", "--review-digest", preparedReviewDigest]);

	// Assert: stderr gives actionable URL guidance and no operation or success is claimed.
	expect(process.exitCode).toBe(2);
	expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(
		expect.stringContaining("--coordinator"),
		{ output: process.stderr },
	);
	expect(JSON.stringify(mocks.log.error.mock.calls)).not.toMatch(
		/retained|review_required|unchanged/i,
	);
	expect(stdout).not.toHaveBeenCalled();
	expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
	expect(mocks.resolveDbPath).not.toHaveBeenCalled();
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});
it.each(["prepare", "resume"])(
	"accepts an explicit coordinator with missing config during %s",
	async (mode) => {
		// Arrange: CLI URL overrides absent configuration without touching a real profile.
		mocks.readCoordinatorSyncConfig.mockReturnValueOnce({});
		const args =
			mode === "prepare" ? ["--prepare"] : ["--resume", "--review-digest", preparedReviewDigest];

		// Act: provide the actionable option suggested by the usage error.
		await parse([...args, "--coordinator", "https://explicit.example"]);

		// Assert: valid modes still enter the ordinary enrollment path.
		expect(process.exitCode).toBeUndefined();
		expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ coordinatorUrl: "https://explicit.example", mode }),
		);
		expect(mocks.log.error).not.toHaveBeenCalled();
	},
);
it("keeps ordinary enrollment failures as sanitized operational JSON errors", async () => {
	// Arrange: config is valid, but the core operation fails with unsafe exception text.
	mocks.enrollOwnerProfile.mockRejectedValueOnce(new Error("private-capability"));
	const stdout = vi.spyOn(console, "log").mockImplementation(() => {});

	// Act: prepare reaches the operation rather than the usage validation branch.
	await parse(["--prepare", "--json"]);

	// Assert: operation failures retain exit 1 and their existing recovery classification.
	expect(process.exitCode).toBe(1);
	expect(mocks.enrollOwnerProfile).toHaveBeenCalledOnce();
	expect(stdout).toHaveBeenCalledOnce();
	expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({
		error: "review_required",
	});
	expect(String(stdout.mock.calls[0]?.[0])).not.toContain("private-capability");
	expect(mocks.log.success).not.toHaveBeenCalled();
});
it.each([
	{ args: ["--prepare", "--resume"] },
	{ args: ["--prepare", "--capability", "private"] },
	{ args: ["--resume", "--review-digest", preparedReviewDigest, "--json"] },
])("rejects invalid mode combination $args", async ({ args }) => {
	// Arrange: capture output while supplying an incompatible mode combination.
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	// Act: validate modes before opening a profile.
	await parse(args);
	// Assert: invalid modes cannot enter enrollment.
	expect(process.exitCode).toBe(2);
	expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
});
