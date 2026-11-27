import { describe, expect, it } from "vitest";
import { teamSetupRecoveryReason } from "./team-setup-recovery";

describe("Team setup recovery reason", () => {
	it("says a Team on hold shares nothing and where to review the recovery again", () => {
		const reason = teamSetupRecoveryReason({
			blockingError: "team_setup_completion_unavailable",
			blockingReason: "team_recovery_unconfirmed",
		});

		expect(reason).toContain("saved but not confirmed");
		expect(reason).toContain("shares nothing yet");
		expect(reason).toContain("review the recovery again");
	});

	it("keeps the general copy for the same error without that reason", () => {
		const reason = teamSetupRecoveryReason({ blockingError: "team_setup_completion_unavailable" });

		expect(reason).toBe(
			"Saved Team setup cannot be recovered on this device right now. View recovery details and try again.",
		);
	});
});
