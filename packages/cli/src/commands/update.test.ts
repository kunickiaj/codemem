import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getUpdateStatus } = vi.hoisted(() => ({
	getUpdateStatus: vi.fn(),
}));

vi.mock("@codemem/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@codemem/core")>();
	return {
		...actual,
		getUpdateStatus,
	};
});

import { updateCommand } from "./update.js";

const availableStatus = {
	current_version: "0.40.2",
	latest_version: "0.41.0",
	update_available: true,
	first_seen_at: "2026-08-10T12:00:00.000Z",
	checked_at: "2026-08-10T12:00:00.000Z",
	stale: false,
	install_kind: "npm-global",
	auto_update_eligible: false,
	recommended_action: "npm install -g codemem@0.41.0",
	error: null,
} as const;

const currentStatus = {
	...availableStatus,
	latest_version: "0.40.2",
	update_available: false,
	recommended_action: "No action required; codemem is up to date.",
} as const;

const unavailableStatus = {
	...availableStatus,
	latest_version: null,
	update_available: false,
	first_seen_at: null,
	checked_at: null,
	stale: false,
	install_kind: "unknown",
	recommended_action: "Check network access and try again.",
	error: "registry request timed out",
} as const;

async function parseUpdateCommand(args: string[]): Promise<void> {
	const root = new Command("codemem");
	root.enablePositionalOptions();
	root.addCommand(updateCommand);
	await root.parseAsync(["update", ...args], { from: "user" });
}

afterEach(() => {
	getUpdateStatus.mockReset();
	process.exitCode = undefined;
	vi.restoreAllMocks();
});

describe("update check command", () => {
	it("renders a concise human message for an available release and its guidance", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(availableStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		const output = log.mock.calls.flat().join("\n");
		expect(output).toContain("0.41.0");
		expect(output).toContain("0.40.2");
		expect(output).toContain(availableStatus.recommended_action);
		expect(process.exitCode).toBeUndefined();
	});

	it("renders a human up-to-date message when no newer release exists", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(currentStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		expect(log.mock.calls.flat().join("\n")).toMatch(/0\.40\.2.*up to date/i);
		expect(process.exitCode).toBeUndefined();
	});

	it("qualifies a stale up-to-date human result as cached", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue({
			...currentStatus,
			stale: true,
			error: "registry offline",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		const output = log.mock.calls.flat().join("\n");
		expect(output).toMatch(/up to date/i);
		expect(output).toMatch(/cached|stale/i);
	});

	it("does not tell a human that an unparseable current version is up to date", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue({
			...currentStatus,
			current_version: "development",
			recommended_action: "Verify the current codemem version and try again.",
		});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		const output = log.mock.calls.flat().join("\n");
		expect(output).not.toMatch(/up to date/i);
		expect(output).toMatch(/verify.*current.*version/i);
	});

	it.each([
		{ label: "cache write", warning: "cache write failed: permission denied" },
		{ label: "cache read", warning: "cache read failed: corrupt filesystem entry" },
	])("shows the $label warning in human output", async ({ warning }) => {
		// Arrange
		getUpdateStatus.mockResolvedValue({ ...availableStatus, error: warning });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		expect(log.mock.calls.flat().join("\n")).toContain(warning);
		expect(process.exitCode).toBeUndefined();
	});

	it("emits exactly one stable status object in JSON mode", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(availableStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check", "--json"]);

		// Assert
		expect(log).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(availableStatus);
		expect(error).not.toHaveBeenCalled();
		expect(process.exitCode).toBeUndefined();
	});

	it("passes forced refresh through to release discovery", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(currentStatus);
		vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check", "--refresh", "--json"]);

		// Assert
		expect(getUpdateStatus).toHaveBeenCalledWith(
			expect.objectContaining({ installKind: "unknown", refresh: true }),
		);
	});

	it("treats valid stale status as successful and preserves the status JSON", async () => {
		// Arrange
		const staleStatus = {
			...availableStatus,
			stale: true,
			auto_update_eligible: false,
			error: "registry offline",
		};
		getUpdateStatus.mockResolvedValue(staleStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check", "--json"]);

		// Assert
		expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(staleStatus);
		expect(process.exitCode).toBeUndefined();
	});

	it("returns structured JSON and non-zero status when release status is unavailable", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(unavailableStatus);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check", "--json"]);

		// Assert
		const output = JSON.parse(String(log.mock.calls[0]?.[0]));
		expect(output).toMatchObject({
			error: "update_check_unavailable",
			message: "registry request timed out",
		});
		expect(error).not.toHaveBeenCalled();
		expect(process.exitCode).toBe(1);
	});

	it("returns non-zero human failure when no valid fresh or stale status exists", async () => {
		// Arrange
		getUpdateStatus.mockResolvedValue(unavailableStatus);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		// Act
		await parseUpdateCommand(["check"]);

		// Assert
		expect(error.mock.calls.flat().join("\n")).toContain("registry request timed out");
		expect(process.exitCode).toBe(1);
	});
});
