import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { AigateError } from './aigate-client.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore } from './store.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
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
  const { service, platform, submit, store, db } = fixture(true);
  submit();
  platform.openInstance.mockRejectedValueOnce(new AigateError('TIMEOUT', 'Unknown outcome'));
  await service.tick();
  await service.tick();
  expect(platform.openInstance).toHaveBeenCalledTimes(1);
  expect(store.instance('1')).toMatchObject({ state: 'starting', action_sent: 1 });
  db.prepare('UPDATE comfy_instances SET action_started_at=? WHERE id=?').run(Date.now() - 60_001, '1');
  await service.tick();
  expect(store.instance('1')).toMatchObject({ state: 'quarantined', error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT' });
  expect(platform.openInstance).toHaveBeenCalledTimes(1);
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
