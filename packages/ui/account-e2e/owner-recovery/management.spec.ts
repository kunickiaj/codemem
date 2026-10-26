import { expect, type Locator, type Page, test } from "@playwright/test";
import { recoveryFixture } from "./fixture";

const OWNER_ONLY =
	"This device runs as Original B, but the Google account belongs to Known A. To refresh or unlink it, use a device that runs as Known A.";

/** The Viewer picks a group itself; Technical details keeps an override. */
async function chooseGroup(page: Page, groupId: string) {
	const picker = page.getByLabel("Check status using group", { exact: true });
	if (!(await picker.isVisible())) await page.getByText("Technical details", { exact: true }).click();
	await picker.selectOption(groupId);
}

async function openRecovery(page: Page) {
	await chooseGroup(page, "group-a");
	const trigger = page.getByRole("button", { name: "Review account ownership", exact: true });
	await trigger.click();
	const dialog = page.getByRole("dialog", { name: "Review account ownership", exact: true });
	await expect(dialog.getByLabel("Choose an already-linked owner", { exact: true })).toBeVisible();
	return { dialog, trigger };
}

async function explicitPreview(dialog: Locator) {
	// Use the supported explicit existing-ID control, never a fabricated dropdown
	// option. The field starts open only when the server suggests no owners.
	const manual = dialog.getByLabel("Existing owner Identity ID (not a new account)", {
		exact: true,
	});
	if (!(await manual.isVisible()))
		await dialog.getByText("Advanced: enter an existing owner ID", { exact: true }).click();
	await manual.fill("identity-a");
	for (const group of ["group-a", "group-b"]) {
		await dialog.getByRole("checkbox", { name: group, exact: true }).uncheck();
		await dialog.getByRole("checkbox", { name: group, exact: true }).check();
	}
	await dialog.getByRole("button", { name: "Preview account ownership", exact: true }).click();
	await expect(dialog.getByRole("region", { name: "Server ownership preview" })).toBeVisible();
	await expect(
		dialog.getByRole("heading", { name: "Recorded assignments (2)", exact: true }),
	).toBeVisible();
	const records = dialog
		.getByRole("region", { name: "Server ownership preview" })
		.locator("ol > li");
	await expect(records).toHaveCount(2);
	await expect(records.filter({ hasText: "identity-a" })).toHaveCount(1);
	await expect(records.filter({ hasText: "identity-b" })).toHaveCount(1);
	const confirm = dialog.getByRole("button", { name: "Confirm account ownership", exact: true });
	await expect(confirm).toBeDisabled();
	const acknowledgement = dialog.getByRole("checkbox", {
		name: /^I reviewed these records and groups/,
	});
	await expect(acknowledgement).not.toBeChecked();
	return { confirm, acknowledgement };
}

async function checkReviewStatus(page: Page, dialog: Locator) {
	const pending = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/api/account/owner-recovery/preview",
	);
	await dialog.getByRole("button", { name: "Check review status", exact: true }).click();
	const response = await pending;
	expect(response.status()).toBe(200);
	expect(await response.json()).toMatchObject({
		existingOwnerId: "identity-a",
		groups: ["group-a", "group-b"],
	});
}

test("explicit default-No recovery confirms both groups once and survives restart without changing B data or permissions", async ({
	page,
	context,
}) => {
	// Arrange: an isolated real Viewer/coordinator, real keys, linked A and nonempty B.
	const f = await recoveryFixture(context);
	try {
		const before = f.preserved();
		expect(before.access).toMatchObject({
			status: "eligible",
			devices: [{ identityId: "identity-b" }],
		});
		await page.goto(f.viewerOrigin);
		const { dialog, trigger } = await openRecovery(page);
		await expect(dialog).toHaveAccessibleDescription(
			/Pick the Identity that is linked to your Google account/,
		);
		await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
		await expect(dialog.getByLabel("Choose an already-linked owner", { exact: true })).toHaveValue(
			"",
		);
		await expect(
			dialog.getByRole("button", { name: "Preview account ownership", exact: true }),
		).toBeDisabled();
		await expect(
			dialog.getByRole("button", { name: "Confirm account ownership", exact: true }),
		).toBeDisabled();
		// Default-No: Enter from the initial focus cancels instead of approving.
		await page.keyboard.press("Enter");
		await expect(dialog).not.toBeVisible();
		await expect(trigger).toBeFocused();
		expect(await f.confirmations()).toHaveLength(0);
		expect(f.preserved()).toEqual(before);
		await trigger.click();
		const { confirm, acknowledgement } = await explicitPreview(dialog);
		expect(f.rows("coordinator_legacy_owner_resolutions")).toEqual([]);
		expect(f.associations()).toEqual([]);
		expect(f.preserved()).toEqual(before);

		// Act: only acknowledgement enables the single explicit confirmation.
		await acknowledgement.check();
		await expect(confirm).toBeEnabled();
		await confirm.click();
		const outcomes = dialog.getByRole("region", { name: "Reported review outcomes" });
		await expect(outcomes).toContainText("group-a: confirmed");
		await expect(outcomes).toContainText("group-b: confirmed");
		await expect(confirm).toBeDisabled();
		expect(await f.confirmations()).toEqual([expect.objectContaining({ group_id: "group-a" })]);
		expect(f.rows("coordinator_legacy_owner_resolutions")).toHaveLength(1);
		const published = f.associations();
		expect(published).toHaveLength(2);
		for (const file of published) {
			expect(file.name).toMatch(/^\.codemem\/account-owner-associations\/\.account-owner-/);
			expect(file.bytes.length).toBeGreaterThan(0);
		}
		const receipts = f.requests
			.filter(
				(request) =>
					new URL(request.url).pathname === "/v1/auth/resolved-account-owner-receipt-status",
			)
			.map((request) => new URL(request.url));
		expect(receipts.map((url) => url.searchParams.get("group_id"))).toEqual(["group-a", "group-b"]);
		for (const pin of [
			"attestation_id",
			"review_receipt_id",
			"review_evidence_digest",
			"resolution_id",
			"resolution_evidence_digest",
		]) {
			expect(receipts[0]?.searchParams.get(pin)).toBeTruthy();
			expect(receipts[1]?.searchParams.get(pin)).toBe(receipts[0]?.searchParams.get(pin));
		}
		expect(f.preserved()).toEqual(before);
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await f.restart();
		await page.reload();

		// Assert: the Viewer picks a group itself and names this device's real state.
		// The owner's Google profile stays off this device, which never signed in.
		await expect(page.getByText(OWNER_ONLY, { exact: true })).toBeVisible();
		await expect(page.getByText("Canonical A profile", { exact: true })).toHaveCount(0);
		await expect(page.getByText(/Memory author|\(unchanged\)|does not allow Google/)).toHaveCount(
			0,
		);
		await expect(
			page.getByRole("button", { name: "Link Google account", exact: true }),
		).toBeDisabled();
		await expect(page.getByRole("button", { name: "Refresh profile", exact: true })).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Unlink Google account", exact: true }),
		).toHaveCount(0);
		const refreshed = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/account/link-status",
		);
		await page.getByRole("button", { name: "Check status", exact: true }).click();
		expect((await refreshed).status()).toBe(200);
		await expect(page.getByText(OWNER_ONLY, { exact: true })).toBeVisible();
		const selected = page.waitForResponse(
			(response) => new URL(response.url()).searchParams.get("group_id") === "group-b",
		);
		await chooseGroup(page, "group-b");
		expect((await selected).status()).toBe(200);
		await expect(page.getByText(OWNER_ONLY, { exact: true })).toBeVisible();
		expect(
			f.requests.filter(
				(request) =>
					request.method === "POST" &&
					[
						"/v1/auth/account-changes",
						"/v1/auth/account-unlinks",
						"/v1/auth/link-attempts",
					].includes(new URL(request.url).pathname),
			),
		).toEqual([]);
		expect(await f.confirmations()).toHaveLength(1);
		expect(f.preserved()).toEqual(before);
		expect(f.associations()).toEqual(published);
		expect(f.blocked).toEqual([]);
		expect(context.pages()).toHaveLength(1);
	} finally {
		await f.close();
	}
});

test("unknown receipt outcome reopens on the original submitted target and status reads cannot reapply approval", async ({
	page,
	context,
}) => {
	// Arrange: only receipt delivery fails; coordinator commit remains real.
	const f = await recoveryFixture(context);
	try {
		const before = f.preserved();
		await page.goto(f.viewerOrigin);
		const { dialog, trigger } = await openRecovery(page);
		const { confirm, acknowledgement } = await explicitPreview(dialog);
		f.loseReceipt();
		await acknowledgement.check();
		// Act
		await confirm.click();
		const outcomes = dialog.getByRole("region", { name: "Reported review outcomes" });
		await expect(outcomes).toContainText("group-a: unknown");
		await expect(outcomes).toContainText("group-b: unknown");
		await expect(
			dialog.getByRole("button", { name: "Check review status", exact: true }),
		).toBeEnabled();
		expect(await f.confirmations()).toHaveLength(1);
		expect(f.rows("coordinator_legacy_owner_resolutions")).toHaveLength(1);
		expect(f.associations()).toEqual([]);
		await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await expect(trigger).toBeFocused();
		await trigger.click();
		await expect(dialog.getByLabel("Choose an already-linked owner", { exact: true })).toHaveValue(
			"",
		);
		f.restoreReceipt();
		const original = f.rows("coordinator_legacy_owner_resolutions");
		await checkReviewStatus(page, dialog);
		const status = dialog.getByRole("region", { name: "Read-only review status" });
		await expect(
			status.getByRole("heading", { name: "Ownership review for identity-a", exact: true }),
		).toBeVisible();
		await expect(status).toContainText("group-a");
		await expect(status).toContainText("group-b");
		await checkReviewStatus(page, dialog);
		// Assert: original target is display-only; no refreshed consent or local publication.
		await expect(
			status.getByRole("heading", { name: "Ownership review for identity-a", exact: true }),
		).toBeVisible();
		await expect(confirm).toBeDisabled();
		await expect(
			dialog.getByRole("checkbox", { name: /^I reviewed these records and groups/ }),
		).toHaveCount(0);
		expect(await f.confirmations()).toHaveLength(1);
		expect(f.rows("coordinator_legacy_owner_resolutions")).toEqual(original);
		expect(f.associations()).toEqual([]);
		expect(f.preserved()).toEqual(before);
		expect(f.blocked).toEqual([]);
	} finally {
		await f.close();
	}
});
