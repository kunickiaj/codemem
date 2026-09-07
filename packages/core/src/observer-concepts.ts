/** Canonical concept taxonomy shared by observer extraction surfaces. */
export const OBSERVER_CONCEPTS = [
	"how-it-works",
	"why-it-exists",
	"what-changed",
	"problem-solution",
	"gotcha",
	"pattern",
	"trade-off",
] as const;

export type ObserverConcept = (typeof OBSERVER_CONCEPTS)[number];

export const OBSERVER_CONCEPT_SET = new Set<string>(OBSERVER_CONCEPTS);
