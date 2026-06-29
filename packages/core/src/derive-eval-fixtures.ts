export interface DeriveEvalFixture {
	name: string;
	kind: string;
	title: string;
	bodyText: string;
	expectDerived: boolean;
}

export const DERIVE_EVAL_FIXTURES: DeriveEvalFixture[] = [
	{
		name: "M1 modal contract",
		kind: "decision",
		title: "Handlers must return structured errors",
		bodyText: "Handlers must return structured errors instead of throwing uncaught exceptions.",
		expectDerived: true,
	},
	{
		name: "M2 embedded contract with validation telemetry",
		kind: "change",
		title: "CI passed after handler contract was confirmed",
		bodyText: "CI passed after confirming handlers must return structured errors.",
		expectDerived: true,
	},
	{
		name: "pure validation telemetry",
		kind: "change",
		title: "CI passed",
		bodyText: "pnpm run tsc passed and lint was green.",
		expectDerived: false,
	},
];
