import type { TargetedInputEvent } from "preact";
import { useEffect, useState } from "preact/hooks";
import { RadixSelect } from "../../../components/primitives/radix-select";
import { TextInput } from "../../../components/primitives/text-input";
import { handlePrimaryActionKeyboard } from "../../../lib/keyboard";
import {
	actorDisplayLabel,
	actorLabel,
	actorMergeNote,
	assignedActorCount,
	mergeTargetActors,
} from "../helpers";
import { openSyncConfirmDialog } from "../sync-dialogs";
import type { ActorLike } from "../view-model";
import { renderIntoSyncMount } from "./render-root";
import { SyncEmptyState } from "./sync-empty-state";

type SyncActorRowProps = {
	actor: ActorLike;
	hiddenLocalDuplicateCount: number;
	onRename: (actorId: string, displayName: string) => Promise<void>;
	onMerge: (primaryActorId: string, secondaryActorId: string) => Promise<void>;
	onDeactivate: (actorId: string) => Promise<void>;
};

type SyncActorsListProps = {
	actors: ActorLike[];
	/** Whether this device may add, rename, merge or remove people. */
	canManagePeople: boolean;
	hiddenLocalDuplicateCount: number;
	onRename: (actorId: string, displayName: string) => Promise<void>;
	onMerge: (primaryActorId: string, secondaryActorId: string) => Promise<void>;
	onDeactivate: (actorId: string) => Promise<void>;
};

function localActorNote(hiddenLocalDuplicateCount: number): string {
	if (hiddenLocalDuplicateCount <= 0) {
		return "Represents you across your own devices.";
	}
	return `Represents you across your own devices. ${hiddenLocalDuplicateCount} unresolved duplicate ${hiddenLocalDuplicateCount === 1 ? "entry is" : "entries are"} hidden until reviewed in Needs attention.`;
}

function ActorDetails({
	actor,
	count,
	hiddenLocalDuplicateCount,
}: {
	actor: ActorLike;
	count: number;
	hiddenLocalDuplicateCount: number;
}) {
	return (
		<div className="actor-details">
			<div className="actor-title">
				<strong>{actorDisplayLabel(actor)}</strong>
				<span
					className={`badge actor-badge${actor.is_local ? " local" : ""}`}
					title={actor.is_local ? localActorNote(hiddenLocalDuplicateCount) : undefined}
				>
					{actor.is_local ? "You" : `${count} device${count === 1 ? "" : "s"}`}
				</span>
			</div>
			{!actor.is_local ? (
				<div className="peer-meta">
					{count} assigned device{count === 1 ? "" : "s"}
				</div>
			) : null}
		</div>
	);
}

/** Another person, shown without controls on a device that may not change people. */
function ReadOnlyActorRow({ actor }: { actor: ActorLike }) {
	return (
		<div className="actor-row">
			<ActorDetails
				actor={actor}
				count={assignedActorCount(String(actor.actor_id || ""))}
				hiddenLocalDuplicateCount={0}
			/>
		</div>
	);
}

function SyncActorRow({
	actor,
	hiddenLocalDuplicateCount,
	onRename,
	onMerge,
	onDeactivate,
}: SyncActorRowProps) {
	const actorId = String(actor.actor_id || "");
	const label = actorLabel(actor);
	const count = assignedActorCount(actorId);
	const mergeTargets = mergeTargetActors(actorId);
	const mergeTargetKeys = mergeTargets.map((target) => String(target.actor_id || "")).join("|");
	const [name, setName] = useState(label);
	const [renameBusy, setRenameBusy] = useState(false);
	const [renameLabel, setRenameLabel] = useState("Rename");
	const [mergeBusy, setMergeBusy] = useState(false);
	const [mergeLabel, setMergeLabel] = useState("Merge into selected person");
	const [mergeTargetId, setMergeTargetId] = useState("");
	const [advancedOpen, setAdvancedOpen] = useState(false);

	useEffect(() => {
		setName(label);
		setRenameBusy(false);
		setRenameLabel("Rename");
		setMergeBusy(false);
		setMergeLabel("Merge into selected person");
		setMergeTargetId("");
		setAdvancedOpen(false);
	}, [actorId, count, hiddenLocalDuplicateCount, label, mergeTargetKeys]);

	const mergeNote = !mergeTargets.length
		? "No other people are listed yet."
		: actorMergeNote(mergeTargetId, actorId);
	const mergeOptions = [
		{ label: "Merge into person", value: "" },
		...mergeTargets.map((target) => {
			const targetId = String(target.actor_id || "");
			return {
				label: target.is_local ? actorDisplayLabel(target) : actorLabel(target),
				value: targetId,
			};
		}),
	];

	async function rename() {
		const nextName = name.trim();
		if (!nextName) return;
		setRenameBusy(true);
		setRenameLabel("Saving…");
		let ok = false;
		try {
			await onRename(actorId, nextName);
			ok = true;
		} catch {
			setRenameLabel("Retry rename");
		} finally {
			setRenameBusy(false);
			if (ok) setRenameLabel("Rename");
		}
	}

	async function merge() {
		if (!mergeTargetId) return;
		const target = mergeTargets.find(
			(candidate) => String(candidate.actor_id || "") === mergeTargetId,
		);
		if (!target) return;
		const confirmed = await openSyncConfirmDialog({
			title: `Merge ${label} into ${actorLabel(target)}?`,
			description:
				"Assigned devices move now, but older memories keep their current stamped provenance for now.",
			confirmLabel: "Merge people",
			cancelLabel: "Keep separate",
			tone: "danger",
		});
		if (!confirmed) {
			return;
		}
		setMergeBusy(true);
		setMergeLabel("Merging…");
		let ok = false;
		try {
			await onMerge(mergeTargetId, actorId);
			ok = true;
		} catch {
			setMergeLabel("Retry merge");
		} finally {
			setMergeBusy(false);
			if (ok) setMergeLabel("Merge into selected person");
		}
	}

	return (
		<div className="actor-row">
			<ActorDetails
				actor={actor}
				count={count}
				hiddenLocalDuplicateCount={hiddenLocalDuplicateCount}
			/>

			<div className="actor-actions">
				{actor.is_local ? (
					<div className="peer-meta">Rename yourself in config</div>
				) : (
					<>
						<TextInput
							aria-label={`Rename ${label}`}
							className="peer-scope-input actor-name-input"
							disabled={renameBusy || mergeBusy}
							type="text"
							value={name}
							onInput={(event: TargetedInputEvent<HTMLInputElement>) =>
								setName(event.currentTarget.value)
							}
							onKeyDown={(event: KeyboardEvent) =>
								handlePrimaryActionKeyboard(event, {
									onSubmit: () => void rename(),
									disabled: renameBusy || mergeBusy || !name.trim(),
								})
							}
						/>
						<button
							type="button"
							className="settings-button"
							data-primary-action="true"
							disabled={renameBusy || mergeBusy}
							onClick={() => void rename()}
						>
							{renameLabel}
						</button>
						<button
							type="button"
							className="settings-button danger"
							disabled={renameBusy || mergeBusy}
							onClick={async () => {
								const confirmed = await openSyncConfirmDialog({
									title: `Remove ${label} from all sharing?`,
									description:
										"All of their devices lose access to every Project shared with them, including direct shares and access through any Team. Memories already on those devices stay there. This can't be undone.",
									confirmLabel: "Remove from all sharing",
									cancelLabel: "Keep",
									tone: "danger",
								});
								if (confirmed) await onDeactivate(actorId);
							}}
						>
							Remove from all sharing
						</button>
						<button
							type="button"
							className="settings-button"
							disabled={renameBusy || mergeBusy}
							onClick={() => setAdvancedOpen((open) => !open)}
						>
							{advancedOpen ? "Hide duplicate cleanup" : "Show duplicate cleanup"}
						</button>
						{advancedOpen ? (
							<>
								<div className="peer-meta actor-merge-note">
									Use this only when combining duplicate people into one.
								</div>
								<div className="actor-merge-controls">
									<RadixSelect
										ariaLabel={`Merge ${label} into another person`}
										disabled={mergeBusy || mergeTargets.length === 0}
										onValueChange={setMergeTargetId}
										options={mergeOptions}
										placeholder="Merge into person"
										triggerClassName="actor-merge-select"
										value={mergeTargetId}
									/>
									<button
										type="button"
										className="settings-button"
										disabled={mergeBusy || mergeTargets.length === 0 || !mergeTargetId}
										onClick={() => void merge()}
									>
										{mergeLabel}
									</button>
								</div>
								<div className="peer-meta actor-merge-note">{mergeNote}</div>
							</>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}

function SyncActorsList({
	actors,
	canManagePeople,
	hiddenLocalDuplicateCount,
	onRename,
	onMerge,
	onDeactivate,
}: SyncActorsListProps) {
	if (!actors.length) {
		return (
			<SyncEmptyState
				detail="People appear here after you share a Project or invite someone to a Team."
				title="No people set up yet."
			/>
		);
	}

	return (
		<>
			{actors.map((actor) => {
				const actorId = String(actor.actor_id || actor.display_name || actor.is_local || "");
				if (!canManagePeople && !actor.is_local) {
					return <ReadOnlyActorRow key={actorId} actor={actor} />;
				}
				return (
					<SyncActorRow
						key={actorId}
						actor={actor}
						hiddenLocalDuplicateCount={hiddenLocalDuplicateCount}
						onRename={onRename}
						onMerge={onMerge}
						onDeactivate={onDeactivate}
					/>
				);
			})}
		</>
	);
}

export function renderSyncActorsList(mount: HTMLElement, props: SyncActorsListProps) {
	renderIntoSyncMount(mount, <SyncActorsList {...props} />);
}
