import { Fragment } from 'preact';
import { clearSyncMount, renderIntoSyncMount } from './render-root';

export type SyncStatItem = {
  label: string;
  value: number | string;
};

export type SyncAttemptItem = {
  status: string;
  address: string;
  startedAt: string;
};

export type PairingView = {
  payloadText: string;
  hintText: string;
};

function DiagnosticsGrid({ items }: { items: SyncStatItem[] }) {
  return (
    <Fragment>
      {items.map((item, index) => (
        <div class="stat" key={`${item.label}-${index}`}>
          <div class="stat-content">
            <div class="value">{item.value}</div>
            <div class="label">{item.label}</div>
          </div>
        </div>
      ))}
    </Fragment>
  );
}

function AttemptsList({ attempts }: { attempts: SyncAttemptItem[] }) {
  return (
    <Fragment>
      {attempts.map((attempt, index) => (
        <div class="diag-line" key={`${attempt.startedAt}-${attempt.address}-${index}`}>
          <div class="left">
            <div>{attempt.status}</div>
            <div class="small">{attempt.address}</div>
          </div>
          <div class="right">{attempt.startedAt}</div>
        </div>
      ))}
    </Fragment>
  );
}

function PairingText({ text }: { text: string }) {
  return <Fragment>{text}</Fragment>;
}

export function renderDiagnosticsGrid(mount: HTMLElement, items: SyncStatItem[]) {
  if (!items.length) {
    clearSyncMount(mount);
    return;
  }

  renderIntoSyncMount(mount, <DiagnosticsGrid items={items} />);
}

export function renderAttemptsList(mount: HTMLElement, attempts: SyncAttemptItem[]) {
  if (!attempts.length) {
    clearSyncMount(mount);
    return;
  }

  renderIntoSyncMount(mount, <AttemptsList attempts={attempts} />);
}

export function renderPairingView(
  payloadMount: HTMLElement,
  hintMount: HTMLElement | null,
  view: PairingView,
) {
  renderIntoSyncMount(payloadMount, <PairingText text={view.payloadText} />);
  if (hintMount) {
    renderIntoSyncMount(hintMount, <PairingText text={view.hintText} />);
  }
}
