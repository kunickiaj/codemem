import { useEffect, useState } from "preact/hooks";
import type { SettingsFormState } from "../data/types";

interface ModelOption {
	provider: string;
	model: string;
}

let catalog: { loadedAt: number; promise: Promise<ModelOption[]> } | null = null;

function catalogModels(): Promise<ModelOption[]> {
	if (catalog && Date.now() - catalog.loadedAt < 60_000) return catalog.promise;
	const promise = fetch("/api/observer-model-catalog")
		.then((response) => response.json())
		.then((data: { models?: ModelOption[] }) => (Array.isArray(data.models) ? data.models : []))
		.catch(() => []);
	catalog = { loadedAt: Date.now(), promise };
	return promise;
}

export function ObserverModelAvailability({
	id,
	values,
	provider: providerOverride,
}: {
	id: "observerModel" | "observerSimpleModel" | "observerRichModel";
	values: SettingsFormState;
	provider?: string;
}) {
	const model = values[id];
	let provider = providerOverride?.trim().toLowerCase() || values.observerProvider;
	if (values.observerRuntime === "codex_sidecar") provider = "openai";
	else if (values.observerRuntime === "claude_sidecar") provider = "anthropic";
	const [models, setModels] = useState<ModelOption[]>([]);
	useEffect(() => {
		let current = true;
		void catalogModels().then((options) => {
			if (current) setModels(options);
		});
		return () => {
			current = false;
		};
	}, []);
	const selectedProvider = provider || (model.startsWith("claude") ? "anthropic" : "openai");
	const suggestions = models.filter((item) => item.provider === selectedProvider);
	return (
		<>
			<datalist id={`${id}-catalog`}>
				{suggestions.map((item) => (
					<option key={`${item.provider}:${item.model}`} value={item.model} />
				))}
			</datalist>
			{suggestions.length ? (
				<div className="small">
					OpenCode V2 catalog suggestions are unverified for this connection.
				</div>
			) : null}
		</>
	);
}

export function catalogValues(
	values: SettingsFormState,
	runtime: string,
	explicit: boolean,
): SettingsFormState {
	return { ...values, observerRuntime: explicit ? runtime : "api_http" };
}
