import { expect, it, vi } from "vitest";
import {
	forbiddenOverrides,
	mocks,
	parse,
	preparedReviewDigest,
} from "./coordinator-enroll-owner.test-fixture.js";

it.each(
	forbiddenOverrides.flatMap((variable) =>
		["", "https://private-override.example/private-group"].flatMap((value) =>
			[false, true].flatMap((explicitCoordinator) =>
				["prepare", "resume"].map((mode) => ({
					variable,
					value,
					explicitCoordinator,
					mode,
				})),
			),
		),
	),
)(
	"rejects defined $variable='$value' before $mode resolution (explicit coordinator: $explicitCoordinator)",
	async ({ variable, value, explicitCoordinator, mode }) => {
		// Arrange: valid modes must reject even empty overrides before any profile/state work.
		vi.stubEnv(variable, value);
		const json = vi.spyOn(console, "log").mockImplementation(() => {});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
		const args =
			mode === "prepare"
				? ["--prepare", "--json"]
				: [
						"--resume",
						"--review-digest",
						preparedReviewDigest,
						"--capability",
						"private-capability",
					];
		if (explicitCoordinator) args.push("--coordinator", "https://explicit-private.example");
		args.push("--state-dir", "private-state", "--config", "private-config");

		// Act: an explicit coordinator cannot bypass the forbidden environment preflight.
		await parse(args);

		// Assert: emit only actionable usage guidance, never retained-request retry guidance.
		expect(process.exitCode).toBe(2);
		let message: string;
		if (mode === "prepare") {
			expect(json).toHaveBeenCalledOnce();
			const payload = JSON.parse(String(json.mock.calls[0]?.[0]));
			expect(payload.error).toBe("usage_error");
			message = payload.message;
			expect(mocks.log.error).not.toHaveBeenCalled();
		} else {
			expect(json).not.toHaveBeenCalled();
			expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
				output: process.stderr,
			});
			message = String(mocks.log.error.mock.calls[0]?.[0]);
		}
		expect(message).toContain(variable);
		expect(message).toMatch(/unset/i);
		expect(message).not.toMatch(/retry|retained|review_required|unchanged|NEW --state-dir/i);
		const output = JSON.stringify([
			json.mock.calls,
			stdout.mock.calls,
			...Object.values(mocks.log).map((log) => log.mock.calls),
		]);
		expect(output).not.toMatch(
			/private-override|private-group|explicit-private|private-digest|private-capability|private-state|private-config/,
		);
		expect(output).not.toContain(preparedReviewDigest);
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
it.each(
	["keychain", " KEYCHAIN ", "\tKeyChain\n"].flatMap((value) =>
		["prepare", "resume"].map((mode) => ({ value, mode })),
	),
)("rejects keychain spelling $value before $mode profile resolution", async ({ value, mode }) => {
	// Arrange: a valid mode and explicit profile options cannot bypass keychain rejection.
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", value);
	const json = vi.spyOn(console, "log").mockImplementation(() => {});
	const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
	const args =
		mode === "prepare"
			? ["--prepare", "--json"]
			: ["--resume", "--review-digest", preparedReviewDigest];

	// Act: reject before resolving any config, database, keys or retained request.
	await parse([...args, "--coordinator", "https://explicit.example", "--keys-dir", "private-keys"]);

	// Assert: preserve existing keys rather than suggesting copying or generating replacements.
	expect(process.exitCode).toBe(2);
	const output = JSON.stringify([
		json.mock.calls,
		...Object.values(mocks.log).map((log) => log.mock.calls),
	]);
	expect(output).toContain("CODEMEM_SYNC_KEY_STORE");
	expect(output).toMatch(/signing keys unchanged/);
	expect(output).toMatch(/supported existing file-key profile/);
	expect(output).not.toMatch(/copy|generat|private-keys|review_required|retry/);
	if (mode === "prepare") {
		expect(JSON.parse(String(json.mock.calls[0]?.[0])).error).toBe("usage_error");
		expect(mocks.log.error).not.toHaveBeenCalled();
	} else {
		expect(json).not.toHaveBeenCalled();
		expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
			output: process.stderr,
		});
	}
	expect(mocks.resolveCodememConfigPath).not.toHaveBeenCalled();
	expect(mocks.readCodememConfigFileAtPath).not.toHaveBeenCalled();
	expect(mocks.readCoordinatorSyncConfig).not.toHaveBeenCalled();
	expect(mocks.resolveDbPath).not.toHaveBeenCalled();
	expect(mocks.resolveKeyPaths).not.toHaveBeenCalled();
	expect(mocks.enrollOwnerProfile).not.toHaveBeenCalled();
	expect(mocks.execFile).not.toHaveBeenCalled();
	expect(stdout).not.toHaveBeenCalled();
	expect(mocks.log.warn).not.toHaveBeenCalled();
	expect(mocks.log.success).not.toHaveBeenCalled();
	expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(listeners);
});
it.each(["", "file", " FILE "])("allows non-keychain key store %s", async (value) => {
	// Arrange: file-key profiles do not need environment migration.
	vi.stubEnv("CODEMEM_SYNC_KEY_STORE", value);

	// Act: prepare with a supported existing profile.
	await parse(["--prepare"]);

	// Assert: the normal enrollment path remains available.
	expect(process.exitCode).toBeUndefined();
	expect(mocks.enrollOwnerProfile).toHaveBeenCalledOnce();
	expect(mocks.log.error).not.toHaveBeenCalled();
});
it.each(
	[
		"http://coordinator.example",
		"https://private-user:private-password@coordinator.example",
		"https://private-user@coordinator.example",
		"https://coordinator.example/private-provider/path",
		"private-invalid-text",
		"ws://coordinator.example",
		" https://coordinator.example",
		"https://coordinator.example ",
		"https://coordinator.\nexample",
		"https://coordinator.example?provider=private-provider",
		"https://coordinator.example#private-provider",
		"https://COORDINATOR.example",
		"https://coordinator.example:443",
	].flatMap((value) =>
		["explicit", "config"].flatMap((source) =>
			["prepare", "resume"].map((mode) => ({ value, source, mode })),
		),
	),
)(
	"rejects noncanonical origin $value from $source during $mode",
	async ({ value, source, mode }) => {
		// Arrange: selected config and explicit CLI values share the same origin contract.
		mocks.readCoordinatorSyncConfig.mockReturnValueOnce({ syncCoordinatorUrl: value });
		const json = vi.spyOn(console, "log").mockImplementation(() => {});
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const listeners = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
		const args =
			mode === "prepare"
				? ["--prepare", "--json"]
				: ["--resume", "--review-digest", preparedReviewDigest];
		if (source === "explicit") args.push("--coordinator", value);

		// Act: reject malformed/credential-bearing origins before opening a profile.
		await parse([...args, "--config", "selected-config", "--state-dir", "private-state"]);

		// Assert: usage guidance reveals no supplied credentials or provider metadata.
		expect(process.exitCode).toBe(2);
		const output = JSON.stringify([
			json.mock.calls,
			...Object.values(mocks.log).map((log) => log.mock.calls),
		]);
		expect(output).toMatch(/--coordinator/);
		expect(output).toMatch(/sync_coordinator_url/);
		expect(output).toMatch(/HTTPS origin/);
		expect(output).not.toMatch(/private-|review_required|retry|retained/);
		if (mode === "prepare") {
			expect(JSON.parse(String(json.mock.calls[0]?.[0])).error).toBe("usage_error");
			expect(mocks.log.error).not.toHaveBeenCalled();
		} else {
			expect(json).not.toHaveBeenCalled();
			expect(mocks.log.error).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
				output: process.stderr,
			});
		}
		expect(mocks.resolveCodememConfigPath).toHaveBeenCalledWith("selected-config", "write");
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
	[
		"https://coordinator.example",
		"https://coordinator.example/",
		"https://coordinator.example:8443",
		"https://[::1]:8443/",
	].flatMap((value) =>
		["explicit", "config"].flatMap((source) =>
			["prepare", "resume"].map((mode) => ({ value, source, mode })),
		),
	),
)(
	"accepts canonical HTTPS origin $value from $source during $mode",
	async ({ value, source, mode }) => {
		// Arrange: canonical ports, IPv6 hosts and a single trailing slash are valid origins.
		mocks.readCoordinatorSyncConfig.mockReturnValueOnce({ syncCoordinatorUrl: value });
		const args =
			mode === "prepare" ? ["--prepare"] : ["--resume", "--review-digest", preparedReviewDigest];
		if (source === "explicit") args.push("--coordinator", value);

		// Act: prepare or resume with the selected origin.
		await parse(args);

		// Assert: valid origins are passed unchanged, not classified as review failures.
		expect(process.exitCode).toBeUndefined();
		expect(mocks.enrollOwnerProfile).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ coordinatorUrl: value }),
		);
		expect(mocks.log.error).not.toHaveBeenCalled();
	},
);
