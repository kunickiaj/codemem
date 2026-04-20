/* Narrative extraction from session-summary body text. */

export function extractNarrativeFromBody(bodyText: string): string | null {
	// Match sections like "## Completed\n...\n\n## Learned\n..."
	const sections: string[] = [];

	const completedMatch = bodyText.match(/##\s*Completed\s*\n([\s\S]*?)(?=\n##\s|\n*$)/);
	if (completedMatch?.[1]?.trim()) {
		sections.push(completedMatch[1].trim());
	}

	const learnedMatch = bodyText.match(/##\s*Learned\s*\n([\s\S]*?)(?=\n##\s|\n*$)/);
	if (learnedMatch?.[1]?.trim()) {
		sections.push(learnedMatch[1].trim());
	}

	if (sections.length === 0) return null;
	return sections.join("\n\n");
}
