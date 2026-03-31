import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/api', () => ({
  loadSyncStatus: vi.fn(),
  loadSyncActors: vi.fn(),
}));

vi.mock('../health', () => ({ renderHealthOverview: vi.fn() }));
vi.mock('./diagnostics', () => ({
  renderSyncStatus: vi.fn(),
  renderSyncAttempts: vi.fn(),
  renderPairing: vi.fn(),
  initDiagnosticsEvents: vi.fn(),
  setRenderSyncPeers: vi.fn(),
}));
vi.mock('./team-sync', () => ({
  renderTeamSync: vi.fn(),
  renderSyncSharingReview: vi.fn(),
  initTeamSyncEvents: vi.fn(),
  setLoadSyncData: vi.fn(),
}));
vi.mock('./people', () => ({
  renderSyncActors: vi.fn(),
  renderSyncPeers: vi.fn(),
  renderLegacyDeviceClaims: vi.fn(),
  initPeopleEvents: vi.fn(),
  setLoadSyncData: vi.fn(),
}));
vi.mock('./components/render-root', () => ({ ensureSyncRenderBoundary: vi.fn() }));
vi.mock('./sync-dialogs', () => ({ ensureSyncDialogHost: vi.fn() }));
vi.mock('./helpers', () => ({
  hideSkeleton: vi.fn(),
  readDuplicatePersonDecisions: vi.fn(() => ({})),
}));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('loadSyncData', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    const { state } = await import('../../lib/state');
    const { resetSyncLoadStateForTests } = await import('./index');
    resetSyncLoadStateForTests();
    state.activeTab = 'sync';
    state.currentProject = '';
    state.lastSyncPeers = [];
    state.pendingAcceptedSyncPeers = [];
    state.lastSyncActors = [];
    state.lastSyncCoordinator = null;
    state.lastSyncViewModel = null;
  });

  it('ignores stale out-of-order sync payloads from older refreshes', async () => {
    const api = await import('../../lib/api');
    const { state } = await import('../../lib/state');
    const { loadSyncData } = await import('./index');

    const first = deferred<{ peers: Array<{ peer_device_id: string }>; sharing_review: []; attempts: []; legacy_devices: [] }>();
    const second = deferred<{ peers: Array<{ peer_device_id: string }>; sharing_review: []; attempts: []; legacy_devices: [] }>();

    vi.mocked(api.loadSyncStatus)
      .mockReturnValueOnce(first.promise as never)
      .mockReturnValueOnce(second.promise as never);
    vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });

    const firstLoad = loadSyncData();
    const secondLoad = loadSyncData();

    second.resolve({
      peers: [{ peer_device_id: 'peer-new' }],
      sharing_review: [],
      attempts: [],
      legacy_devices: [],
    });
    await secondLoad;
    expect(state.lastSyncPeers.map((peer) => peer.peer_device_id)).toEqual(['peer-new']);

    first.resolve({
      peers: [{ peer_device_id: 'peer-old' }],
      sharing_review: [],
      attempts: [],
      legacy_devices: [],
    });
    await firstLoad;
    expect(state.lastSyncPeers.map((peer) => peer.peer_device_id)).toEqual(['peer-new']);
  });

  it('does not extend the health-tab cache ttl on cache hits', async () => {
    const api = await import('../../lib/api');
    const { state } = await import('../../lib/state');
    const { loadSyncData } = await import('./index');

    state.activeTab = 'health';

    vi.mocked(api.loadSyncStatus).mockResolvedValue({
      peers: [{ peer_device_id: 'peer-cached' }],
      sharing_review: [],
      attempts: [],
      legacy_devices: [],
    } as never);
    vi.mocked(api.loadSyncActors).mockResolvedValue({ items: [] });

    await loadSyncData();
    await loadSyncData();

    expect(api.loadSyncStatus).toHaveBeenCalledTimes(1);
  });
});
