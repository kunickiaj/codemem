import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { fixture } from "./fixture";

async function openProvider(page: Page, context: BrowserContext, action: string) {
	const opened = context.waitForEvent("page");
	await page.getByRole("button", { name: action, exact: true }).click();
	const popup = await opened;
	if (action !== "Link Google account")
		await popup.getByRole("button", { name: "Continue with Google", exact: true }).click();
	await expect(
		popup.getByRole("heading", { name: "Synthetic provider authorization" }),
	).toBeVisible();
	// COOP is emitted by our synthetic provider hop, not asserted for coordinator pages.
	expect(await popup.evaluate(() => window.opener === null)).toBe(true);
	return popup;
}

async function assertBirthCannotRevive(f: Awaited<ReturnType<typeof fixture>>) {
	const before = {
		status: await f.status(),
		links: f.rows("coordinator_auth_account_links"),
		history: f.rows("coordinator_auth_account_connection_history"),
	};
	// Exact-proof retries may read their retained receipt; they cannot restore A.
	expect((await f.replayBirth()).status).toBe(200);
	expect({
		status: await f.status(),
		links: f.rows("coordinator_auth_account_links"),
		history: f.rows("coordinator_auth_account_connection_history"),
	}).toEqual(before);
	expect(await f.oldSession()).toBeNull();
}

for (const empty of [false, true]) {
	test(`refresh verifies provider claims without confirmation; empty=${empty}`, async ({
		page,
		context,
	}) => {
		// Arrange: existing A, real Viewer/runtime/coordinator, synthetic signed provider.
		const f = await fixture(context);
		try {
			if (empty) for (const key of ["name", "email", "picture"]) delete f.claims[key];
			const before = f.preserved();
			await page.goto(f.viewerOrigin);
			await expect(page.getByText("Original profile", { exact: true })).toBeVisible();
			const viewerUrl = page.url();
			let dialogs = 0;
			page.on("dialog", async (dialog) => {
				dialogs++;
				await dialog.dismiss();
			});
			// Act: refresh has no local or hosted confirmation after provider authorization.
			const popup = await openProvider(page, context, "Refresh profile");
			const closed = popup.waitForEvent("close");
			await popup.getByRole("link", { name: "Complete synthetic sign-in" }).click();
			await closed;
			// Assert positive: verified profile becomes visible and preserves unrelated data.
			await expect
				.poll(async () => {
					const result = await f.status();
					return result.kind === "status" ? result.status.account : result;
				})
				.toEqual(
					empty
						? {}
						: {
								displayName: "Refreshed profile",
								email: "a@example.test",
								pictureUrl: "https://lh3.googleusercontent.com/browser-avatar",
							},
				);
			if (!empty) {
				await expect(page.getByText("Refreshed profile", { exact: true })).toBeVisible();
				await expect(
					page.getByText("a@example.test · Verified email", { exact: true }),
				).toBeVisible();
				expect(f.blocked).toContain("https://lh3.googleusercontent.com");
			}
			expect(f.preserved()).toEqual(before);
			// Assert negative: old fields/confirmation never survive an empty refresh.
			await expect(page.getByText("Original profile", { exact: true })).toHaveCount(0);
			await expect(page.getByText("original@example.test", { exact: false })).toHaveCount(0);
			expect(dialogs).toBe(0);
			expect(f.browserPosts).toEqual(["/auth/account/change/start"]);
			expect(page.url()).toBe(viewerUrl);
			expect(f.blocked.filter((origin) => origin !== "https://lh3.googleusercontent.com")).toEqual(
				[],
			);
		} finally {
			await f.close();
		}
	});
}

for (const subject of ["account-A","account-B"]) test(`device unlink confirms once; normal public link connects ${subject}; old proof/session cannot revive`, async ({
	page,
	context,
}) => {
	// Arrange: A has a browser session and sharing grants before disconnect.
	const f = await fixture(context);
	try {
		const before = f.preserved();
		expect(await f.oldSession()).not.toBeNull();
		await page.goto(f.viewerOrigin);
		// Act: one local dialog; no popup, provider visit or loopback receiver.
		await page.getByRole("button",{name:"Unlink Google account",exact:true}).click();
		const dialog=page.getByRole("dialog",{name:"Unlink Google account?"});
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("button",{name:"Unlink account",exact:true})).toHaveCount(1);
		expect(f.finalRequests).toHaveLength(0);
		expect(f.unlinkRequests).toHaveLength(0);
		await dialog.getByRole("button", { name: "Unlink account", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Link Google account", exact: true }),
		).toBeEnabled();
		expect(await f.status()).toMatchObject({
			kind: "status",
			status: { state: "unlinked", account: null },
		});
		expect(await f.oldSession()).toBeNull();
		expect(context.pages()).toHaveLength(1);
		expect(f.providerHops).toEqual([]);
		expect(f.browserPosts).toEqual([]);
		expect(f.unlinkRequests).toHaveLength(1);
		await assertBirthCannotRevive(f);
		f.claims.sub = subject;
		f.claims.name = "Account B";
		f.claims.email = "b@example.test";
		delete f.claims.picture;
		const link = await openProvider(page, context, "Link Google account");
		await link.getByRole("link", { name: "Complete synthetic sign-in" }).click();
		await expect(link.getByRole("button", { name: "Link account", exact: true })).toBeVisible();
		const linked = link.waitForEvent("close");
		await link.getByRole("button", { name: "Link account", exact: true }).click();
		await linked;
		// Assert: B replaces account connection, not local Identity or sharing rights.
		await expect(page.getByText("Account B", { exact: true })).toBeVisible();
		expect(await f.status()).toMatchObject({
			kind: "status",
			status: { state: "linked", account: { displayName: "Account B", email: "b@example.test" } },
		});
		expect(await f.oldSession()).toBeNull();
		const unlinkBody=await f.unlinkRequests[0]?.clone().json();
		const newLinks=f.rows("coordinator_auth_account_links");
		expect((await f.signed("/v1/auth/account-unlinks",unlinkBody)).status).toBe(200);
		expect((await f.signed("/v1/auth/account-unlinks",{...unlinkBody,attempt_id:"stale-confirmation"})).status).toBe(403);
		expect(f.rows("coordinator_auth_account_links")).toEqual(newLinks);
		await assertBirthCannotRevive(f);
		expect(f.preserved()).toEqual(before);
		expect(f.browserPosts.filter((path) => path === "/auth/account/change/confirm")).toHaveLength(
			0,
		);
		expect(f.blocked.filter((origin) => origin !== "https://lh3.googleusercontent.com")).toEqual(
			[],
		);
	} finally {
		await f.close();
	}
});

test("physical separated popup stays open until trusted runtime acknowledgement", async ({
	page,
	context,
}) => {
	// Arrange: hold only the runtime's signed finalization response after commit.
	const f = await fixture(context);
	try {
		f.hold();
		await page.goto(f.viewerOrigin);
		const popup = await openProvider(page, context, "Refresh profile");
		// Act: provider callback commits verified profile via actual signed runtime.
		await popup.getByRole("link", { name: "Complete synthetic sign-in" }).click();
		await f.finalized;
		await expect(popup.getByRole("heading", { name: "Finishing account refresh…" })).toBeVisible();
		// Assert negative: committed effects are not sufficient to close a real window.
		expect(await f.status()).toMatchObject({
			kind: "status",
			status: { state: "linked", account: { displayName: "Refreshed profile" } },
		});
		expect(popup.isClosed()).toBe(false);
		expect(await popup.evaluate(() => window.opener === null)).toBe(true);
		const token = await popup.locator("main").getAttribute("data-receipt");
		expect(
			await popup.evaluate(
				async (receipt) =>
					(
						await fetch("/codemem/auth/result", { headers: { "X-Codemem-Receipt": receipt ?? "" } })
					).json(),
				token,
			),
		).toEqual({ intent: "refresh", completed: false });
		const origin = new URL(popup.url()).origin;
		expect(
			await page.evaluate(
				async ({ origin, token }) => {
					try {
						await fetch(`${origin}/codemem/auth/result`, {
							headers: { "X-Codemem-Receipt": token ?? "" },
						});
						return "read";
					} catch {
						return "CORS rejected";
					}
				},
				{ origin, token },
			),
		).toBe("CORS rejected");
		// Assert positive: only releasing the actual trusted reply permits close.
		const closed = popup.waitForEvent("close");
		f.release();
		await closed;
		await expect(page.getByText("Refreshed profile", { exact: true })).toBeVisible();
	} finally {
		await f.close();
	}
});

test("blocked popup fallback opens a tab; cancellation preserves account and keys", async ({
	page,
	context,
}) => {
	// Arrange: block the first window.open only, not any application API.
	const f = await fixture(context);
	try {
		await page.addInitScript(() => {
			const open = window.open.bind(window);
			let attempts = 0;
			window.open = (...args) => (attempts++ === 0 ? null : open(...args));
		});
		const before = f.preserved();
		await page.goto(f.viewerOrigin);
		// Act: fallback keeps Viewer location and uses the public browser start.
		await page.getByRole("button", { name: "Refresh profile", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "Open Google sign-in", exact: true }),
		).toBeVisible();
		expect(context.pages()).toHaveLength(1);
		await openProvider(page, context, "Open Google sign-in");
		await page.getByRole("button", { name: "Cancel refresh", exact: true }).click();
		// Assert: cancellation cannot publish unlink success or mutate retained data.
		await expect(page.getByText("Original profile", { exact: true })).toBeVisible();
		await expect
			.poll(() => f.rows("coordinator_account_change_attempts"))
			.toEqual(expect.arrayContaining([expect.objectContaining({ state: "cancelled" })]));
		expect(f.finalRequests).toHaveLength(0);
		expect(f.preserved()).toEqual(before);
		expect(page.url()).toBe(`${f.viewerOrigin}/`);
	} finally {
		await f.close();
	}
});

test("local unlink cancellation and stale confirmation have no account effects or provider hops", async ({
	page,
	context,
}) => {
		// Arrange: the Viewer captures the signed target before opening its dialog.
	const f = await fixture(context);
	try {
		const before = f.preserved();
		await page.goto(f.viewerOrigin);
		const trigger=page.getByRole("button",{name:"Unlink Google account",exact:true});
		await trigger.click();
		await page.getByRole("dialog").getByRole("button",{name:"Cancel",exact:true}).click();
		await expect(trigger).toBeFocused();
		expect(f.unlinkRequests).toHaveLength(0);
		await trigger.click();
		// Act: local context changes before the signed finalization boundary.
		f.stale();
		await page.getByRole("dialog").getByRole("button", { name: "Unlink account", exact: true }).click();
		// Assert: no success receipt, no account mutation, no data/key loss.
		await expect(page.getByText("The local account context changed. Check status before trying again.")).toBeVisible();
		expect(f.finalRequests).toHaveLength(0);
		expect(await f.status()).toMatchObject({
			kind: "status",
			status: { state: "linked", account: { displayName: "Original profile" } },
		});
		expect(f.unlinkRequests).toHaveLength(0);
		expect(f.providerHops).toEqual([]);
		expect(context.pages()).toHaveLength(1);
		expect(f.preserved()).toEqual(before);
	} finally {
		await f.close();
	}
});
