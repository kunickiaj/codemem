/* Narrative extraction from session-summary body text. */

export function extractNarrativeFromBody(bodyText: string): string | null {
	// Match sections like "## Completed\n...\n\n## Learned\n..."
	const sections: string[] = [];
	const lines = bodyText.split("\n");

	const readSection = (heading: string): string | null => {
		const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading}`);
		if (start < 0) return null;
		const body: string[] = [];
		for (const line of lines.slice(start + 1)) {
			if (line.trim().startsWith("## ")) break;
			body.push(line);
		}
		const value = body.join("\n").trim();
		return value || null;
	};

	const completed = readSection("completed");
	if (completed) {
		sections.push(completed);
	}

	const learned = readSection("learned");
	if (learned) {
		sections.push(learned);
	}

	if (sections.length === 0) return null;
	return sections.join("\n\n");
}
