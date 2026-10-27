import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AccountOwnerAssociationDirectoryError,
	readAccountOwnerAssociationDirectory,
	retainAccountOwnerAssociationDirectory,
} from "./account-owner-association-directory.js";

let state: string;
let associations: string;

beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "owner-association-directory-"));
	state = join(root, ".codemem");
	associations = join(state, "account-owner-associations");
	mkdirSync(state, { mode: 0o700 });
});
afterEach(() => {
	rmSync(join(state, ".."), { recursive: true, force: true });
});

function thrown(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}
	throw new Error("Expected an error");
}

describe("account owner association directory checks", () => {
	it("reads a missing association directory under a private state directory as absent", () => {
		expect(readAccountOwnerAssociationDirectory(associations)).toBe(false);
	});

	it.each([
		["group-writable setgid (managed workspace)", 0o2775],
		["world-writable", 0o757],
	])("names the chmod fix when the state directory is %s", (_name, mode) => {
		// Arrange
		chmodSync(state, mode);
		// Act
		const error = thrown(() => readAccountOwnerAssociationDirectory(associations));
		// Assert
		expect(error).toBeInstanceOf(AccountOwnerAssociationDirectoryError);
		expect(error).toMatchObject({
			code: "account_owner_association_directory_unsafe",
			path: state,
			problem: "shared_write",
			message: `${state} is writable by other users. Run \`chmod go-w ${state}\`, then try again.`,
		});
	});

	it("names the chmod fix when the association directory is not private", () => {
		// Arrange
		mkdirSync(associations, { mode: 0o700 });
		chmodSync(associations, 0o750);
		// Act
		const error = thrown(() => retainAccountOwnerAssociationDirectory(associations));
		// Assert
		expect(error).toMatchObject({ path: associations, problem: "not_private" });
		expect((error as Error).message).toContain(`chmod 700 ${associations}`);
	});

	it("accepts the state directory after the suggested chmod", () => {
		// Arrange
		chmodSync(state, 0o2775);
		chmodSync(state, 0o2755);
		// Act
		retainAccountOwnerAssociationDirectory(associations);
		// Assert
		expect(readAccountOwnerAssociationDirectory(associations)).toBe(true);
	});
});
