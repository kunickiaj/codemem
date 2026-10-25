import type { Page } from "@playwright/test";
import { assertScreenshot, expect, test } from "./fixtures.js";

async function tooltipGeometry(page: Page) {
	return page.locator(".tooltip-arrow").evaluate((arrow) => {
		const content = arrow.closest<HTMLElement>(".tooltip-content");
		const span = arrow.parentElement;
		const trigger = document.querySelector('[data-testid="gallery-tooltip-trigger"]');
		if (!content || !span || !trigger) throw new Error("Tooltip geometry is missing");
		const rect = arrow.getBoundingClientRect();
		const anchor = trigger.getBoundingClientRect();
		const { x, y, width, height } = content.getBoundingClientRect();
		return {
			parentIsContent: span.offsetParent === content,
			parentWidth: (span.offsetParent as HTMLElement | null)?.clientWidth,
			offset: Number.parseFloat(span.style.left),
			centerX: rect.left + rect.width / 2,
			anchorCenterX: anchor.left + anchor.width / 2,
			body: { x, y, width, height },
		};
	});
}

/** Wait until positioning stops changing, then return the final geometry. */
async function settledTooltipGeometry(page: Page) {
	let previous = "";
	await expect
		.poll(
			async () => {
				const current = JSON.stringify(await tooltipGeometry(page));
				const stable = current === previous;
				previous = current;
				return stable;
			},
			{ intervals: [50], timeout: 5_000 },
		)
		.toBe(true);
	return tooltipGeometry(page);
}

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
	const initial = await tooltipGeometry(page);
	expect(initial.parentIsContent).toBe(true);
	// Geometry, not a full-page screenshot, guards placement: page-wide captures
	// failed on unrelated anti-aliasing while the tooltip itself was unchanged.
	// The screenshot also waited for layout to settle, so wait explicitly here.
	const settled = await settledTooltipGeometry(page);
	const viewport = page.viewportSize();
	if (!viewport) throw new Error("Tooltip regression requires a fixed viewport");
	// Recompute naturally; a finished animation must not change the arrow's parent.
	await page.setViewportSize({ ...viewport, width: viewport.width + 1 });
	await page.setViewportSize(viewport);
	await expect.poll(() => tooltipGeometry(page)).toEqual(settled);
	await test.info().attach("tooltip-geometry", {
		body: JSON.stringify({ initial, settled, recomputed: await tooltipGeometry(page) }),
		contentType: "application/json",
	});
	expect(settled.parentWidth).toBe(initial.parentWidth);
	expect(settled.offset).toBe(initial.offset);
	expect(Math.abs(settled.centerX - settled.anchorCenterX)).toBeLessThanOrEqual(0.5);
	await trigger.press("Escape");
	await expect(page.getByRole("tooltip")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Disabled tooltip trigger" })).toBeDisabled();
});

test.describe("tooltip opening animation", () => {
	test.use({ reducedMotion: "no-preference" });
	test("keeps the same arrow positioning parent when the transform animation finishes", async ({
		page,
	}) => {
		// Arrange: observe the first positioned arrow within the browser task, before animation ends.
		await page.getByTestId("gallery-tooltip-trigger").scrollIntoViewIfNeeded();
		// Act: retain real CSS motion here; ordinary screenshot cases still use reduced motion.
		const geometry = await page.evaluate(async () => {
			const trigger = document.querySelector<HTMLElement>(
				'[data-testid="gallery-tooltip-trigger"]',
			);
			if (!trigger) throw new Error("Tooltip trigger is missing");
			const read = () => {
				const content = document.querySelector<HTMLElement>(".tooltip-content");
				const arrow = document.querySelector<SVGElement>(".tooltip-arrow");
				const span = arrow?.parentElement;
				if (!content || !arrow || !span) throw new Error("Tooltip arrow is missing");
				const rect = arrow.getBoundingClientRect();
				return {
					parentIsContent: span.offsetParent === content,
					parentWidth: (span.offsetParent as HTMLElement | null)?.clientWidth,
					offset: Number.parseFloat(span.style.left),
					centerX: rect.left + rect.width / 2,
				};
			};
			const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
			await frame();
			await frame();
			type EarlyGeometry = ReturnType<typeof read> & { animating: boolean };
			const early = await new Promise<EarlyGeometry>((resolve) => {
				const observer = new MutationObserver(() => {
					const content = document.querySelector<HTMLElement>(".tooltip-content");
					const span = document.querySelector(".tooltip-arrow")?.parentElement;
					if (!content || !span?.style.left || content.getBoundingClientRect().top < 0) return;
					const anchor = trigger.getBoundingClientRect();
					if (Math.abs(read().centerX - anchor.left - anchor.width / 2) > 0.5) return;
					observer.disconnect();
					const animating = content
						.getAnimations()
						.some(({ playState }) => playState === "running");
					resolve({ ...read(), animating });
				});
				observer.observe(document.body, { subtree: true, childList: true, attributes: true });
				trigger.focus({ preventScroll: true });
			});
			const content = document.querySelector<HTMLElement>(".tooltip-content");
			if (!content) throw new Error("Tooltip content is missing");
			await Promise.all(content.getAnimations().map((animation) => animation.finished));
			return { early, finished: read() };
		});
		// Assert: a completed transform must not swap positioning parents or move the arrow sideways.
		const { animating, ...earlyGeometry } = geometry.early;
		expect(animating).toBe(true);
		expect(geometry.early.parentIsContent).toBe(true);
		expect(geometry.finished).toEqual(earlyGeometry);
		await expect(page.getByRole("tooltip")).toHaveText("Synthetic tooltip content");
		await page.keyboard.press("Escape");
		await expect(page.getByRole("tooltip")).toHaveCount(0);
	});
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
