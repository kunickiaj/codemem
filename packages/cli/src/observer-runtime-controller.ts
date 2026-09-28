import {
	buildTieredObserverSelection,
	type ObserverClient,
	type RawEventSweeper,
} from "@codemem/core";

type TierPreview = {
	provider: string;
	model: string;
	runtime: string;
	reasoningEffort: string | null;
};

export type ObserverApplyStatus = {
	state: "active" | "applying" | "failed";
	message?: string;
	active: {
		provider: string;
		model: string;
		runtime: string;
		authType: string;
		tierRoutingEnabled: boolean;
		simple: TierPreview;
		rich: TierPreview;
	};
};

/** Keep the live observer and saved config separate until in-flight work has drained. */
export class ObserverRuntimeController {
	private activeObserver: ObserverClient;
	private revision = 0;
	private work: Promise<void> | null = null;
	private stopped = false;
	private state: ObserverApplyStatus["state"] = "active";
	private message: string | undefined;

	constructor(
		observer: ObserverClient,
		private readonly sweeper: Pick<RawEventSweeper, "reconfigureObserver">,
		private readonly createObserver: () => ObserverClient,
	) {
		this.activeObserver = observer;
	}

	getObserver(): ObserverClient {
		return this.activeObserver;
	}

	getStatus(): ObserverApplyStatus {
		const active = this.activeObserver.getStatus();
		const config = this.activeObserver.toConfig();
		const previewTier = (tier: "simple" | "rich"): TierPreview => {
			const selected = config.observerTierRoutingEnabled
				? buildTieredObserverSelection(config, { tier, observer: {}, reasons: [] }).observer
				: config;
			return {
				provider: selected.observerProvider ?? active.provider,
				model: selected.observerModel ?? active.model,
				runtime: selected.observerRuntime ?? active.runtime,
				reasoningEffort: selected.observerReasoningEffort ?? null,
			};
		};
		return {
			state: this.state,
			...(this.message ? { message: this.message } : {}),
			active: {
				provider: active.provider,
				model: active.model,
				runtime: active.runtime,
				authType: active.auth.type,
				tierRoutingEnabled: config.observerTierRoutingEnabled === true,
				simple: previewTier("simple"),
				rich: previewTier("rich"),
			},
		};
	}

	requestApply(): boolean {
		if (this.stopped) return false;
		this.revision += 1;
		this.state = "applying";
		this.message = undefined;
		this.startWork();
		return true;
	}

	private startWork(): void {
		if (this.work) return;
		this.work = this.applyLatest().finally(() => {
			this.work = null;
			if (!this.stopped && this.state === "applying") this.startWork();
		});
	}

	private async applyLatest(): Promise<void> {
		while (!this.stopped) {
			const revision = this.revision;
			try {
				const next = await this.sweeper.reconfigureObserver(this.createObserver, {
					shouldResume: () => !this.stopped && this.revision === revision,
				});
				if (!next) continue;
				this.activeObserver = next;
				this.state = "active";
				return;
			} catch {
				if (revision !== this.revision) continue;
				this.state = "failed";
				this.message =
					"Observer settings were saved but could not be applied. Retry applying settings.";
				return;
			}
		}
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.revision += 1;
		await this.work;
	}
}
