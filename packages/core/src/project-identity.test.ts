import { describe, expect, it } from "vitest";
import { cleanProjectIdentity, isMalformedProjectIdentity } from "./project-identity.js";

describe("project identity metadata", () => {
	it.each([
		"Command failed: git rev-parse --show-toplevel",
		"error: failed to discover project",
		"fatal: not a git repository",
		"git: 'workspace-id' is not a git command",
		"GitError: fatal: not a git repository",
		"Git command failed: no such remote 'upstream'",
		"valid-project\nfatal: leaked stderr",
	])("rejects command failure output: %s", (value) => {
		expect(isMalformedProjectIdentity(value)).toBe(true);
		expect(cleanProjectIdentity(value)).toBeNull();
	});

	it.each([
		"fatal-error-handler",
		"/tmp/error: logs",
		"git:alpha",
		"project name",
		"/work/not a git repository/demo",
		"no such remote",
	])("preserves valid identity text: %s", (value) => {
		expect(cleanProjectIdentity(` ${value} `)).toBe(value);
	});
});
