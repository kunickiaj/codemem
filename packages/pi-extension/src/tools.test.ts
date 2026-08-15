import { describe, expect, it } from "vitest";
import { buildDistillBody, parseCliJson } from "./tools.js";

describe("parseCliJson", () => {
	it("parses a nested top-level object (codex review: lastIndexOf picked the inner object)", () => {
		expect(parseCliJson('{"items":[{"id":1}]}')).toEqual({ items: [{ id: 1 }] });
	});

	it("parses a top-level array", () => {
		expect(parseCliJson('[{"id":1}]')).toEqual([{ id: 1 }]);
	});

	it("parses JSON that follows CLI log lines", () => {
		expect(parseCliJson('info: starting\n{"id":2}')).toEqual({ id: 2 });
	});

	it("returns the raw string when nothing parses", () => {
		expect(parseCliJson("just a log line")).toBe("just a log line");
	});

	it("returns null for empty stdout", () => {
		expect(parseCliJson("  \n ")).toBeNull();
	});
});

describe("buildDistillBody", () => {
	it("omits project when all_projects is true (would otherwise 400: mutually exclusive)", () => {
		const body = buildDistillBody({ all_projects: true, limit: 5 }, "codemem");
		expect("project" in body).toBe(false);
	});

	it("omits project when caller explicitly projects and also asks all_projects", () => {
		const body = buildDistillBody({ all_projects: true, project: "codemem" }, "other");
		expect("project" in body).toBe(false);
	});

	it("fills client project when caller did not supply one", () => {
		const body = buildDistillBody({ limit: 5 }, "codemem");
		expect(body.project).toBe("codemem");
	});

	it("keeps explicit caller project", () => {
		const body = buildDistillBody({ project: "mine" }, "codemem");
		expect(body.project).toBe("mine");
	});
});
