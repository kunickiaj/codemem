import { expect, test } from "./fixtures.js";

test("compact native and Radix selects are 30px while defaults stay 38px", async ({ page }) => {
	// Arrange
	for (const family of ["Native", "Radix"]) {
		const normal = page.getByRole("combobox", { name: `${family} select default`, exact: true });
		const compact = page.getByRole("combobox", { name: `${family} select compact`, exact: true });
		// Act
		const normalBox = await normal.boundingBox();
		const compactBox = await compact.boundingBox();
		// Assert: compact is an actual geometry variant, not a smaller label in a tall control.
		expect(normalBox?.height).toBeCloseTo(38, 0);
		expect(compactBox?.height).toBeCloseTo(30, 0);
	}
	const fieldBox = await page.getByTestId("gallery-text-input").boundingBox();
	const actionBox = await page
		.getByRole("button", { name: "Settings button", exact: true })
		.boundingBox();
	expect(fieldBox?.height).toBeCloseTo(38, 0);
	expect(actionBox?.height).toBeCloseTo(36, 0);
	// Arrange: clone the shipped control solely to exercise native listbox exclusions.
	const select = page.getByTestId("gallery-native-select-compact");
	for (const attributes of [
		{ multiple: true, size: 1 },
		{ multiple: false, size: 4 },
	]) {
		// Act
		const mode = await select.evaluate((element, attributes) => {
			const listbox = element.cloneNode(true) as HTMLSelectElement;
			listbox.removeAttribute("id");
			listbox.removeAttribute("data-testid");
			listbox.multiple = attributes.multiple;
			listbox.size = attributes.size;
			element.after(listbox);
			const style = getComputedStyle(listbox);
			const result = {
				appearance: style.appearance,
				backgroundImage: style.backgroundImage,
				multiple: listbox.multiple,
				size: listbox.size,
				compact: listbox.dataset.size,
			};
			listbox.remove();
			return result;
		}, attributes);
		// Assert: HTML size/multiple must never pick up the single-picker arrow or appearance reset.
		expect(mode.compact).toBe("compact");
		expect(mode.multiple).toBe(attributes.multiple);
		expect(mode.size).toBe(attributes.size);
		expect(mode.appearance).not.toBe("none");
		expect(mode.backgroundImage).toBe("none");
	}
});

test("long native selection fits the real document without overflow masks", async ({ page }) => {
	// Arrange: run both narrow and desktop geometry in WebKit as well as Chromium.
	for (const width of [390, 1280]) {
		await page.setViewportSize({ width, height: 900 });
		const select = page.getByTestId("gallery-native-select-long");
		// Act: inspect the actual selected option's intrinsic text and the painted control box.
		const geometry = await select.evaluate((element) => {
			const control = element as HTMLSelectElement;
			const style = getComputedStyle(control);
			const box = control.getBoundingClientRect();
			const parent = control.parentElement?.getBoundingClientRect();
			const canvas = document.createElement("canvas");
			const context = canvas.getContext("2d");
			if (!context || !parent) throw new Error("select measurement unavailable");
			context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
			const masked: string[] = [];
			for (let ancestor = control.parentElement; ancestor; ancestor = ancestor.parentElement) {
				if (["hidden", "clip"].includes(getComputedStyle(ancestor).overflowX))
					masked.push(ancestor.tagName);
			}
			return {
				width: box.width,
				parentWidth: parent.width,
				right: box.right,
				contentWidth:
					box.width -
					parseFloat(style.paddingLeft) -
					parseFloat(style.paddingRight) -
					parseFloat(style.borderLeftWidth) -
					parseFloat(style.borderRightWidth),
				intrinsicText: context.measureText(control.selectedOptions[0].textContent || "").width,
				appearance: style.appearance,
				masked,
				documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
			};
		});
		// Assert: the label genuinely exceeds available space, but not the document or its frame.
		expect(geometry.intrinsicText).toBeGreaterThan(geometry.contentWidth);
		expect(geometry.contentWidth).toBeGreaterThan(40);
		expect(geometry.width).toBeLessThanOrEqual(geometry.parentWidth + 1);
		expect(geometry.right).toBeLessThanOrEqual(width);
		expect(geometry.documentWidth).toBeLessThanOrEqual(width);
		expect(geometry.masked).toEqual([]);
		expect(geometry.appearance).toBe("none");
		// Act / Assert: truncation must not prevent changing the native selection.
		await select.selectOption("alpha");
		await expect(select).toHaveValue("alpha");
		await select.selectOption("long");
		await expect(select).toHaveValue("long");
	}
});

test("long action labels wrap inside viewport padding and still select", async ({ page }) => {
	// Arrange
	const trigger = page.getByRole("button", { name: "Fixture actions" });
	// Act
	await trigger.click();
	const menu = page.getByRole("menu");
	const longAction = page.getByRole("menuitem", { name: /deliberately long synthetic label/ });
	await expect(menu).toBeVisible();
	// Radix positions after mounting; visibility alone can expose the initial origin box.
	await expect
		.poll(() => menu.evaluate((element) => element.getBoundingClientRect().left))
		.toBeGreaterThanOrEqual(11);
	const geometry = await longAction.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		const panel = element.closest('[role="menu"]');
		if (!panel) throw new Error("menu panel missing");
		const box = panel.getBoundingClientRect();
		return {
			left: box.left,
			right: box.right,
			viewport: innerWidth,
			top: box.top,
			bottom: box.bottom,
			viewportHeight: innerHeight,
			lines: new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size,
			scrollWidth: panel.scrollWidth,
			clientWidth: panel.clientWidth,
		};
	});
	// Assert: no clipped single-line workaround and no disabled callback becoming actionable.
	expect(geometry.left).toBeGreaterThanOrEqual(11);
	expect(geometry.right).toBeLessThanOrEqual(geometry.viewport - 11);
	expect(geometry.top).toBeGreaterThanOrEqual(11);
	expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight - 11);
	expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
	expect(geometry.lines).toBeGreaterThan(1);
	await expect(page.getByRole("menuitem", { name: "Unavailable action" })).toBeDisabled();
	await expect(page.getByTestId("gallery-menu-result")).toHaveText("No action selected");
	// Act / Assert
	await longAction.click();
	await expect(page.getByTestId("gallery-menu-result")).toHaveText("Long action selected");
	await expect(menu).toHaveCount(0);
	await expect(trigger).toBeFocused();
});

test("scope chips fit their frame while switch and radio controls stay small", async ({ page }) => {
	// Arrange
	const chip = page.getByTestId("gallery-chips").locator(".peer-scope-chip");
	// Act
	const geometry = await chip.evaluate((element) => {
		const frame = element.parentElement?.getBoundingClientRect();
		const box = element.getBoundingClientRect();
		if (!frame) throw new Error("chip frame missing");
		return {
			left: box.left,
			right: box.right,
			frameLeft: frame.left,
			frameRight: frame.right,
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
		};
	});
	// Assert: long scope copy is contained, not merely hidden by the parent.
	expect(geometry.left).toBeGreaterThanOrEqual(geometry.frameLeft);
	expect(geometry.right).toBeLessThanOrEqual(geometry.frameRight + 1);
	expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
	for (const control of await page.locator('[role="switch"], [role="radio"]').all()) {
		const box = await control.boundingBox();
		expect(box?.height).toBeLessThan(30);
	}
	// Act / Assert: small controls remain operable; disabled choices remain unavailable.
	await page.getByRole("switch", { name: "Enable fixture" }).click();
	await expect(page.getByRole("switch", { name: "Enable fixture" })).toBeChecked();
	await expect(page.getByRole("radio", { name: "Unavailable choice" })).toBeDisabled();
});
