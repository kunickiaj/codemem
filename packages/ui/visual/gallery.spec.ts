import { assertScreenshot, expect, test } from "./fixtures.js";

test("all families include default, disabled, loading and long-label examples", async ({
	page,
}) => {
	// Arrange
	const main = page.getByTestId("gallery-root");
	// Act
	await page.getByTestId("gallery-button-default").click();
	// Assert
	await expect(page.getByTestId("gallery-button-result")).toHaveText("Fixture clicks: 1");
	await expect(page.getByRole("button", { name: "Disabled", exact: true })).toBeDisabled();
	await expect(page.getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-busy", "true");
	await assertScreenshot(main, "all-families.png");
});

test("Radix select opens, skips disabled options and restores focus", async ({ page }) => {
	// Arrange
	const trigger = page.getByRole("combobox", { name: "Radix select default", exact: true });
	// Act
	await trigger.focus();
	await trigger.press("ArrowDown");
	// Assert
	await expect(page.getByRole("listbox")).toBeVisible();
	await expect(page.getByRole("option", { name: "Unavailable fixture" })).toBeDisabled();
	await assertScreenshot(page, "select-open.png");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("listbox")).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await expect(
		page.getByRole("combobox", { name: "Radix select disabled", exact: true }),
	).toBeDisabled();
});

test("action menu exposes unavailable and danger actions and selects locally", async ({ page }) => {
	// Arrange
	const trigger = page.getByRole("button", { name: "Fixture actions" });
	// Act
	await trigger.click();
	// Assert
	await expect(page.getByRole("menuitem", { name: "Unavailable action" })).toBeDisabled();
	await assertScreenshot(page, "action-menu-open.png");
	await page.getByRole("menuitem", { name: "Select fixture", exact: true }).click();
	await expect(page.getByTestId("gallery-menu-result")).toHaveText("Fixture selected");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test("tooltip opens on focus and dismisses on Escape", async ({ page }) => {
	// Arrange
	const trigger = page.getByTestId("gallery-tooltip-trigger");
	// Radix dismisses on ancestor scroll; position the trigger before opening it.
	await trigger.scrollIntoViewIfNeeded();
	await page.getByRole("button", { name: "Fixture actions" }).focus();
	// Native scroll events can arrive after focus and dismiss Radix content.
	// Drain pending scroll frames before keyboard focus opens the tooltip.
	await page.evaluate(async () => {
		const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		let previous = `${scrollX},${scrollY}`;
		let stableFrames = 0;
		while (stableFrames < 2) {
			await frame();
			const current = `${scrollX},${scrollY}`;
			stableFrames = current === previous ? stableFrames + 1 : 0;
			previous = current;
		}
	});
	// Act
	await page.keyboard.press("Shift+Tab");
	// Assert
	await expect(trigger).toBeFocused();
	await expect(page.getByRole("tooltip")).toHaveText("Synthetic tooltip content");
	await assertScreenshot(page, "tooltip-open.png");
	await trigger.press("Escape");
	await expect(page.getByRole("tooltip")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Disabled tooltip trigger" })).toBeDisabled();
});

test("dialog contains focus and closes without losing trigger focus", async ({ page }) => {
	// Arrange
	const trigger = page.getByTestId("gallery-dialog-trigger");
	// Act
	await trigger.click();
	// Assert
	const dialog = page.getByRole("dialog", { name: "Synthetic dialog" });
	await expect(dialog).toBeVisible();
	await page.getByRole("button", { name: "Finish fixture" }).focus();
	await page.keyboard.press("Tab");
	await expect(page.getByRole("button", { name: "Close fixture dialog" })).toBeFocused();
	await assertScreenshot(page, "dialog-open.png");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test("autocomplete filters suggestions and closes on an empty match", async ({ page }) => {
	// Arrange
	const input = page.getByTestId("gallery-autocomplete");
	// Act
	await input.fill("fixture");
	// Assert
	await expect(page.getByRole("listbox")).toBeVisible();
	await assertScreenshot(page, "autocomplete-open.png");
	await input.press("ArrowDown");
	await input.press("Enter");
	await expect(input).toHaveValue("Alpha fixture");
	await input.fill("no matching synthetic suggestion");
	await expect(page.getByRole("listbox")).toHaveCount(0);
	await expect(page.locator("#gallery-autocomplete-disabled")).toBeDisabled();
});
