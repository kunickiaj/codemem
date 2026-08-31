import { describe, expect, it } from "vitest";
import {
	projectIdentitySummaryGroups,
	stableProjectPresentationLabels,
} from "./project-identity-presentation";

describe("Project identity presentation", () => {
	it("assigns privacy-safe same-label ordinals by canonical identity regardless of input order", () => {
		const privatePath = "/private/worktrees/codemem";
		const privateRemote = "ssh://git@private.example.test/codemem.git";
		const items = [
			{ canonicalId: privateRemote, displayName: "codemem" },
			{ canonicalId: privatePath, displayName: "codemem" },
		];

		const forward = stableProjectPresentationLabels(items);
		const reversed = stableProjectPresentationLabels([...items].reverse());

		expect([...forward]).toEqual([...reversed]);
		expect(forward.get(privatePath)).toBe("codemem — duplicate name 1 of 2");
		expect(forward.get(privateRemote)).toBe("codemem — duplicate name 2 of 2");
		expect(JSON.stringify([...forward.values()])).not.toContain(privatePath);
		expect(JSON.stringify([...forward.values()])).not.toContain(privateRemote);
	});

	it("labels large same-name groups without changing deterministic ordinals", () => {
		const itemCount = 10_000;
		const items = Array.from({ length: itemCount }, (_, index) => ({
			canonicalId: `project-${index.toString().padStart(5, "0")}`,
			displayName: "codemem",
		}));

		const labels = stableProjectPresentationLabels(items);

		expect(labels.size).toBe(itemCount);
		expect(labels.get("project-00000")).toBe(`codemem — duplicate name 1 of ${itemCount}`);
		expect(labels.get("project-05000")).toBe(`codemem — duplicate name 5001 of ${itemCount}`);
		expect(labels.get("project-09999")).toBe(`codemem — duplicate name 10000 of ${itemCount}`);
	});

	it("groups distinct canonical identities without merging their exact count", () => {
		expect(
			projectIdentitySummaryGroups([
				{ canonicalId: "project-c", displayName: "codemem" },
				{ canonicalId: "project-a", displayName: "codemem" },
				{ canonicalId: "project-b", displayName: "API" },
			]),
		).toEqual([
			{ displayName: "API", identityCount: 1 },
			{ displayName: "codemem", identityCount: 2 },
		]);
	});

	it("groups visually equivalent Unicode labels while preserving exact identities", () => {
		const labels = stableProjectPresentationLabels([
			{ canonicalId: "project-a", displayName: "codemem" },
			{ canonicalId: "project-b", displayName: "code\u200Bmem" },
		]);

		expect(labels.get("project-a")).toBe("codemem — duplicate name 1 of 2");
		expect(labels.get("project-b")).toBe("code\u200Bmem — duplicate name 2 of 2");
	});

	it("keeps emoji ZWJ sequences distinct from adjacent emoji", () => {
		const labels = stableProjectPresentationLabels([
			{ canonicalId: "project-a", displayName: "👩‍💻" },
			{ canonicalId: "project-b", displayName: "👩💻" },
		]);

		expect(labels.get("project-a")).toBe("👩‍💻");
		expect(labels.get("project-b")).toBe("👩💻");
	});

	it("keeps ZWNJ-shaped labels distinct from their joined spelling", () => {
		const labels = stableProjectPresentationLabels([
			{ canonicalId: "project-a", displayName: "می‌روم" },
			{ canonicalId: "project-b", displayName: "میروم" },
		]);

		expect(labels.get("project-a")).toBe("می‌روم");
		expect(labels.get("project-b")).toBe("میروم");
	});
});
