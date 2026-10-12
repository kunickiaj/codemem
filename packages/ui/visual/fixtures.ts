import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { isGalleryRequest } from "../scripts/visual-policy.mjs";

export const test = base.extend({
	page: async ({ page, context, colorScheme }, use) => {
		// Arrange: block API calls and any external request, including accidental fixture regressions.
		const unexpected: string[] = [];
		await context.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			if (!isGalleryRequest(url.href)) {
				unexpected.push(`${url.origin}${url.pathname}`);
				await route.abort();
				return;
			}
			await route.continue();
		});
		await context.routeWebSocket("**/*", (socket) => {
			if (!isGalleryRequest(socket.url().replace(/^ws:/, "http:"))) unexpected.push(socket.url());
			socket.close();
		});
		await page.goto("/gallery.html");
		await expect(page.getByTestId("gallery-root")).toBeVisible();
		if (colorScheme === "light") await page.getByTestId("gallery-theme-toggle").click();
		await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme || "dark");
		// Act: load both local pinned font faces before allowing screenshot assertions.
		const fonts = await page.evaluate(async () => {
			const families = ["Geist", "JetBrains Mono"];
			await Promise.all(families.map((family) => document.fonts.load(`16px "${family}"`)));
			await document.fonts.ready;
			return families.map((family) =>
				[...document.fonts].some(
					(face) => face.family.replaceAll('"', "") === family && face.status === "loaded",
				),
			);
		});
		// Assert: fallback fonts and unexpected network calls must fail, not become baselines.
		expect(fonts).toEqual([true, true]);
		await use(page);
		expect(unexpected).toEqual([]);
	},
});
export { expect };

export async function assertScreenshot(target: Page | Locator, name: string) {
	// A missing baseline assertion does not emit an actual image in Playwright.
	// Keep review captures in ignored results, never in the approved golden directory.
	const path = test.info().outputPath(`review-${name}`);
	await target.screenshot({
		path,
		animations: "disabled",
		caret: "hide",
		scale: "css",
	});
	await test.info().attach(`review-${name}`, { path, contentType: "image/png" });
	await expect.soft(target).toHaveScreenshot(name);
}
