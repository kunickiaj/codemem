import { describe, expect, it } from "vitest";
import { shouldShowSyncAttemptRedactionHint } from "./sync-attempts";

describe("shouldShowSyncAttemptRedactionHint", () => {
	it("shows the reveal hint only for explicitly redacted attempt errors", () => {
		expect(
			shouldShowSyncAttemptRedactionHint(
				{
					error_redacted: true,
				},
				true,
			),
		).toBe(true);
	});

	it("does not show the reveal hint for unredacted generic-looking errors", () => {
		expect(
			shouldShowSyncAttemptRedactionHint(
				{
					error_redacted: false,
				},
				true,
			),
		).toBe(false);
		expect(
			shouldShowSyncAttemptRedactionHint(
				{
					error_redacted: true,
				},
				false,
			),
		).toBe(false);
	});
});
