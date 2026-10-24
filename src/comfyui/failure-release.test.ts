import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { AigateError } from './aigate-client.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore } from './store.js';
import { schedulerPolicy } from './scheduler.js';

const contexts: Array<{ service: ComfyService; db: Database.Database }> = [];
function fixture() {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const db = new Database(':memory:');
  const store = new ComfyStore(db);
  const platform = { getInstanceStatus: vi.fn().mockResolvedValue('22'), getInstance: vi.fn(),
    openInstance: vi.fn(), closeInstance: vi.fn(), releaseInstance: vi.fn(), pageInstances: vi.fn().mockResolvedValue({ total: 0, records: [] }) };
  const client = { health: vi.fn(), queue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
    history: vi.fn().mockResolvedValue({ state: 'missing', outputs: [] }), findAttempt: vi.fn(),
    submit: vi.fn(), upload: vi.fn(), download: vi.fn() };
  const configuration: ComfyServiceOptions['configuration'] = {
    autoOpen: true, pollIntervalMs: 1000, bootTimeoutMs: 30_000, jobTimeoutMs: 3_600_000,
    instances: [{ id: '1', baseUrl: 'https://native.waas.aigate.cc', workflowIds: ['render'],
      lifecycle: { allowRelease: true, rebuildVerified: true, hourlyCost: 1, storageHourlyCost: 0.1 } }],
    workflows: [{ id: 'render', version: '1', graph: { '1': { class_type: 'Render', inputs: {} } }, bindings: {}, outputNodeIds: ['1'] }],
    elastic: { enabled: false, maxInstances: 1, createCooldownMs: 60_000, releaseAfterMs: 1_800_000, reconcileTimeoutMs: 300_000,
      stoppedRetention: { maxInstances: 1, excessReleaseAfterMs: 60_000 }, templates: [] },
  };
  configuration.scheduler = schedulerPolicy(configuration);
  const options: ComfyServiceOptions = { store, configuration, owner: 'owner', platform, client: () => client,
    assets: { get: vi.fn(), read: vi.fn() }, ownsAsset: () => false, results: { save: vi.fn(), read: vi.fn() } };
  const service = new ComfyService(options);
  contexts.push({ service, db });
  let sequence = 0;
  function job() {
    const next = service.submit({ adapterId: 'comfyui-v1', requestKey: String(sequence++), workflowId: 'render', values: {}, media: {} }).job;
    store.updateInstance('1', { state: 'ready', draining: 0 });
    store.claim('1', ['render']);
    return store.get(next.id)!;
  }
  return { service, store, db, platform, client, configuration, job };
}
afterEach(async () => {
  for (const { service, db } of contexts.splice(0)) { await service.close(); db.close(); }
  vi.restoreAllMocks();
});

test.each(['22', '26'])('immediately ends an accepted execution on stopped platform %s without reopening or waiting for deadline/retention', async status => {
  const c = fixture();
  const job = c.job();
  c.store.updateJob(job.id, { stage: 'running', provider_confirmed: 1 });
  c.platform.getInstanceStatus.mockResolvedValue(status);
  await c.service.tick();
  expect(c.store.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_EXECUTION_CLOSED', prompt_id: job.prompt_id, collected_at: null });
  expect(c.store.instance('1')).toMatchObject({ draining: 1, job_id: null });
  expect(c.platform.releaseInstance).toHaveBeenCalledExactlyOnceWith('1');
  expect(c.platform.openInstance).not.toHaveBeenCalled();
  expect(c.client.submit).not.toHaveBeenCalled();
  expect(c.service.publicJob(c.store.get(job.id)!)).toMatchObject({ status: 'failed', error: { code: 'COMFY_EXECUTION_CLOSED' } });
  expect(await c.service.requestResultAvailability(job.id)).toEqual(c.store.get(job.id));
  await c.service.reconcile(job.id);
  expect(() => c.service.resumeSubmission(job.id, 'retry')).toThrowError(expect.objectContaining({ statusCode: 410 }));
  expect(c.client.history).not.toHaveBeenCalled();
});

test('disposes an old failed execution resumed into queued without a slot and leaves fresh demand available for another instance', async () => {
  const c = fixture();
  const job = c.job();
  c.store.updateJob(job.id, { stage: 'queued', provider_confirmed: 1 });
  c.store.releaseSlot(job.id);
  const fresh = c.service.submit({ adapterId: 'comfyui-v1', requestKey: 'fresh', workflowId: 'render', values: {}, media: {} }).job;
  c.store.updateInstance('1', { state: 'waiting_capacity' });
  await c.service.tick();
  expect(c.store.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_EXECUTION_CLOSED' });
  expect(c.store.get(fresh.id)).toMatchObject({ stage: 'queued', instance_id: null });
  expect(c.platform.releaseInstance).toHaveBeenCalledExactlyOnceWith('1');
  expect(c.platform.openInstance).not.toHaveBeenCalled();
});

test('immediately releases a stopped instance after archive failure despite fresh queued demand', async () => {
  const c = fixture();
  const job = c.job();
  c.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_ARCHIVE_TRANSFER_FAILED' });
  c.store.releaseSlot(job.id);
  c.store.updateInstance('1', { state: 'starting' });
  c.service.submit({ adapterId: 'comfyui-v1', requestKey: 'fresh', workflowId: 'render', values: {}, media: {} });
  await c.service.tick();
  expect(c.platform.releaseInstance).toHaveBeenCalledExactlyOnceWith('1');
  expect(c.platform.openInstance).not.toHaveBeenCalled();
});

test('stops failed compute immediately, releases only after platform stop confirmation and reconciles release without resending', async () => {
  const c = fixture();
  const job = c.job();
  c.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED' });
  c.platform.getInstanceStatus.mockResolvedValue('2');
  c.client.queue.mockResolvedValue({ running: [{ promptId: job.prompt_id }], pending: [] });
  await c.service.tick();
  expect(c.platform.closeInstance).toHaveBeenCalledExactlyOnceWith('1');
  expect(c.platform.releaseInstance).not.toHaveBeenCalled();
  await c.service.tick();
  expect(c.platform.closeInstance).toHaveBeenCalledTimes(1);
  c.platform.getInstanceStatus.mockResolvedValue('22');
  c.platform.releaseInstance.mockRejectedValue(new AigateError('TIMEOUT', 'response lost', undefined, true));
  await c.service.tick();
  expect(c.platform.releaseInstance).toHaveBeenCalledExactlyOnceWith('1');
  await c.service.tick();
  expect(c.platform.releaseInstance).toHaveBeenCalledTimes(1);
  c.platform.pageInstances.mockResolvedValue({ total: 1, records: [{ id: '1', status: '4', services: [] }] });
  await c.service.tick();
  expect(c.configuration.instances).toEqual([]);
  expect(c.store.resources()[0]?.state).toBe('released');
});

test('preserves another running job on the same instance and refuses new claims until it finishes', async () => {
  const c = fixture();
  const old = c.job();
  c.store.updateJob(old.id, { stage: 'failed', error_code: 'COMFY_ARCHIVE_TRANSFER_FAILED' });
  c.store.releaseSlot(old.id);
  const current = c.job();
  c.store.updateJob(current.id, { stage: 'running', provider_confirmed: 1 });
  c.client.history.mockResolvedValue({ state: 'running', outputs: [] });
  c.platform.getInstanceStatus.mockResolvedValue('2');
  await c.service.tick();
  expect(c.store.get(current.id)?.stage).toBe('running');
  expect(c.store.instance('1')).toMatchObject({ draining: 1, job_id: current.id });
  expect(c.platform.closeInstance).not.toHaveBeenCalled();
  expect(c.platform.releaseInstance).not.toHaveBeenCalled();
  c.store.updateJob(current.id, { stage: 'succeeded', result_pending: 0, native_checkpoint: null });
  c.store.releaseSlot(current.id);
  await c.service.tick();
  expect(c.platform.closeInstance).toHaveBeenCalledExactlyOnceWith('1');
});

test('does not close external queue work while retiring a failed result', async () => {
  const c = fixture();
  const job = c.job();
  c.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_ARCHIVE_TRANSFER_FAILED' });
  c.store.releaseSlot(job.id);
  c.platform.getInstanceStatus.mockResolvedValue('2');
  c.client.queue.mockResolvedValue({ running: [{ promptId: 'other-task' }], pending: [] });
  await c.service.tick();
  expect(c.platform.closeInstance).not.toHaveBeenCalled();
  expect(c.store.instance('1')?.error_code).toBe('COMFY_EXTERNAL_OCCUPANCY');
});

test('does not discard or power off a healthy accepted running execution', async () => {
  const c = fixture();
  const job = c.job();
  c.store.updateJob(job.id, { stage: 'running', provider_confirmed: 1 });
  c.platform.getInstanceStatus.mockResolvedValue('2');
  c.client.history.mockResolvedValue({ state: 'running', outputs: [] });
  await c.service.tick();
  expect(c.store.get(job.id)?.stage).toBe('running');
  expect(c.platform.closeInstance).not.toHaveBeenCalled();
  expect(c.platform.releaseInstance).not.toHaveBeenCalled();
});

test('does not discard a queued preparation checkpoint that has never sent a native attempt', async () => {
  const c = fixture();
  const job = c.job();
  c.store.updateJob(job.id, { stage: 'queued', native_checkpoint: JSON.stringify({ attempts: [], mediaValues: {}, nextAt: Date.now(), windowStart: 0 }) });
  c.store.releaseSlot(job.id);
  c.platform.openInstance.mockResolvedValue(undefined);
  await c.service.tick();
  expect(c.store.get(job.id)).toMatchObject({ stage: 'queued', error_code: null });
  expect(c.platform.releaseInstance).not.toHaveBeenCalled();
});

test('stops failed compute even when the native API is unreachable instead of paying for endless health retries', async () => {
  const c = fixture();
  const job = c.job();
  c.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_ARCHIVE_TRANSFER_FAILED' });
  c.store.releaseSlot(job.id);
  c.platform.getInstanceStatus.mockResolvedValue('2');
  c.client.queue.mockRejectedValue(new Error('unreachable GPU'));
  await c.service.tick();
  expect(c.platform.closeInstance).toHaveBeenCalledExactlyOnceWith('1');
  c.platform.getInstanceStatus.mockResolvedValue('22');
  await c.service.tick();
  expect(c.platform.releaseInstance).toHaveBeenCalledExactlyOnceWith('1');
});

test('keeps a late submission receipt as evidence without reviving an execution already closed during the HTTP request', async () => {
  const c = fixture();
  const job = c.job();
  c.platform.getInstanceStatus.mockResolvedValue('2');
  let accept!: (value: { promptId: string }) => void;
  c.client.submit.mockImplementation(() => new Promise(resolve => { accept = resolve; }));
  const submitting = c.service.tick();
  await vi.waitFor(() => expect(c.client.submit).toHaveBeenCalledTimes(1));
  c.platform.getInstanceStatus.mockResolvedValue('22');
  await c.service.tick();
  accept({ promptId: 'late-original-prompt' });
  await submitting;
  expect(c.store.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_EXECUTION_CLOSED',
    provider_confirmed: 1, prompt_id: 'late-original-prompt', result: null, result_pending: 0 });
  expect(JSON.parse(c.store.get(job.id)!.native_checkpoint!).attempts[0]).toMatchObject({ confirmed: true, promptId: 'late-original-prompt' });
  expect(c.platform.releaseInstance).toHaveBeenCalledExactlyOnceWith('1');
  await c.service.tick();
  expect(c.client.submit).toHaveBeenCalledTimes(1);
  expect(c.platform.openInstance).not.toHaveBeenCalled();
});

test('does not resurrect a disposed execution when an in-flight history query returns a late successful video', async () => {
  const c = fixture();
  const job = c.job();
  c.store.updateJob(job.id, { stage: 'running', provider_confirmed: 1 });
  c.platform.getInstanceStatus.mockResolvedValue('2');
  let finish!: (value: { state: string; outputs: unknown[] }) => void;
  c.client.history.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const querying = c.service.tick();
  await vi.waitFor(() => expect(c.client.history).toHaveBeenCalledTimes(1));
  c.platform.getInstanceStatus.mockResolvedValue('22');
  await c.service.tick();
  finish({ state: 'succeeded', outputs: [{ nodeId: '1', filename: 'late.mp4', subfolder: '', type: 'output' }] });
  await querying;
  expect(c.store.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_EXECUTION_CLOSED', result: null, result_pending: 0 });
  expect(c.platform.releaseInstance).toHaveBeenCalledExactlyOnceWith('1');
  expect(c.client.download).not.toHaveBeenCalled();
});
