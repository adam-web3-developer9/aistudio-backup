import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore } from './store.js';
import { schedulerPolicy } from './scheduler.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });

function fixture(count = 1) {
  const db = new Database(':memory:');
  const store = new ComfyStore(db);
  const clients = Array.from({ length: count }, () => ({
    health: vi.fn().mockResolvedValue(undefined), queue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
    upload: vi.fn(), submit: vi.fn().mockImplementation(async ({ promptId }: { promptId: string }) => ({ promptId })),
    history: vi.fn().mockResolvedValue({ state: 'running', outputs: [] }), findAttempt: vi.fn().mockResolvedValue(undefined), download: vi.fn(),
  }));
  const platform = { getInstanceStatus: vi.fn().mockResolvedValue('2'), openInstance: vi.fn().mockResolvedValue(undefined),
    closeInstance: vi.fn().mockResolvedValue(undefined), clearGpuIdleShutdown: vi.fn().mockResolvedValue(undefined) };
  const configuration: ComfyServiceOptions['configuration'] = {
    autoOpen: true, pollIntervalMs: 1000, bootTimeoutMs: 60000, jobTimeoutMs: 7_200_000,
    instances: clients.map((_, index) => ({ id: String(index + 1), baseUrl: 'https://test.invalid', workflowIds: ['test'] })),
    workflows: [{ id: 'test', version: '1', graph: { '1': { class_type: 'Test', inputs: { text: '' } } },
      bindings: { text: { nodeId: '1', input: 'text', required: true } }, outputNodeIds: ['1'] }],
  };
  configuration.scheduler = { ...schedulerPolicy(configuration), uploadReservationTimeoutMs: 60_000 };
  const service = new ComfyService({ store, configuration, platform, client: instance => clients[Number(instance.id) - 1]!,
    assets: { get: () => undefined, read: async () => undefined }, ownsAsset: () => false, owner: 'owner',
    results: { save: vi.fn(), read: async () => null } });
  cleanup.push(async () => { await service.close(); db.close(); });
  const submit = (key: string, direct = false) => service.submit({ adapterId: 'comfyui-v1', workflowId: 'test',
    requestKey: key, values: { text: key }, media: {}, ...(direct ? { transport: 'direct' as const, directMedia: {} } : {}) }).job;
  return { service, store, clients, platform, configuration, submit };
}

test('a slow instance does not prevent healthy instances from advancing on later ticks', async () => {
  const { service, clients, submit } = fixture(2);
  const first = submit('first');
  const second = submit('second');
  await service.tick();
  let release!: (value: { state: string; outputs: never[] }) => void;
  clients[0]!.history.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const slowTick = service.tick();
  await new Promise(resolve => setImmediate(resolve));
  await service.tick();
  expect(clients[1]!.history).toHaveBeenCalledTimes(2);
  expect(clients[0]!.history).toHaveBeenCalledTimes(1);
  release({ state: 'running', outputs: [] });
  await slowTick;
  expect(service.get(first.id).stage).toBe('running');
  expect(service.get(second.id).stage).toBe('running');
});

test('remote query errors cannot bypass an expired execution deadline or release an uncertain slot', async () => {
  const { service, store, clients, submit } = fixture();
  const job = submit('expired');
  await service.tick();
  store.updateJob(job.id, { stage: 'submitting', provider_confirmed: 0, deadline: Date.now() - 1 });
  clients[0]!.history.mockRejectedValue(new Error('unavailable'));
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED', provider_confirmed: 0 });
  expect(store.instance('1')!.job_id).toBe(job.id);
  expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
});

test('an expired upload reservation gives the slot to another job without changing original instance affinity', async () => {
  const { service, store, submit } = fixture();
  const waiting = submit('upload', true);
  await service.tick();
  const next = submit('next');
  store.updateJob(waiting.id, { reservation_started_at: Date.now() - 60_001 });
  await service.tick();
  expect(service.get(waiting.id)).toMatchObject({ stage: 'queued', instance_id: '1', error_code: 'COMFY_UPLOAD_RESERVATION_EXPIRED' });
  expect(service.get(next.id).stage).toBe('running');
  expect(() => service.completeInputs(waiting.id, {})).toThrow();
});

test('upload reservation retries are bounded and no old platform GPU timer is installed', async () => {
  const { service, store, platform, configuration, submit } = fixture();
  const setGpuIdleShutdown = vi.fn();
  Object.assign(platform, { setGpuIdleShutdown });
  configuration.scheduler!.maxUploadReservations = 1;
  const job = submit('upload', true);
  await service.tick();
  store.updateJob(job.id, { reservation_started_at: Date.now() - 60_001 });
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_UPLOAD_TIMEOUT' });
  expect(store.instance('1')!.job_id).toBeNull();
  expect(setGpuIdleShutdown).not.toHaveBeenCalled();
});

test('a stopped instance with an uncertain submission is woken for the original attempt only', async () => {
  const { service, store, platform, clients, submit } = fixture();
  const job = submit('original');
  await service.tick();
  store.updateJob(job.id, { stage: 'submitting', provider_confirmed: 0 });
  platform.getInstanceStatus.mockResolvedValue('22');
  await service.tick();
  expect(platform.openInstance).toHaveBeenCalledExactlyOnceWith('1');
  expect(clients[0]!.history).not.toHaveBeenCalled();
  platform.getInstanceStatus.mockResolvedValue('2');
  await service.tick();
  expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
  expect(service.get(job.id).stage).toBe('running');
});

test('an already running pool respects the execution concurrency cap', async () => {
  const { service, configuration, submit, clients } = fixture(3);
  configuration.scheduler!.maxConcurrentInstances = 1;
  const jobs = [submit('first'), submit('second'), submit('third')];
  await service.tick();
  expect(jobs.filter(job => service.get(job.id).stage === 'running')).toHaveLength(1);
  expect(jobs.filter(job => service.get(job.id).stage === 'queued')).toHaveLength(2);
  expect(clients.reduce((total, client) => total + client.submit.mock.calls.length, 0)).toBe(1);
});

test.each(['missing', 'rejected'])('dispatch fails safely when platform idle timer cancellation is %s', async scenario => {
  const { service, platform, submit, clients } = fixture();
  if (scenario === 'missing') Object.assign(platform, { clearGpuIdleShutdown: undefined });
  else platform.clearGpuIdleShutdown.mockRejectedValue(new Error('platform unavailable'));
  const job = submit('timer');
  await service.tick();
  expect(service.get(job.id).stage).toBe('queued');
  expect(clients[0]!.submit).not.toHaveBeenCalled();
});

test('expired preparation releases its slot even while the instance is backing off', async () => {
  const { service, store, submit, clients } = fixture();
  const job = submit('preparing', true);
  await service.tick();
  store.updateJob(job.id, { stage: 'preparing', deadline: Date.now() - 1 });
  store.updateInstance('1', { next_action_at: Date.now() + 60_000 });
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_PREPARATION_TIMEOUT' });
  expect(store.instance('1')!.job_id).toBeNull();
  expect(clients[0]!.submit).not.toHaveBeenCalled();
});
