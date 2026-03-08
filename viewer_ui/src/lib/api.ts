/* API fetch wrappers — thin layer over the viewer HTTP endpoints. */

async function fetchJson(url: string): Promise<any> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`${url}: ${resp.status} ${resp.statusText}`);
  return resp.json();
}

export async function loadStats(): Promise<any> {
  return fetchJson('/api/stats');
}

export async function loadUsage(project: string): Promise<any> {
  return fetchJson(`/api/usage?project=${encodeURIComponent(project)}`);
}

export async function loadSession(project: string): Promise<any> {
  return fetchJson(`/api/session?project=${encodeURIComponent(project)}`);
}

export async function loadRawEvents(project: string): Promise<any> {
  return fetchJson(`/api/raw-events?project=${encodeURIComponent(project)}`);
}

export async function loadMemories(project: string): Promise<any> {
  return loadMemoriesPage(project);
}

function buildProjectParams(
  project: string,
  limit?: number,
  offset?: number,
  scope?: string,
): string {
  const params = new URLSearchParams();
  params.set('project', project || '');
  if (typeof limit === 'number') params.set('limit', String(limit));
  if (typeof offset === 'number') params.set('offset', String(offset));
  if (scope) params.set('scope', scope);
  return params.toString();
}

export async function loadMemoriesPage(
  project: string,
  options?: { limit?: number; offset?: number; scope?: string },
): Promise<any> {
  const query = buildProjectParams(project, options?.limit, options?.offset, options?.scope);
  return fetchJson(`/api/memories?${query}`);
}

export async function loadSummaries(project: string): Promise<any> {
  return loadSummariesPage(project);
}

export async function loadSummariesPage(
  project: string,
  options?: { limit?: number; offset?: number; scope?: string },
): Promise<any> {
  const query = buildProjectParams(project, options?.limit, options?.offset, options?.scope);
  return fetchJson(`/api/summaries?${query}`);
}

export async function loadConfig(): Promise<any> {
  return fetchJson('/api/config');
}

export async function saveConfig(payload: any): Promise<void> {
  const resp = await fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const msg = await resp.text();
    throw new Error(msg);
  }
}

export async function loadSyncStatus(includeDiagnostics: boolean): Promise<any> {
  const param = includeDiagnostics ? '?includeDiagnostics=1' : '';
  return fetchJson(`/api/sync/status${param}`);
}

export async function loadPairing(): Promise<any> {
  return fetchJson('/api/sync/pairing?includeDiagnostics=1');
}

export async function updatePeerScope(
  peerDeviceId: string,
  include: string[] | null,
  exclude: string[] | null,
  inheritGlobal = false,
): Promise<any> {
  const resp = await fetch('/api/sync/peers/scope', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peer_device_id: peerDeviceId,
      include,
      exclude,
      inherit_global: inheritGlobal,
    }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) {
    throw new Error(payload?.error || text || 'request failed');
  }
  return payload;
}

export async function updatePeerIdentity(peerDeviceId: string, claimedLocalActor: boolean): Promise<any> {
  const resp = await fetch('/api/sync/peers/identity', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      peer_device_id: peerDeviceId,
      claimed_local_actor: claimedLocalActor,
    }),
  });
  const text = await resp.text();
  const payload = text ? JSON.parse(text) : {};
  if (!resp.ok) throw new Error(payload?.error || text || 'request failed');
  return payload;
}

export async function loadProjects(): Promise<string[]> {
  const payload = await fetchJson('/api/projects');
  return payload.projects || [];
}

export async function triggerSync(address?: string): Promise<void> {
  const payload = address ? { address } : {};
  await fetch('/api/sync/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}
