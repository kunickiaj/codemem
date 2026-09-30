import { expect, it } from "vitest";
import { EMPTY_FORM_STATE } from "./constants";
import {
	getObserverModelDescription,
	getObserverModelHint,
	getObserverModelTooltip,
} from "./model-accessors";

it("points fallback guidance to the Connection model controls", () => {
	const values = { ...EMPTY_FORM_STATE, observerTierRoutingEnabled: true };
	for (const copy of [
		getObserverModelTooltip(values),
		getObserverModelDescription(values),
		getObserverModelHint(values, {}),
	]) {
		expect(copy).toContain("Connection");
		expect(copy).not.toContain("Processing");
	}
});
