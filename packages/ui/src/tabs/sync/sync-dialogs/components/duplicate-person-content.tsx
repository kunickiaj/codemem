/* Two-step content for the duplicate-person dialog. Step 1 lets the
 * operator pick whether the actors represent the same person or not;
 * step 2 picks which record to keep and which one to merge in. The
 * component resolves the outer dialog via resolveCurrentDialog so the
 * merge vs different-people vs cancel decision flows back to the
 * caller. */

import { useEffect, useState } from "preact/hooks";
import { RadixRadioGroup } from "../../../../components/primitives/radix-radio-group";
import { RadixSelect } from "../../../../components/primitives/radix-select";
import { resolveCurrentDialog } from "../internal";
import type { DuplicatePersonDialogRequest } from "../types";

export function DuplicatePersonDialogContent({
	descriptionId,
	request,
}: {
	descriptionId: string;
	request: DuplicatePersonDialogRequest;
}) {
	const [step, setStep] = useState<"choice" | "merge">("choice");
	const defaultPrimary =
		request.actors.find((actor) => actor.isLocal)?.actorId || request.actors[0]?.actorId || "";
	const [primaryActorId, setPrimaryActorId] = useState(defaultPrimary);
	const [secondaryActorId, setSecondaryActorId] = useState("");

	useEffect(() => {
		setStep("choice");
		const nextPrimaryActorId =
			request.actors.find((actor) => actor.isLocal)?.actorId || request.actors[0]?.actorId || "";
		const nextSecondaryActorId =
			request.actors.find((actor) => actor.actorId !== nextPrimaryActorId)?.actorId || "";
		setPrimaryActorId(nextPrimaryActorId);
		setSecondaryActorId(nextSecondaryActorId);
	}, [request]);

	const primary =
		request.actors.find((actor) => actor.actorId === primaryActorId) || request.actors[0];
	const mergeCandidates = request.actors.filter((actor) => actor.actorId !== primaryActorId);
	const secondary =
		mergeCandidates.find((actor) => actor.actorId === secondaryActorId) || mergeCandidates[0];
	const primaryOptions = request.actors.map((actor) => ({
		label: (
			<>
				{actor.label}
				{actor.isLocal ? " (You)" : ""}
			</>
		),
		value: actor.actorId,
	}));
	const mergeOptions = mergeCandidates.map((actor) => ({
		label: `${actor.label}${actor.isLocal ? " (You)" : ""}`,
		value: actor.actorId,
	}));

	return step === "choice" ? (
		<div className="sync-dialog-stack">
			<ul className="sync-dialog-choice-list">
				<li>
					<button
						autoFocus
						className="settings-button"
						data-sync-primary-action="true"
						onClick={() => setStep("merge")}
						type="button"
					>
						These are both me
					</button>
				</li>
				<li>
					<button
						className="settings-button"
						onClick={() => resolveCurrentDialog({ action: "different-people" })}
						type="button"
					>
						These are different people
					</button>
				</li>
				<li>
					<button
						className="settings-button"
						onClick={() => resolveCurrentDialog({ action: "cancel" })}
						type="button"
					>
						Decide later
					</button>
				</li>
			</ul>
		</div>
	) : (
		<div className="sync-dialog-stack">
			<div className="small" id={descriptionId}>
				Choose which person should remain after combining these duplicates.
			</div>
			<RadixRadioGroup
				ariaDescribedby={descriptionId}
				ariaLabel="Person to keep after combining duplicates"
				autoFocusValue={primaryActorId}
				indicatorClassName="sync-dialog-radio-indicator"
				itemClassName="sync-dialog-radio-option"
				itemLabelClassName="sync-dialog-radio-label"
				name="syncDuplicatePrimaryActor"
				onValueChange={setPrimaryActorId}
				options={primaryOptions}
				rootClassName="sync-dialog-radio-list"
				value={primaryActorId}
			/>
			<div className="field">
				<label className="small" htmlFor="syncDuplicateSecondaryActor">
					Person to combine into the selected record
				</label>
				<RadixSelect
					ariaLabel="Person to combine into the selected record"
					contentClassName="sync-radix-select-content sync-actor-select-content"
					disabled={mergeOptions.length === 0}
					id="syncDuplicateSecondaryActor"
					itemClassName="sync-radix-select-item"
					onValueChange={setSecondaryActorId}
					options={mergeOptions}
					placeholder="No merge target available"
					triggerClassName="sync-radix-select-trigger sync-dialog-input"
					value={secondary?.actorId || ""}
					viewportClassName="sync-radix-select-viewport"
				/>
			</div>
			<div className="sync-dialog-actions">
				<button className="settings-button" onClick={() => setStep("choice")} type="button">
					Back
				</button>
				<button
					className="settings-button"
					disabled={!primary?.actorId || !secondary?.actorId}
					onClick={() => {
						if (!primary?.actorId || !secondary?.actorId) return;
						resolveCurrentDialog({
							action: "merge",
							primaryActorId: primary.actorId,
							secondaryActorId: secondary.actorId,
						});
					}}
					type="button"
				>
					Combine people
				</button>
			</div>
		</div>
	);
}
