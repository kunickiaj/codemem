import { afterEach, expect, it, vi } from "vitest";
import { acceptCoordinatorInvite } from "./coordinator-join-confirmation";

const DETAIL =
	"Joining a coordinator permanently turns off syncing without a coordinator for this device's key, including other codemem profiles that use the same key.";

afterEach(() => {
	vi.unstubAllGlobals();
});

function serverAskingForConfirmation() {
	const bodies: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			bodies.push(body);
			if (body.confirm_coordinator_join !== true) {
				return Response.json(
					{ error: "coordinator_join_confirmation_required", detail: DETAIL },
					{ status: 409 },
				);
			}
			return Response.json({ ok: true, status: "enrolled", group_id: "team-a" });
		}),
	);
	return bodies;
}

it("shows the coordinator join warning and joins once confirmed", async () => {
	const bodies = serverAskingForConfirmation();
	const confirm = vi.fn(async () => true);

	const result = await acceptCoordinatorInvite("invite", {}, "legacy_team_invite", confirm);

	expect(confirm).toHaveBeenCalledWith(
		expect.objectContaining({
			title: "Join this coordinator?",
			description: `${DETAIL} This can't be undone.`,
			confirmLabel: "Join coordinator",
			autoFocusAction: "cancel",
		}),
	);
	expect(result).toMatchObject({ status: "enrolled" });
	expect(bodies.map((body) => body.confirm_coordinator_join)).toEqual([undefined, true]);
});

it("does not join when the warning is cancelled", async () => {
	const bodies = serverAskingForConfirmation();

	await expect(
		acceptCoordinatorInvite("invite", {}, "legacy_team_invite", async () => false),
	).rejects.toThrow("Invitation not accepted.");
	expect(bodies).toHaveLength(1);
});
