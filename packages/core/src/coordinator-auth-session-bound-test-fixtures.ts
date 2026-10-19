import { createHash } from "node:crypto";
import { redeemInput as unboundInput } from "./coordinator-auth-session-test-fixtures.js";

// Match the binder submitted by advance's real start/consume browser proof flow.
export function redeemInput() {
	const input = unboundInput();
	return {
		...input,
		binderHash: createHash("sha256")
			.update(
				`codemem-test-browser:binder:coordinator-a:${input.attemptId}:${input.browserTransactionHash}`,
			)
			.digest("hex"),
	};
}
