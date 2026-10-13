import { expect, it, vi } from "vitest";
import {
	mocks,
	OwnerProfileEnrollmentError,
	parse,
	preparedReviewDigest,
} from "./coordinator-enroll-owner.test-fixture.js";

it.each(
	[
		{ label: "spaces", digest: " " },
		{ label: "tab", digest: "\t" },
		{ label: "leading space", digest: ` ${preparedReviewDigest}` },
		{ label: "trailing space", digest: `${preparedReviewDigest} ` },
		{ label: "truncated", digest: preparedReviewDigest.slice(1) },
		{ label: "nonhex", digest: `${preparedReviewDigest.slice(1)}g` },
		{ label: "uppercase", digest: preparedReviewDigest.toUpperCase() },
		{ label: "65 characters", digest: `${preparedReviewDigest}0` },
		{ label: "oversized", digest: "a".repeat(4096) },
		{ label: "leading newline", digest: `\n${preparedReviewDigest}` },
		{ label: "trailing newline", digest: `${preparedReviewDigest}\n` },
		{ label: "embedded newline", digest: `${preparedReviewDigest.slice(1)}\n` },
		{ label: "private userinfo", digest: "https://private-user:private-password@example.test" },
	].flatMap((value) =>
		[false, true].map((conflictingEnvironment) => ({ ...value, conflictingEnvironment })),
	),
)(
	"rejects $label review digest before environment/profile work (conflict: $conflictingEnvironment)",
	async ({ digest, conflictingEnvironment }) => {
		// Arrange: syntax errors must take priority over private environment/profile conflicts.
		if (conflictingEnvironment) {
			vi.stubEnv("CODEMEM_ACTOR_ID", "private-actor");
			vi.stubEnv("CODEMEM_DB", "private-environment.sqlite");
		}
		const json = vi.spyOn(console, "log").mockImplementation(() => {});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

		// Act: reject a malformed acknowledgement without consuming the prepared attempt.
		await parse([
			"--resume",
			"--review-digest",
			digest,
			"--capability",
			"private-capability",
			"--config",
			"private-config",
			"--keys-dir",
			"private-keys",
			"--state-dir",
			"private-state",
			"--coordinator",
			"https://private-user:private-password@coordinator.example",
		]);

		// Assert: only fixed, actionable syntax guidance is emitted; core owns saved state.
		expect(process.exitCode).toBe(2);
		expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(
			"Supply --review-digest as the exact 64-character lowercase hexadecimal digest from --prepare. Enrollment has not started.",
			{ output: process.stderr },
		);
		const output = JSON.stringify(Object.values(mocks.log).flatMap((log) => log.mock.calls));
		expect(output).not.toContain(preparedReviewDigest);
		expect(output).not.toMatch(/private-|CODEMEM_ACTOR_ID|CODEMEM_DB|retry|review_required/);
		expect(json).not.toHaveBeenCalled();
		expect(stdout).not.toHaveBeenCalled();
		expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
		expect(mocks.readCodememConfigFileAtPath).not.toHaveBeenCalled();
		expect(mocks.readCoordinatorSyncConfig).not.toHaveBeenCalled();
		expect(mocks.resolveDbPath).not.toHaveBeenCalled();
		expect(mocks.resolveKeyPaths).not.toHaveBeenCalled();
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(mocks.log.warn).not.toHaveBeenCalled();
		expect(mocks.log.message).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
	},
);
it.each(["0".repeat(64), "f".repeat(64), preparedReviewDigest])(
	"passes a canonical reviewed digest unchanged during interactive resume (case %#)",
	async (reviewedDigest) => {
		// Arrange: admission checks format only; the retained review is verified by core.
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);

		// Act: resume with a valid lowercase SHA-256 acknowledgement.
		await parse(["--resume", "--review-digest", reviewedDigest]);

		// Assert: no normalization or digest disclosure occurs in the CLI.
		expect(process.exitCode).toBeUndefined();
		expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ mode: "resume", reviewedDigest }),
		);
		expect(mocks.log.error).not.toHaveBeenCalled();
		expect(stdout).not.toHaveBeenCalled();
		expect(JSON.stringify(Object.values(mocks.log).flatMap((log) => log.mock.calls))).not.toContain(
			reviewedDigest,
		);
	},
);
it("keeps a canonical but nonmatching review digest as a core operational conflict", async () => {
	// Arrange: core, not CLI syntax validation, checks the retained review snapshot.
	const reviewedDigest = "f".repeat(64);
	const error = new OwnerProfileEnrollmentError("review_required");
	error.message = `${reviewedDigest} private-capability private-actor private-user:private-password`;
	mocks.enrollOwnerProfile.mockRejectedValueOnce(error);

	// Act: a format-valid acknowledgement enters core even when the saved review differs.
	await parse([
		"--resume",
		"--review-digest",
		reviewedDigest,
		"--capability",
		"private-capability",
	]);

	// Assert: preserve the operational failure classification and fixed recovery guidance.
	expect(process.exitCode).toBe(1);
	expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ reviewedDigest, mode: "resume" }),
	);
	expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(
		new OwnerProfileEnrollmentError("review_required").message,
		{ output: process.stderr },
	);
	expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain(reviewedDigest);
	expect(JSON.stringify(mocks.log.error.mock.calls)).not.toContain("private-");
	expect(mocks.log.success).not.toHaveBeenCalled();
});
it.each([undefined, ""])(
	"keeps a missing review digest as a resume mode usage error (case %#)",
	async (digest) => {
		// Arrange: omitted and explicitly empty acknowledgements cannot resume an attempt.
		const args = ["--resume"];
		if (digest !== undefined) args.push("--review-digest", digest);

		// Act: request resume without acknowledging a prepared review.
		await parse(args);

		// Assert: existing mode guidance remains actionable before any profile is opened.
		expect(process.exitCode).toBe(2);
		expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("Use --prepare first"),
			{ output: process.stderr },
		);
		expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
	},
);
it.each([preparedReviewDigest, "malformed"])(
	"forbids a review digest with prepare regardless of format (case %#)",
	async (digest) => {
		// Arrange: prepare produces a review and cannot acknowledge one, even if canonical.
		const json = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act: supply an acknowledgement in structured prepare mode.
		await parse(["--prepare", "--json", "--review-digest", digest]);

		// Assert: mode rules precede digest syntax and do not open the selected profile.
		expect(process.exitCode).toBe(2);
		expect(JSON.parse(String(json.mock.calls[0]?.[0]))).toEqual({
			error: "usage_error",
			message: expect.stringContaining("Use --prepare first"),
		});
		expect(json).toHaveBeenCalledOnce();
		expect(mocks.log.error).not.toHaveBeenCalled();
		expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
	},
);
it.each([
	{ label: "empty", capability: "" },
	{ label: "spaces", capability: " " },
	{ label: "tab", capability: "\t" },
	{ label: "padded", capability: " private-capability " },
	{ label: "unsupported", capability: "private/capability" },
	{ label: "over limit", capability: "x".repeat(513) },
])(
	"rejects $label capability before resolving or consuming a reviewed attempt",
	async ({ capability }) => {
		// Arrange: a valid interactive resume isolates capability syntax from mode validation.
		const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

		// Act: a typo must be recoverable without entering the core operation.
		await parse(["--resume", "--review-digest", preparedReviewDigest, "--capability", capability]);

		// Assert: fixed usage guidance neither reveals the token nor consumes saved state.
		expect(process.exitCode).toBe(2);
		expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("prepared attempt has not been consumed"),
			{ output: process.stderr },
		);
		expect(JSON.stringify(Object.values(mocks.log).flatMap((log) => log.mock.calls))).not.toContain(
			"private-capability",
		);
		expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
		expect(mocks.resolveDbPath).not.toHaveBeenCalled();
		expect(mocks.resolveKeyPaths).not.toHaveBeenCalled();
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
	},
);
it.each(["x", "A._-09", "x".repeat(512)])(
	"passes syntactically valid capability unchanged (case %#)",
	async (capability) => {
		// Arrange: semantic admission verification belongs to the coordinator, not CLI syntax checks.
		const args = ["--resume", "--review-digest", preparedReviewDigest, "--capability", capability];
		// Act: accept both format boundaries with valid reviewed resume context.
		await parse(args);
		// Assert: the exact token reaches core without being printed.
		expect(process.exitCode).toBeUndefined();
		expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ capability }),
		);
		expect(mocks.log.message).not.toHaveBeenCalled();
	},
);
