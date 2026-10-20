import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComfyStore, type FrozenComfyInput } from './store.js';

const instanceId = '1096749550260588544';
const now = 1_000;
let directory: string;
let database: Database.Database;
let competingDatabase: Database.Database;
let store: ComfyStore;
let competitor: ComfyStore;

function input(requestKey = 'request-1', workflowId = 'fixture'): FrozenComfyInput {
  return {
    adapterId: 'comfyui-v1', requestKey, workflowId,
    values: { text: 'hello', seed: 0, enabled: false }, media: { image: 'asset-1', reference: 'asset-2' },
    profile: { id: workflowId, version: '1', graph: { '1': { class_type: 'Render', inputs: { text: '' } } },
      bindings: { text: { nodeId: '1', input: 'text' } }, outputNodeIds: ['1'] }
  };
}

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'comfy-store-test-'));
  const file = path.join(directory, 'pool.sqlite');
  database = new Database(file);
  competingDatabase = new Database(file);
  store = new ComfyStore(database);
  competitor = new ComfyStore(competingDatabase);
  store.registerInstances([instanceId, '2']);
  store.updateInstance(instanceId, { state: 'ready' });
  store.updateInstance('2', { state: 'ready' });
});

afterEach(() => {
  competingDatabase?.close();
  database?.close();
  if (!directory) return;
  const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
  rmSync(directory, { recursive: true, force: true });
});

describe('ComfyStore submission idempotency', () => {
  it('replays the same owner/request key across connections without replacing its frozen input or deadline', () => {
    const original = store.submit('owner-a', input(), 60_000, now);
    const replay = competitor.submit('owner-a', input(), 120_000, now + 1_000);
    expect(original.created).toBe(true);
    expect(replay).toEqual({ job: original.job, created: false });
    expect(store.queued()).toHaveLength(1);
    expect(JSON.parse(original.job.input)).toEqual(input());
    expect(original.job.deadline).toBe(now + 60_000);
    expect(original.job.prompt_id).toBeTruthy();
  });

  it('scopes the same request key by owner and isolates owner listings', () => {
    const first = store.submit('owner-a', input(), 60_000, now).job;
    const second = competitor.submit('owner-b', input(), 60_000, now).job;
    expect(first.id).not.toBe(second.id);
    expect(first.prompt_id).not.toBe(second.prompt_id);
    expect(store.list('owner-a').map(job => job.id)).toEqual([first.id]);
    expect(competitor.list('owner-b').map(job => job.id)).toEqual([second.id]);
    expect(store.list('unknown')).toEqual([]);
  });

  it('canonicalizes values and media key order for the fingerprint', () => {
    const original = store.submit('owner-a', input(), 60_000, now);
    const reordered = { ...input(), media: { reference: 'asset-2', image: 'asset-1' },
      values: { enabled: false, seed: 0, text: 'hello' } };
    const replay = competitor.submit('owner-a', reordered, 60_000, now + 1);
    expect(replay.created).toBe(false);
    expect(replay.job.fingerprint).toBe(original.job.fingerprint);
    expect(replay.job.id).toBe(original.job.id);
  });

  it.each(['workflow', 'value', 'media'] as const)('rejects conflicting %s input without overwriting the original', field => {
    const original = store.submit('owner-a', input(), 60_000, now).job;
    const changed = input();
    if (field === 'workflow') changed.workflowId = 'other-workflow';
    if (field === 'value') changed.values.seed = 1;
    if (field === 'media') changed.media.image = 'different-asset';
    expect(() => competitor.submit('owner-a', changed, 60_000, now + 1)).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'COMFY_REQUEST_CONFLICT' })
    );
    expect(store.get(original.id)).toEqual(original);
    expect(store.queued()).toHaveLength(1);
  });
});

describe('ComfyStore slot claims', () => {
  it('allows only one active job per slot across database connections', () => {
    const first = store.submit('owner-a', input('first'), 60_000, now).job;
    const second = store.submit('owner-a', input('second'), 60_000, now + 1).job;
    expect(store.claim(instanceId, ['fixture'], now + 2)).toMatchObject({ id: first.id,
      stage: 'preparing', instance_id: instanceId });
    expect(competitor.claim(instanceId, ['fixture'], now + 2)).toBeUndefined();
    expect(store.instance(instanceId)).toMatchObject({ state: 'busy', job_id: first.id });
    expect(competitor.get(second.id)).toMatchObject({ stage: 'queued', instance_id: null });
    expect(competitor.claim('2', ['fixture'], now + 2)).toMatchObject({ id: second.id, instance_id: '2' });
  });

  it('never assigns one queued job to two slots', () => {
    const job = store.submit('owner-a', input(), 60_000, now).job;
    expect(competitor.claim('2', ['fixture'], now + 1)?.id).toBe(job.id);
    expect(store.claim(instanceId, ['fixture'], now + 1)).toBeUndefined();
    expect(store.instance(instanceId)).toMatchObject({ state: 'ready', job_id: null });
  });

  it('skips expired and unsupported jobs and claims only a matching workflow', () => {
    const expired = store.submit('owner-a', input('expired'), 1, now).job;
    const unsupported = store.submit('owner-a', input('unsupported', 'other'), 60_000, now + 1).job;
    const supported = store.submit('owner-a', input('supported'), 60_000, now + 2).job;
    expect(competitor.claim(instanceId, ['fixture'], now + 3)?.id).toBe(supported.id);
    expect(store.get(expired.id)?.stage).toBe('queued');
    expect(store.get(unsupported.id)?.stage).toBe('queued');
    expect(store.claim('2', ['missing'], now + 3)).toBeUndefined();
    expect(store.claim('2', ['other'], now + 3)?.id).toBe(unsupported.id);
  });

  it.each(['offline', 'starting', 'busy', 'closing', 'quarantined'] as const)('does not claim a %s instance', state => {
    store.submit('owner-a', input(), 60_000, now);
    store.updateInstance(instanceId, { state });
    expect(competitor.claim(instanceId, ['fixture'], now + 1)).toBeUndefined();
  });

  it('does not claim a draining, occupied, or unregistered instance', () => {
    store.submit('owner-a', input(), 60_000, now);
    store.updateInstance(instanceId, { draining: 1 });
    expect(competitor.claim(instanceId, ['fixture'], now + 1)).toBeUndefined();
    store.updateInstance(instanceId, { draining: 0, job_id: 'existing-job' });
    expect(competitor.claim(instanceId, ['fixture'], now + 1)).toBeUndefined();
    expect(competitor.claim('unregistered', ['fixture'], now + 1)).toBeUndefined();
  });

  it('releases only the slot while preserving result_pending for collection', () => {
    const original = store.submit('owner-a', input('original'), 60_000, now).job;
    store.claim(instanceId, ['fixture'], now + 1);
    const result = JSON.stringify({ hash: 'pending-private-result' });
    store.updateJob(original.id, { stage: 'succeeded', result, result_pending: 1 });
    competitor.releaseSlot(original.id);
    expect(store.instance(instanceId)).toMatchObject({ state: 'ready', job_id: null });
    expect(store.pendingResults(instanceId)).toEqual([expect.objectContaining({ id: original.id,
      stage: 'succeeded', instance_id: instanceId, result_pending: 1, result })]);
    expect(store.pendingResults('2')).toEqual([]);
    const next = store.submit('owner-a', input('next'), 60_000, now + 2).job;
    expect(store.claim(instanceId, ['fixture'], now + 3)?.id).toBe(next.id);
    competitor.releaseSlot(original.id);
    expect(store.instance(instanceId)?.job_id).toBe(next.id);
    expect(store.pendingResults(instanceId).map(job => job.id)).toEqual([original.id]);
    store.updateJob(original.id, { result_pending: 0 });
    expect(competitor.pendingResults(instanceId)).toEqual([]);
    expect(store.get(original.id)?.result).toBe(result);
  });

  it('keeps a draining instance offline after releasing its slot', () => {
    const job = store.submit('owner-a', input(), 60_000, now).job;
    store.claim(instanceId, ['fixture'], now + 1);
    store.updateInstance(instanceId, { draining: 1 });
    competitor.releaseSlot(job.id);
    expect(store.instance(instanceId)).toMatchObject({ draining: 1, state: 'offline', job_id: null });
  });
});

describe('ComfyStore worker leases', () => {
  it('rejects competing owners, renews the current owner, and transfers ownership at expiry', () => {
    expect(store.acquireWorker('worker-a', now)).toBe(true);
    expect(competitor.acquireWorker('worker-b', now)).toBe(false);
    expect(store.ownsWorker('worker-a', now)).toBe(true);
    expect(competitor.ownsWorker('worker-b', now)).toBe(false);
    expect(store.acquireWorker('worker-a', now + 1_000)).toBe(true);
    expect(competitor.acquireWorker('worker-b', now + 30_000)).toBe(false);
    expect(store.ownsWorker('worker-a', now + 31_000)).toBe(false);
    expect(competitor.acquireWorker('worker-b', now + 31_000)).toBe(true);
    expect(store.acquireWorker('worker-a', now + 31_001)).toBe(false);
    store.releaseWorker('worker-a');
    expect(competitor.ownsWorker('worker-b', now + 31_001)).toBe(true);
    competitor.releaseWorker('worker-b');
    expect(store.acquireWorker('worker-a', now + 31_002)).toBe(true);
  });
});
