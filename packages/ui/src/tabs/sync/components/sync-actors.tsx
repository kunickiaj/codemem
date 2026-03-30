import type { TargetedInputEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { renderIntoSyncMount } from './render-root';
import {
  actorLabel,
  actorMergeNote,
  assignedActorCount,
  mergeTargetActors,
} from '../helpers';
import type { ActorLike } from '../view-model';

type SyncActorRowProps = {
  actor: ActorLike;
  hiddenLocalDuplicateCount: number;
  onRename: (actorId: string, displayName: string) => Promise<void>;
  onMerge: (primaryActorId: string, secondaryActorId: string) => Promise<void>;
};

type SyncActorsListProps = {
  actors: ActorLike[];
  hiddenLocalDuplicateCount: number;
  onRename: (actorId: string, displayName: string) => Promise<void>;
  onMerge: (primaryActorId: string, secondaryActorId: string) => Promise<void>;
};

function localActorNote(hiddenLocalDuplicateCount: number): string {
  if (hiddenLocalDuplicateCount <= 0) {
    return 'Used for this device and same-person devices.';
  }
  return `Used for this device and same-person devices. ${hiddenLocalDuplicateCount} unresolved duplicate ${hiddenLocalDuplicateCount === 1 ? 'entry is' : 'entries are'} hidden until reviewed in Needs attention.`;
}

function SyncActorRow({ actor, hiddenLocalDuplicateCount, onRename, onMerge }: SyncActorRowProps) {
  const actorId = String(actor.actor_id || '');
  const label = actorLabel(actor);
  const count = assignedActorCount(actorId);
  const mergeTargets = mergeTargetActors(actorId);
  const mergeTargetKeys = mergeTargets.map((target) => String(target.actor_id || '')).join('|');
  const [name, setName] = useState(label);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameLabel, setRenameLabel] = useState('Rename');
  const [mergeBusy, setMergeBusy] = useState(false);
  const [mergeLabel, setMergeLabel] = useState('Combine into selected person');
  const [mergeTargetId, setMergeTargetId] = useState('');

  useEffect(() => {
    setName(label);
    setRenameBusy(false);
    setRenameLabel('Rename');
    setMergeBusy(false);
    setMergeLabel('Combine into selected person');
    setMergeTargetId('');
  }, [actorId, count, hiddenLocalDuplicateCount, label, mergeTargetKeys]);

  const mergeNote = !mergeTargets.length
    ? 'No people available to combine yet. Create another person or use You.'
    : actorMergeNote(mergeTargetId, actorId);

  async function rename() {
    const nextName = name.trim();
    if (!nextName) return;
    setRenameBusy(true);
    setRenameLabel('Saving…');
    let ok = false;
    try {
      await onRename(actorId, nextName);
      ok = true;
    } catch {
      setRenameLabel('Retry rename');
    } finally {
      setRenameBusy(false);
      if (ok) setRenameLabel('Rename');
    }
  }

  async function merge() {
    if (!mergeTargetId) return;
    const target = mergeTargets.find((candidate) => String(candidate.actor_id || '') === mergeTargetId);
    if (!target) return;
    if (
      !window.confirm(
        `Combine ${label} into ${actorLabel(target)}? Assigned devices move now, but older memories keep their current stamped provenance for now.`,
      )
    ) {
      return;
    }
    setMergeBusy(true);
    setMergeLabel('Merging…');
    let ok = false;
    try {
      await onMerge(mergeTargetId, actorId);
      ok = true;
    } catch {
      setMergeLabel('Retry merge');
    } finally {
      setMergeBusy(false);
      if (ok) setMergeLabel('Combine into selected person');
    }
  }

  return (
    <div className="actor-row">
      <div className="actor-details">
        <div className="actor-title">
          <strong>{label}</strong>
          <span className={`badge actor-badge${actor.is_local ? ' local' : ''}`}>
            {actor.is_local ? 'Local' : `${count} device${count === 1 ? '' : 's'}`}
          </span>
        </div>
        <div className="peer-meta">
          {actor.is_local ? localActorNote(hiddenLocalDuplicateCount) : `${count} assigned device${count === 1 ? '' : 's'}`}
        </div>
      </div>

      <div className="actor-actions">
        {actor.is_local ? (
          <div className="peer-meta">Rename in config</div>
        ) : (
          <>
            <input
              aria-label={`Rename ${label}`}
              className="peer-scope-input actor-name-input"
              disabled={renameBusy || mergeBusy}
              value={name}
              onInput={(event: TargetedInputEvent<HTMLInputElement>) =>
                setName(event.currentTarget.value)
              }
            />
            <button className="settings-button" disabled={renameBusy || mergeBusy} onClick={() => void rename()}>
              {renameLabel}
            </button>
            <div className="actor-merge-controls">
              <select
                aria-label={`Combine ${label} into another person`}
                className="sync-actor-select actor-merge-select"
                disabled={mergeBusy}
                value={mergeTargetId}
                onChange={(event) => setMergeTargetId(event.currentTarget.value)}
              >
                <option value="">Combine into person</option>
                {mergeTargets.map((target) => {
                  const targetId = String(target.actor_id || '');
                  return (
                    <option key={targetId} value={targetId}>
                      {target.is_local ? `${actorLabel(target)} (local)` : actorLabel(target)}
                    </option>
                  );
                })}
              </select>
              <button
                className="settings-button"
                disabled={mergeBusy || mergeTargets.length === 0}
                onClick={() => void merge()}
              >
                {mergeLabel}
              </button>
            </div>
            <div className="peer-meta actor-merge-note">{mergeNote}</div>
          </>
        )}
      </div>
    </div>
  );
}

function SyncActorsList({ actors, hiddenLocalDuplicateCount, onRename, onMerge }: SyncActorsListProps) {
  if (!actors.length) {
    return <div className="sync-empty-state">No people yet. Create one to represent yourself or a teammate.</div>;
  }

  return (
    <>
      {actors.map((actor) => {
        const actorId = String(actor.actor_id || actor.display_name || actor.is_local || '');
        return (
          <SyncActorRow
            key={actorId}
            actor={actor}
            hiddenLocalDuplicateCount={hiddenLocalDuplicateCount}
            onRename={onRename}
            onMerge={onMerge}
          />
        );
      })}
    </>
  );
}

export function renderSyncActorsList(mount: HTMLElement, props: SyncActorsListProps) {
  renderIntoSyncMount(mount, <SyncActorsList {...props} />);
}
