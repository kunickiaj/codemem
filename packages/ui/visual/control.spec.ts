import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import config from "../playwright.config.js";
import { expect, test } from "./fixtures.js";

test("strict comparator passes unchanged pixels and rejects a control mutation without updating", async ({
	page,
}, info) => {
	// Arrange: create a scratch comparator input, not an approved gallery baseline.
	const button = page.getByTestId("gallery-button-default");
	const baseline = info.snapshotPath("control.png");
	mkdirSync(dirname(baseline), { recursive: true });
	writeFileSync(
		baseline,
		await button.screenshot({ animations: "disabled", caret: "hide", scale: "css" }),
	);
	const hash = () => createHash("sha256").update(readFileSync(baseline)).digest("hex");
	const before = hash();
	await expect(button).toHaveScreenshot("control.png");
	// Act: change one real control's pixels, then exercise the ordinary strict assertion.
	await button.evaluate((element) => {
		element.style.backgroundColor = "rgb(255, 0, 255)";
	});
	let failure: unknown;
	try {
		await expect(button).toHaveScreenshot("control.png", { timeout: 2000 });
	} catch (error) {
		failure = error;
	}
	// Assert
	expect(String(failure)).toMatch(/pixels .* are different/);
	expect(hash()).toBe(before);
});

test("a significant single-pixel change exceeds the zero-pixel budget without updating", async ({
	page,
}, info) => {
	// Arrange: anchor a scratch overlay without changing control geometry or approved goldens.
	const button = page.getByTestId("gallery-button-default");
	await button.evaluate((element) => {
		element.style.position = "relative";
	});
	const baseline = info.snapshotPath("single-pixel.png");
	mkdirSync(dirname(baseline), { recursive: true });
	writeFileSync(
		baseline,
		await button.screenshot({ animations: "disabled", caret: "hide", scale: "css" }),
	);
	const before = createHash("sha256").update(readFileSync(baseline)).digest("hex");
	await expect(button).toHaveScreenshot("single-pixel.png");
	// Act: align a saturated 1×1 CSS-pixel overlay to integer viewport pixels (DPR 1).
	await button.evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const style = getComputedStyle(element);
		const pixel = document.createElement("span");
		Object.assign(pixel.style, {
			position: "absolute",
			left: `${Math.ceil(rect.left) + 12 - rect.left - Number.parseFloat(style.borderLeftWidth)}px`,
			top: `${Math.ceil(rect.top) + 12 - rect.top - Number.parseFloat(style.borderTopWidth)}px`,
			width: "1px",
			height: "1px",
			background: "rgb(255, 0, 255)",
			margin: "0",
			padding: "0",
			border: "0",
			pointerEvents: "none",
		});
		element.append(pixel);
	});
	let failure: unknown;
	try {
		await expect(button).toHaveScreenshot("single-pixel.png", { timeout: 2000 });
	} catch (error) {
		failure = error;
	}
	// Assert: perceptual threshold 0.01 still rejects exactly one significant changed pixel.
	expect(config.expect?.toHaveScreenshot).toMatchObject({
		threshold: 0.01,
		maxDiffPixels: 0,
	});
	expect(String(failure)).toMatch(/\b1 pixels? .* are different/);
	expect(createHash("sha256").update(readFileSync(baseline)).digest("hex")).toBe(before);
});

test("missing snapshot fails without creating a baseline", async ({ page }, info) => {
	// Arrange
	const baseline = info.snapshotPath("missing.png");
	expect(existsSync(baseline)).toBe(false);
	// Act
	let failure: unknown;
	try {
		await expect(page.getByTestId("gallery-button-default")).toHaveScreenshot("missing.png");
	} catch (error) {
		failure = error;
	}
	// Assert
	expect(String(failure)).toContain("doesn't exist");
	expect(existsSync(baseline)).toBe(false);
});
