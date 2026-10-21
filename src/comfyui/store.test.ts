import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ComfyStore, type ComfyResource, type FrozenComfyInput } from './store.js';

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

describe('ComfyStore upload reservations', () => {
  function reserve(requestKey = 'upload'): string {
    const job = store.submit('owner-a', { ...input(requestKey), transport: 'direct' }, 60_000, now).job;
    expect(store.claim(instanceId, ['fixture'], now + 1)).toMatchObject({ id: job.id, upload_reservations: 1, reservation_started_at: now + 1 });
    store.updateJob(job.id, { stage: 'awaiting_upload' });
    return job.id;
  }

  it('initializes the queue budget separately from the execution deadline', () => {
    const job = store.submit('owner-a', input(), 60_000, now).job;
    expect(job).toMatchObject({ deadline: now + 60_000, queue_deadline: now + 21_600_000,
      upload_reservations: 0, eligible_at: null, reservation_started_at: null });
    expect(store.claim(instanceId, ['fixture'], now + 1)).toMatchObject({ upload_reservations: 0, reservation_started_at: null });
    expect(store.submit('owner-a', input('long'), 30_000_000, now).job.queue_deadline).toBe(now + 30_000_000);
  });

  it('requeues fairly, preserves affinity and prompt identity, and rejects a duplicate expiry', () => {
    const id = reserve();
    const promptId = store.get(id)!.prompt_id;
    const next = store.submit('owner-a', input('next'), 60_000, now + 2).job;
    expect(competitor.requeueUpload(id, 100, now + 3)).toBe(true);
    expect(store.get(id)).toMatchObject({ stage: 'queued', instance_id: instanceId, prompt_id: promptId,
      deadline: now + 21_600_000, eligible_at: now + 103, reservation_started_at: null,
      upload_reservations: 1, error_code: 'COMFY_UPLOAD_RESERVATION_EXPIRED' });
    expect(store.instance(instanceId)).toMatchObject({ state: 'ready', job_id: null });
    expect(store.requeueUpload(id, 200, now + 4)).toBe(false);
    expect(store.claim(instanceId, ['fixture'], now + 104)?.id).toBe(next.id);
    expect(competitor.claim('2', ['fixture'], now + 104)).toBeUndefined();
    store.updateJob(next.id, { stage: 'succeeded' });
    store.releaseSlot(next.id);
    expect(competitor.claim(instanceId, ['fixture'], now + 105)).toMatchObject({ id,
      instance_id: instanceId, upload_reservations: 2, reservation_started_at: now + 105 });
    store.releaseSlot(next.id);
    expect(store.instance(instanceId)?.job_id).toBe(id);
  });

  it('waits until the exact eligible timestamp and cannot move a delayed upload to another instance', () => {
    const id = reserve();
    expect(store.requeueUpload(id, 100, now + 2)).toBe(true);
    expect(competitor.claim(instanceId, ['fixture'], now + 101)).toBeUndefined();
    expect(competitor.claim('2', ['fixture'], now + 102)).toBeUndefined();
    expect(store.claim(instanceId, ['fixture'], now + 102)?.id).toBe(id);
  });

  it.each([
    { stage: 'preparing' as const }, { stage: 'running' as const }, { stage: 'succeeded' as const },
    { cancel_requested: 1 }, { provider_confirmed: 1 }, { direct_inputs: '{}' }, { queue_deadline: now + 2 }, { queue_deadline: now + 1 },
  ])('does not requeue an unsafe or expired reservation: %j', patch => {
    const id = reserve();
    store.updateJob(id, patch);
    const prior = store.get(id);
    expect(competitor.requeueUpload(id, 100, now + 2)).toBe(false);
    expect(store.get(id)).toEqual(prior);
    expect(store.instance(instanceId)?.job_id).toBe(id);
  });

  it('uses the legacy budget fallback and keeps draining slots offline', () => {
    const id = reserve();
    store.updateJob(id, { queue_deadline: null });
    store.updateInstance(instanceId, { draining: 1 });
    expect(store.requeueUpload(id, 0, now + 2)).toBe(true);
    expect(store.get(id)?.deadline).toBe(now + 21_600_000);
    expect(store.instance(instanceId)).toMatchObject({ job_id: null, state: 'offline' });
    expect(store.requeueUpload('missing', 0, now)).toBe(false);
  });

  it('does not release a different current occupant when an old upload expires', () => {
    const id = reserve();
    store.releaseSlot(id);
    const next = store.submit('owner-a', input('next'), 60_000, now + 2).job;
    expect(store.claim(instanceId, ['fixture'], now + 3)?.id).toBe(next.id);
    const prior = store.get(id);
    expect(store.requeueUpload(id, 100, now + 4)).toBe(false);
    expect(store.get(id)).toEqual(prior);
    expect(store.instance(instanceId)?.job_id).toBe(next.id);
  });

  it('rejects reservations without a registered bound instance and owned slot', () => {
    const job = store.submit('owner-a', { ...input(), transport: 'direct' }, 60_000, now).job;
    store.updateJob(job.id, { stage: 'awaiting_upload' });
    expect(store.requeueUpload(job.id, 100, now + 1)).toBe(false);
    store.updateJob(job.id, { stage: 'queued' });
    store.claim(instanceId, ['fixture'], now + 1);
    store.updateJob(job.id, { stage: 'awaiting_upload' });
    store.releaseSlot(job.id);
    expect(store.requeueUpload(job.id, 100, now + 2)).toBe(false);
    database.prepare('DELETE FROM comfy_instances WHERE id=?').run(instanceId);
    expect(store.requeueUpload(job.id, 100, now + 2)).toBe(false);
  });
});

describe('ComfyStore lifecycle persistence', () => {
  it('migrates legacy jobs conservatively and preserves the migration across reopen', () => {
    const legacy = new Database(':memory:');
    try {
      legacy.exec(`CREATE TABLE comfy_jobs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        input TEXT NOT NULL, stage TEXT NOT NULL, instance_id TEXT, prompt_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, deadline INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        error_code TEXT, result TEXT, result_pending INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0, provider_confirmed INTEGER NOT NULL DEFAULT 0, UNIQUE(owner, request_key)
      );`);
      const insert = legacy.prepare("INSERT INTO comfy_jobs(id,owner,request_key,fingerprint,input,stage,instance_id,prompt_id,created_at,deadline,updated_at) VALUES(?,'owner',?,'hash',?,'queued',?,'prompt',?,?,?)");
      insert.run('unassigned', 'unassigned', JSON.stringify(input()), null, now, now + 60_000, now);
      insert.run('assigned', 'assigned', JSON.stringify(input('assigned', 'bound')), instanceId, now, now + 60_000, now);
      insert.run('long', 'long', JSON.stringify(input()), null, now, now + 30_000_000, now);
      const migrated = new ComfyStore(legacy);
      expect(migrated.get('unassigned')).toMatchObject({ queue_deadline: now + 60_000, deadline: now + 60_000,
        upload_reservations: 0, eligible_at: null, reservation_started_at: null });
      expect(migrated.get('assigned')?.queue_deadline).toBe(now + 21_600_000);
      expect(migrated.get('long')?.queue_deadline).toBe(now + 30_000_000);
      migrated.updateJob('assigned', { upload_reservations: 3, eligible_at: now + 100, queue_deadline: now + 200, reservation_started_at: now + 10 });
      const reopened = new ComfyStore(legacy);
      expect(reopened.get('assigned')).toMatchObject({ upload_reservations: 3, eligible_at: now + 100, queue_deadline: now + 200, reservation_started_at: now + 10 });
      reopened.registerInstances([instanceId, '2']);
      expect(reopened.instance(instanceId)).toMatchObject({ idle_since: null, stopped_at: null });
      reopened.updateInstance(instanceId, { state: 'ready' });
      reopened.updateInstance('2', { state: 'ready' });
      expect(reopened.claim('2', ['bound'], now + 100)).toBeUndefined();
      expect(reopened.claim(instanceId, ['bound'], now + 100)?.id).toBe('assigned');
    } finally { legacy.close(); }
  });

  it('persists instance idle and stopped timestamps across connections', () => {
    expect(store.instance(instanceId)).toMatchObject({ idle_since: null, stopped_at: null });
    store.updateInstance(instanceId, { idle_since: now, stopped_at: now + 1 });
    expect(competitor.instance(instanceId)).toMatchObject({ idle_since: now, stopped_at: now + 1 });
    competitor.updateInstance(instanceId, { idle_since: null, stopped_at: null });
    expect(store.instance(instanceId)).toMatchObject({ idle_since: null, stopped_at: null });
  });

  it('upserts resource lifecycle idempotently and persists JSON without tokens', () => {
    const row: ComfyResource = { key: 'resource-1', name: 'worker', state: 'creating', instance_id: null,
      configuration: JSON.stringify({ baseUrl: 'https://worker.invalid', token: 'secret', nested: { apiToken: 'secret', workflowIds: ['fixture'] } }),
      template_id: 'template', hourly_cost: 2, storage_hourly_cost: 0.1, created_at: now, updated_at: now, error_code: null };
    store.saveResource(row);
    competitor.saveResource(row);
    const saved = { ...row, configuration: JSON.stringify({ baseUrl: 'https://worker.invalid', nested: { workflowIds: ['fixture'] } }) };
    expect(store.resources()).toEqual([saved]);
    expect(competitor.resource(row.key)).toEqual(saved);
    competitor.saveResource({ ...saved, state: 'registered', instance_id: instanceId, updated_at: now + 1 });
    expect(store.resource(row.key)).toEqual({ ...saved, state: 'registered', instance_id: instanceId, updated_at: now + 1 });
    store.saveResource({ ...saved, state: 'released', configuration: null, updated_at: now + 2 });
    expect(competitor.resource(row.key)).toMatchObject({ state: 'released', configuration: null, updated_at: now + 2 });
    expect(competitor.resources()).toHaveLength(1);
    expect(store.resource('missing')).toBeUndefined();
    expect(() => store.saveResource({ ...saved, configuration: 'not-json' })).toThrow();
    expect(store.resource(row.key)?.state).toBe('released');
  });

  it.each(['queued', 'preparing', 'awaiting_upload', 'submitting', 'running', 'collecting'] as const)('protects bound %s work even without an occupied slot', stage => {
    const job = store.submit('owner-a', input(), 60_000, now).job;
    store.claim(instanceId, ['fixture'], now + 1);
    store.updateJob(job.id, { stage });
    store.releaseSlot(job.id);
    expect(competitor.hasUnresolvedWork(instanceId)).toBe(true);
    expect(store.hasUnresolvedWork('2')).toBe(false);
  });

  it('protects terminal occupied slots and uncollected results until both are cleared', () => {
    expect(store.hasUnresolvedWork(instanceId)).toBe(false);
    const job = store.submit('owner-a', input(), 60_000, now).job;
    expect(store.hasUnresolvedWork(instanceId)).toBe(false);
    store.claim(instanceId, ['fixture'], now + 1);
    store.updateJob(job.id, { stage: 'succeeded', result_pending: 1 });
    expect(competitor.hasUnresolvedWork(instanceId)).toBe(true);
    store.updateJob(job.id, { result_pending: 0 });
    expect(competitor.hasUnresolvedWork(instanceId)).toBe(true);
    store.updateJob(job.id, { result_pending: 1 });
    store.releaseSlot(job.id);
    expect(competitor.hasUnresolvedWork(instanceId)).toBe(true);
    store.updateJob(job.id, { result_pending: 0 });
    expect(competitor.hasUnresolvedWork(instanceId)).toBe(false);
    expect(store.hasUnresolvedWork('missing')).toBe(false);
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
