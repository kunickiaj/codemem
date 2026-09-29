import { useEffect, useRef, useState } from "preact/hooks";
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
	const model = {
		observerModel: values.observerModel,
		observerSimpleModel: values.observerSimpleModel,
		observerRichModel: values.observerRichModel,
	}[id];
	const provider = providerOverride?.trim().toLowerCase() || values.observerProvider;
	const [models, setModels] = useState<ModelOption[]>([]);
	const [checking, setChecking] = useState(false);
	const [status, setStatus] = useState("");
	const selected = useRef("");
	selected.current = `${provider}:${model}`;
	useEffect(() => {
		let current = true;
		void catalogModels().then((options) => {
			if (current) setModels(options);
		});
		return () => {
			current = false;
		};
	}, []);
	useEffect(() => setStatus(""), [provider, model]);
	const selectedProvider = provider || (model.startsWith("claude") ? "anthropic" : "openai");
	async function checkModel() {
		const checkedSelection = selected.current;
		setChecking(true);
		setStatus("Checking selected model…");
		try {
			const response = await fetch("/api/observer-model-check", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: selectedProvider, model: model.trim() }),
			});
			const result = (await response.json()) as {
				available?: boolean;
				status?: string;
				error?: string;
			};
			if (selected.current !== checkedSelection) return;
			setStatus(
				result.available
					? "Verified with a request to the current OpenCode service."
					: (result.error ??
							`Not verified: ${result.status ?? "request failed"}. Check the selected provider and model.`),
			);
		} catch {
			if (selected.current === checkedSelection) {
				setStatus("Could not check this model. Try again when OpenCode is running.");
			}
		} finally {
			setChecking(false);
		}
	}
	return (
		<>
			<datalist id={`${id}-catalog`}>
				{models
					.filter((item) => item.provider === selectedProvider)
					.map((item) => (
						<option key={`${item.provider}:${item.model}`} value={item.model} />
					))}
			</datalist>
			<div className="small">
				Catalog suggestions are unverified. A check sends synthetic text through your active
				OpenCode connection and may use API billing.
			</div>
			<button disabled={!model.trim() || checking} onClick={() => void checkModel()} type="button">
				{checking ? "Checking model…" : "Check this model"}
			</button>
			<div aria-live="polite" className="small" role="status">
				{status}
			</div>
		</>
	);
}
