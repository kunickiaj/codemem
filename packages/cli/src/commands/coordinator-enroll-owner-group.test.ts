import { expect, it, vi } from "vitest";
import {
	enrollmentModes,
	mocks,
	OwnerProfileEnrollmentError,
	parse,
	parseSelected,
} from "./coordinator-enroll-owner.test-fixture.js";

it.each(
	[
		{ plural: ["private-other-group"], allowed: false },
		{ plural: ["group", "private-other-group"], allowed: false },
		{ plural: "group, private-other-group", allowed: false },
		{ plural: [" group ", ""], allowed: true },
		{ plural: " , group , ", allowed: true },
		{ plural: [], allowed: true },
		{ plural: ["", " \t ", 42], allowed: true },
		{ plural: " , \t , ", allowed: true },
	].flatMap((config) => enrollmentModes.map((mode) => ({ ...config, ...mode }))),
)(
	"reports core plural-group review outcome during $mode (allowed: $allowed, case %#)",
	async ({ plural, allowed, args, mode }) => {
		// Arrange: use the real parser with mocked profile reads; never access a real profile.
		const actual = await vi.importActual<typeof import("@codemem/core")>("@codemem/core");
		const config = {
			sync_coordinator_url: "https://coordinator.example",
			sync_coordinator_group: "group",
			sync_coordinator_groups: plural,
		};
		mocks.readCodememConfigFileAtPath.mockReturnValue(config);
		mocks.readCoordinatorSyncConfig.mockImplementation((selected) =>
			actual.readCoordinatorSyncConfig(selected),
		);
		if (!allowed) {
			const conflict = new OwnerProfileEnrollmentError("review_required");
			conflict.message = "private-other-group private-capability";
			mocks.enrollOwnerProfile.mockRejectedValueOnce(conflict);
		}
		const json = vi.spyOn(console, "log").mockImplementation(() => {});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const selected = [...args];
		if (mode === "interactive resume") selected.push("--capability", "private-capability");
		// Act: config compatibility belongs to core, even with an explicit coordinator.
		await parse([...selected, "--coordinator", "https://coordinator.example"]);
		// Assert: config conflicts are sanitized operational errors; env conflicts remain usage errors.
		if (allowed) {
			expect(process.exitCode).toBeUndefined();
			expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ groupId: "group" }),
			);
		} else {
			expect(process.exitCode).toBe(1);
			expect(mocks.enrollOwnerProfile).toHaveBeenCalledOnce();
			expect(mocks.log.success).not.toHaveBeenCalled();
			if (mode === "prepare JSON")
				expect(JSON.parse(String(json.mock.calls[0]?.[0])).error).toBe("review_required");
			else
				expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
					output: process.stderr,
				});
		}
		expect(config.sync_coordinator_groups).toEqual(plural);
		expect(
			JSON.stringify([
				json.mock.calls,
				stdout.mock.calls,
				...Object.values(mocks.log).map((log) => log.mock.calls),
			]),
		).not.toMatch(/private-other-group|private-capability/);
	},
);
it.each(
	[
		"",
		"x".repeat(257),
		" ",
		" private-group",
		"private-group ",
		"private\ngroup",
		"private\u0000group",
		"private\u007fgroup",
		"private\u200bgroup",
		"private\ud800group",
		"private\udc00group",
	].flatMap((group) => enrollmentModes.map((mode) => ({ group, ...mode }))),
)(
	"rejects invalid group before profile resolution during $mode (case %#)",
	async ({ group, args, mode }) => {
		// Arrange: private arguments must not leak through group validation.
		const json = vi.spyOn(console, "log").mockImplementation(() => {});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

		// Act: even an invalid group with valid mode must stop before resolving paths.
		await parseSelected(group, [
			...args,
			"--config",
			"private-config",
			"--state-dir",
			"private-state",
		]);

		// Assert: fixed usage guidance hides the supplied group and profile details.
		expect(process.exitCode).toBe(2);
		if (mode === "prepare JSON") {
			expect(JSON.parse(String(json.mock.calls[0]?.[0]))).toMatchObject({ error: "usage_error" });
			expect(mocks.log.error).not.toHaveBeenCalled();
		} else {
			expect(json).not.toHaveBeenCalled();
			expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("group ID"), {
				output: process.stderr,
			});
		}
		expect(
			JSON.stringify([json.mock.calls, ...Object.values(mocks.log).map((log) => log.mock.calls)]),
		).not.toContain("private");
		expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
		expect(mocks.readCodememConfigFileAtPath).not.toHaveBeenCalled();
		expect(mocks.readCoordinatorSyncConfig).not.toHaveBeenCalled();
		expect(mocks.resolveDbPath).not.toHaveBeenCalled();
		expect(mocks.resolveKeyPaths).not.toHaveBeenCalled();
		expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
		expect(mocks.execFile).not.toHaveBeenCalled();
		expect(stdout).not.toHaveBeenCalled();
		expect(mocks.log.success).not.toHaveBeenCalled();
		expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
	},
);

it.each(
	["x", "x".repeat(256), "équipe 東京", "group with internal spaces", "group\\nname"].flatMap(
		(group) => enrollmentModes.map((mode) => ({ group, ...mode })),
	),
)("passes valid group unchanged during $mode (case %#)", async ({ group, args }) => {
	// Arrange: valid Unicode, internal spaces and literal escape text are identifiers.
	vi.spyOn(process.stdout, "write").mockReturnValue(true);

	// Act: validate without normalizing the identifier.
	await parseSelected(group, ["--db-path", "fixture.sqlite", ...args]);

	// Assert: the core receives the exact accepted group.
	expect(process.exitCode).toBeUndefined();
	expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
		expect.objectContaining({ groupId: group }),
	);
});
