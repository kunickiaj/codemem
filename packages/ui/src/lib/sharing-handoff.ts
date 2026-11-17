/**
 * Advanced screens send people to Sharing to create Teams and invitations, so
 * every new invitation is a Team or add-device invitation. app.ts listens for this
 * event and performs the navigation.
 */
export type SharingHandoff = "create_team" | "invite";

export const SHARING_HANDOFF_EVENT = "codemem:open-sharing";

export function openSharingFrom(target: SharingHandoff): void {
	window.dispatchEvent(new CustomEvent<SharingHandoff>(SHARING_HANDOFF_EVENT, { detail: target }));
}
