import { pathToFileURL } from "node:url";
import type {
	HistoricalObserverFailureV1,
	HistoricalObserverRequestV1,
	HistoricalObserverResponseV1,
} from "./types.js";

function failure(
	code: HistoricalObserverFailureV1["error"]["code"],
	message: string,
): HistoricalObserverFailureV1 {
	return { schema_version: 1, ok: false, error: { code, message } };
}

function parseRequest(value: unknown): HistoricalObserverRequestV1 {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new TypeError("request must be an object");
	const request = value as Partial<HistoricalObserverRequestV1>;
	if (request.schema_version !== 1 || request.operation !== "build_observer_prompt")
		throw new TypeError("unsupported historical observer request");
	if (request.observer_context_schema_version !== 1)
		throw new TypeError("observer_context_schema_version must be 1");
	if (!request.context || typeof request.context !== "object" || Array.isArray(request.context))
		throw new TypeError("request.context must be an object");
	return request as HistoricalObserverRequestV1;
}

async function main(): Promise<HistoricalObserverResponseV1> {
	const modulePath = process.argv[2];
	if (!modulePath) return failure("invalid_request", "historical observer module path is required");
	let request: HistoricalObserverRequestV1;
	try {
		const chunks: Buffer[] = [];
		for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
		request = parseRequest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	} catch (error) {
		return failure("invalid_request", error instanceof Error ? error.message : String(error));
	}
	try {
		const subject = (await import(pathToFileURL(modulePath).href)) as {
			buildObserverPrompt?: (context: HistoricalObserverRequestV1["context"]) => unknown;
		};
		if (typeof subject.buildObserverPrompt !== "function")
			return failure(
				"unsupported_subject",
				"historical module does not export buildObserverPrompt",
			);
		const result = subject.buildObserverPrompt(request.context);
		if (
			!result ||
			typeof result !== "object" ||
			Array.isArray(result) ||
			typeof (result as { system?: unknown }).system !== "string" ||
			typeof (result as { user?: unknown }).user !== "string"
		) {
			return failure("unsupported_subject", "buildObserverPrompt returned an unsupported result");
		}
		return { schema_version: 1, ok: true, result: result as { system: string; user: string } };
	} catch (error) {
		return failure(
			"subject_execution_failed",
			error instanceof Error ? error.message : String(error),
		);
	}
}

process.stdout.write(`${JSON.stringify(await main())}\n`);
