import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { AigateError } from './aigate-client.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore } from './store.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });
function fixture(autoOpen = false, count = 1) {
  const db = new Database(':memory:');
  const store = new ComfyStore(db);
  const platform = {
    getInstanceStatus: vi.fn<ComfyServiceOptions['platform']['getInstanceStatus']>().mockResolvedValue('22'),
    openInstance: vi.fn<ComfyServiceOptions['platform']['openInstance']>().mockResolvedValue(undefined),
    closeInstance: vi.fn<ComfyServiceOptions['platform']['closeInstance']>().mockResolvedValue(undefined),
  };
  const client = {
    health: vi.fn().mockResolvedValue(undefined), queue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
    upload: vi.fn(), submit: vi.fn().mockImplementation(async ({ promptId }: { promptId: string }) => ({ promptId })),
    history: vi.fn().mockResolvedValue({ state: 'missing', outputs: [] }), findAttempt: vi.fn().mockResolvedValue(undefined), download: vi.fn(),
  };
  const service = new ComfyService({ store, platform, client: () => client,
    configuration: {
      autoOpen, pollIntervalMs: 5_000, bootTimeoutMs: 60_000, jobTimeoutMs: 120_000,
      instances: Array.from({ length: count }, (_, index) => ({ id: String(index + 1), baseUrl: `https://instance-${index + 1}.invalid`, workflowIds: ['tested'] })),
      workflows: [{ id: 'tested', version: '1', graph: { '1': { class_type: 'Test', inputs: { text: '' } } },
        bindings: { prompt: { nodeId: '1', input: 'text', required: true } }, outputNodeIds: ['1'] }],
    }, assets: { get: () => undefined, read: async () => undefined }, ownsAsset: () => false,
    results: { save: vi.fn(), read: async () => null }, owner: 'operator',
  });
  cleanup.push(async () => { await service.close(); db.close(); });
  const submit = (key = 'first') => service.submit({ adapterId: 'comfyui-v1', requestKey: key, workflowId: 'tested', values: { prompt: 'test' }, media: {} }).job;
  return { db, store, platform, client, service, submit };
}

test('a disabled auto-open policy never boots a stopped instance for a queued job', async () => {
  const { service, platform, submit, client } = fixture();
  const job = submit();
  await service.tick();
  expect(service.get(job.id).stage).toBe('queued');
  expect(platform.openInstance).not.toHaveBeenCalled();
  expect(client.submit).not.toHaveBeenCalled();
});

test('automatic opening reserves only the capacity required by pending work', async () => {
  const { service, platform, submit, store } = fixture(true, 3);
  submit();
  await service.tick();
  expect(platform.openInstance).toHaveBeenCalledTimes(1);
  expect(store.instances().filter(instance => instance.state === 'starting')).toHaveLength(1);
});

test('opening is sent once and tasks wait for platform running plus ComfyUI health and an empty queue', async () => {
  const { service, platform, submit, client, store } = fixture(true);
  const job = submit();
  await service.tick();
  expect(platform.openInstance).toHaveBeenCalledTimes(1);
  expect(client.submit).not.toHaveBeenCalled();
  platform.getInstanceStatus.mockResolvedValue('1');
  await service.tick();
  expect(client.health).not.toHaveBeenCalled();
  platform.getInstanceStatus.mockResolvedValue('2');
  client.health.mockRejectedValueOnce(new Error('Models still loading'));
  await service.tick();
  expect(client.submit).not.toHaveBeenCalled();
  expect(store.instance('1')?.state).toBe('starting');
  await service.tick();
  expect(service.get(job.id).stage).toBe('running');
  expect(platform.openInstance).toHaveBeenCalledTimes(1);
  expect(client.submit).toHaveBeenCalledTimes(1);
});

test('an opening timeout is reconciled by reads, never by blindly repeating the open operation', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, platform, submit, store, db } = fixture(true);
  const job = submit();
  platform.openInstance.mockRejectedValueOnce(new AigateError('TIMEOUT', 'Unknown outcome'));
  await service.tick();
  await service.tick();
  expect(platform.openInstance).toHaveBeenCalledTimes(1);
  expect(store.instance('1')).toMatchObject({ state: 'starting', action_sent: 1 });
  db.prepare('UPDATE comfy_instances SET action_started_at=? WHERE id=?').run(Date.now() - 60_001, '1');
  await service.tick();
  expect(store.instance('1')).toMatchObject({ state: 'offline', error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT',
    action_started_at: null, action_sent: 0, next_action_at: Date.now() + 30_000 });
  expect(service.publicJob(service.get(job.id))).toMatchObject({ status: 'queued', stage: 'queued', progress: {
    message: '任务已入队，GPU实例上次启动超时，正在退避后重新检查；不会重复提交生成任务',
    nextRetryAt: new Date(Date.now() + 30_000).toISOString(),
  } });
  platform.getInstanceStatus.mockClear();
  await service.tick();
  now.mockReturnValue(1_800_000_029_999);
  await service.tick();
  expect(platform.getInstanceStatus).not.toHaveBeenCalled();
  expect(platform.openInstance).toHaveBeenCalledTimes(1);
});

test.each([
  ['22', true], ['26', true], ['22', false], ['26', false],
] as const)('expired opening backoff checks status %s before applying auto-open %s', async (status, autoOpen) => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, platform, store, client, submit } = fixture(autoOpen);
  const job = submit();
  store.updateInstance('1', { state: 'offline', error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT', next_action_at: Date.now() + 30_000 });
  platform.getInstanceStatus.mockResolvedValue(status);
  await service.tick();
  expect(platform.getInstanceStatus).not.toHaveBeenCalled();
  expect(platform.openInstance).not.toHaveBeenCalled();
  now.mockReturnValue(1_800_000_030_000);
  await service.tick();
  expect(platform.getInstanceStatus).toHaveBeenCalledExactlyOnceWith('1');
  expect(platform.openInstance).toHaveBeenCalledTimes(autoOpen ? 1 : 0);
  if (autoOpen) expect(platform.getInstanceStatus.mock.invocationCallOrder[0]).toBeLessThan(platform.openInstance.mock.invocationCallOrder[0]!);
  expect(store.instance('1')?.state).toBe(autoOpen ? 'starting' : 'offline');
  expect(service.get(job.id).stage).toBe('queued');
  expect(client.submit).not.toHaveBeenCalled();
});

test('a running platform after opening backoff must pass health and queue checks before accepting work', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, platform, store, client, submit } = fixture(true);
  const job = submit();
  store.updateInstance('1', { state: 'offline', error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT', next_action_at: Date.now() });
  platform.getInstanceStatus.mockResolvedValue('2');
  client.health.mockRejectedValueOnce(new Error('Models still loading'));
  await service.tick();
  expect(client.health).toHaveBeenCalledTimes(1);
  expect(client.queue).not.toHaveBeenCalled();
  expect(client.submit).not.toHaveBeenCalled();
  expect(service.get(job.id).stage).toBe('queued');
  await service.tick();
  expect(client.health).toHaveBeenCalledTimes(2);
  expect(client.queue).toHaveBeenCalledTimes(1);
  expect(client.queue.mock.invocationCallOrder[0]).toBeLessThan(client.submit.mock.invocationCallOrder[0]!);
  expect(client.submit).toHaveBeenCalledTimes(1);
  expect(service.get(job.id).stage).toBe('running');
  expect(platform.openInstance).not.toHaveBeenCalled();
});

test.each(['running', 'pending'] as const)('foreign %s work after opening backoff remains quarantined', async queueState => {
  const { service, platform, store, client, submit } = fixture(true);
  const job = submit();
  store.updateInstance('1', { state: 'offline', error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT', next_action_at: Date.now() - 1 });
  platform.getInstanceStatus.mockResolvedValue('2');
  client.queue.mockResolvedValue({ running: [], pending: [], [queueState]: [{ promptId: 'foreign-job' }] });
  await service.tick();
  await service.tick();
  expect(store.instance('1')).toMatchObject({ state: 'quarantined', error_code: 'COMFY_EXTERNAL_OCCUPANCY' });
  expect(client.health).toHaveBeenCalledTimes(1);
  expect(client.queue).toHaveBeenCalledTimes(1);
  expect(platform.getInstanceStatus).toHaveBeenCalledTimes(1);
  expect(platform.openInstance).not.toHaveBeenCalled();
  expect(client.submit).not.toHaveBeenCalled();
  expect(service.get(job.id).stage).toBe('queued');
});

test('status 11 after opening backoff never blindly opens or claims work', async () => {
  const { service, platform, store, client, submit } = fixture(true);
  const job = submit();
  store.updateInstance('1', { state: 'offline', error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT', next_action_at: Date.now() - 1 });
  platform.getInstanceStatus.mockResolvedValue('11');
  await service.tick();
  await service.tick();
  expect(platform.getInstanceStatus).toHaveBeenCalledTimes(2);
  expect(platform.openInstance).not.toHaveBeenCalled();
  expect(client.health).not.toHaveBeenCalled();
  expect(client.submit).not.toHaveBeenCalled();
  expect(store.instance('1')?.state).toBe('offline');
  expect(service.get(job.id).stage).toBe('queued');
});

test('a historical action-timeout quarantine first becomes offline with a fresh durable backoff', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, platform, store, client, submit, db } = fixture(true);
  submit();
  store.updateInstance('1', { state: 'quarantined', error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT',
    action_started_at: Date.now() - 60_001, action_sent: 1 });
  await service.tick();
  expect(db.prepare('SELECT state, action_started_at, action_sent, next_action_at, error_code FROM comfy_instances WHERE id=?').get('1'))
    .toEqual({ state: 'offline', action_started_at: null, action_sent: 0, next_action_at: Date.now() + 30_000,
      error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT' });
  now.mockReturnValue(1_800_000_029_999);
  await service.tick();
  expect(platform.getInstanceStatus).not.toHaveBeenCalled();
  expect(platform.openInstance).not.toHaveBeenCalled();
  expect(client.submit).not.toHaveBeenCalled();
});

test.each([
  ['quarantined', 'other error'], ['quarantined', 'draining'], ['quarantined', 'pending result'], ['quarantined', 'bound job'],
  ['starting', 'draining'], ['starting', 'pending result'], ['starting', 'bound job'], ['closing', 'draining'],
] as const)('%s with %s cannot automatically unlock an action timeout', async (state, blocker) => {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, platform, store, client, submit, db } = fixture(true);
  const job = submit();
  const errorCode = blocker === 'other error' ? 'COMFY_EXTERNAL_OCCUPANCY' : 'COMFY_INSTANCE_ACTION_TIMEOUT';
  if (blocker === 'pending result' || blocker === 'bound job') db.prepare('UPDATE comfy_jobs SET instance_id=? WHERE id=?').run('1', job.id);
  if (blocker === 'pending result') store.updateJob(job.id, { stage: 'succeeded', result_pending: 1 });
  if (blocker === 'bound job') store.updateJob(job.id, { stage: 'awaiting_upload' });
  store.updateInstance('1', { state, error_code: errorCode, action_started_at: Date.now() - 60_001, action_sent: 1,
    draining: blocker === 'draining' ? 1 : 0, job_id: blocker === 'bound job' ? job.id : null });
  platform.getInstanceStatus.mockResolvedValue(state === 'closing' ? '11' : '22');
  await service.tick();
  await service.tick();
  expect(store.instance('1')).toMatchObject({ state: 'quarantined', error_code: errorCode, next_action_at: null });
  expect(platform.openInstance).not.toHaveBeenCalled();
  expect(platform.closeInstance).not.toHaveBeenCalled();
  expect(client.submit).not.toHaveBeenCalled();
});

test('explicit close is durable, drains first, and is confirmed by platform status', async () => {
  const { service, platform, store } = fixture();
  platform.getInstanceStatus.mockResolvedValue('2');
  service.control('1', 'close');
  expect(store.instance('1')).toMatchObject({ state: 'closing', draining: 1, action_sent: 0 });
  await service.tick();
  await service.tick();
  expect(platform.closeInstance).toHaveBeenCalledTimes(1);
  expect(store.instance('1')?.state).toBe('closing');
  platform.getInstanceStatus.mockResolvedValue('26');
  await service.tick();
  expect(store.instance('1')).toMatchObject({ state: 'offline', draining: 1 });
});

test('a drained instance never boots automatically or claims queued work', async () => {
  const { service, platform, client, submit } = fixture(true);
  submit();
  service.control('1', 'drain');
  await service.tick();
  expect(platform.openInstance).not.toHaveBeenCalled();
  expect(client.submit).not.toHaveBeenCalled();
});

test('draining during startup still converges to a closable ready state without claiming work', async () => {
  const { service, platform, client, submit, store, db } = fixture(true);
  submit();
  await service.tick();
  expect(store.instance('1')?.state).toBe('starting');
  service.control('1', 'drain');
  db.prepare('UPDATE comfy_instances SET action_started_at=? WHERE id=?').run(Date.now() - 60_001, '1');
  platform.getInstanceStatus.mockResolvedValue('2');
  await service.tick();
  expect(store.instance('1')).toMatchObject({ state: 'ready', draining: 1 });
  expect(client.submit).not.toHaveBeenCalled();
  expect(() => service.control('1', 'close')).not.toThrow();
  await service.tick();
  expect(platform.closeInstance).toHaveBeenCalledTimes(1);
});

test('closing rechecks the real instance queue and refuses to interrupt foreign work', async () => {
  const { service, platform, client, store } = fixture();
  platform.getInstanceStatus.mockResolvedValue('2');
  service.control('1', 'close');
  client.queue.mockResolvedValue({ running: [{ promptId: 'foreign' }], pending: [] });
  await service.tick();
  expect(platform.closeInstance).not.toHaveBeenCalled();
  expect(store.instance('1')).toMatchObject({ state: 'quarantined', error_code: 'COMFY_EXTERNAL_OCCUPANCY' });
});

test('unexpected external work quarantines the instance instead of sharing its generation slot', async () => {
  const { service, platform, client, store, submit } = fixture(true);
  platform.getInstanceStatus.mockResolvedValue('2');
  client.queue.mockResolvedValue({ running: [{ promptId: 'foreign-job' }], pending: [] });
  submit();
  await service.tick();
  expect(store.instance('1')).toMatchObject({ state: 'quarantined', error_code: 'COMFY_EXTERNAL_OCCUPANCY' });
  expect(client.submit).not.toHaveBeenCalled();
});
