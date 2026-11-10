import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, expect, it } from "vitest";
import type { ProjectInventoryRecipientViewModel } from "../projects-inventory-model";
import { RecipientSummary } from "./ProjectRow";

afterEach(() => {
	act(() => render(null, document.body));
	document.body.innerHTML = "";
});

it.each([1, 2])("shows %i of 2 known Project entries for each recipient", (coveredProjectCount) => {
	// Arrange: two recipients can have disjoint access, with no universal Team.
	const recipients: ProjectInventoryRecipientViewModel[] = [
		{
			key: "team:studio",
			kind: "Team",
			displayName: "Studio",
			coveredProjectCount,
			knownProjectCount: 2,
		},
		{
			key: "identity:alex",
			kind: "Identity",
			displayName: "Alex",
			coveredProjectCount,
			knownProjectCount: 2,
		},
	];
	// Act
	act(() => render(<RecipientSummary available cluster recipients={recipients} />, document.body));
	// Assert
	expect(document.body.textContent).toContain(
		`Team: Studio · ${coveredProjectCount} of 2 known Project entries`,
	);
	expect(document.body.textContent).toContain(
		`Identity: Alex · ${coveredProjectCount} of 2 known Project entries`,
	);
	expect(document.body.textContent?.includes("Different sharing across entries")).toBe(
		coveredProjectCount === 1,
	);
	expect(document.body.textContent).not.toContain("2 recipients");
});

it("keeps unavailable recipients visible without exposing their identifiers", () => {
	// Arrange
	const recipients: ProjectInventoryRecipientViewModel[] = [
		{
			key: "team:missing",
			kind: "Team",
			displayName: "Unavailable Team",
			coveredProjectCount: 1,
			knownProjectCount: 2,
		},
	];
	// Act
	act(() => render(<RecipientSummary available cluster recipients={recipients} />, document.body));
	// Assert
	expect(document.body.textContent).toContain("Unavailable Team · 1 of 2 known Project entries");
	expect(document.body.textContent).not.toContain("team:missing");
});

it("does not imply complete sharing when recipient coverage is unavailable", () => {
	// Arrange
	const recipients: ProjectInventoryRecipientViewModel[] = [
		{ key: "team:studio", kind: "Team", displayName: "Studio" },
	];
	// Act
	act(() => render(<RecipientSummary available cluster recipients={recipients} />, document.body));
	// Assert
	expect(document.body.textContent).toContain("Team: Studio · Coverage unavailable");
	expect(document.body.textContent).not.toContain("Sharing across known entries");
});

it.each([true, false])(
	"distinguishes empty saved intent from unavailable inventory (%s)",
	(available) => {
		// Arrange
		const recipients: ProjectInventoryRecipientViewModel[] = [];
		// Act
		act(() =>
			render(<RecipientSummary available={available} recipients={recipients} />, document.body),
		);
		// Assert
		expect(document.body.textContent).toBe(
			available ? "No Teams or Identities added" : "Unavailable",
		);
		expect(document.body.textContent).not.toContain("Not shared");
	},
);
