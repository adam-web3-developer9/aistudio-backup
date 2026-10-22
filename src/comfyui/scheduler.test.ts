import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore } from './store.js';
import { schedulerPolicy } from './scheduler.js';
import { AigateError } from './aigate-client.js';

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

test('upload reservation retries are bounded and platform GPU idle shutdown is cleared once', async () => {
  const { service, store, platform, configuration, submit } = fixture();
  const setGpuIdleShutdown = vi.fn().mockResolvedValue(undefined);
  Object.assign(platform, { setGpuIdleShutdown });
  configuration.scheduler!.maxUploadReservations = 1;
  expect(configuration.scheduler!.idleStopAfterMs).toBe(300_000);
  const job = submit('upload', true);
  await service.tick();
  expect(store.instance('1')!.idle_policy_applied_at).toBeNull();
  await service.tick();
  expect(platform.clearGpuIdleShutdown).toHaveBeenCalledExactlyOnceWith('1');
  store.updateJob(job.id, { reservation_started_at: Date.now() - 60_001 });
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_UPLOAD_TIMEOUT' });
  expect(store.instance('1')!.job_id).toBeNull();
  expect(setGpuIdleShutdown).not.toHaveBeenCalled();
  expect(platform.clearGpuIdleShutdown).toHaveBeenCalledExactlyOnceWith('1');
});

test('platform GPU idle shutdown is cleared once per boot, not once per upload tick', async () => {
  const { service, store, platform, clients, submit } = fixture();
  const setGpuIdleShutdown = vi.fn().mockResolvedValue(undefined);
  Object.assign(platform, { setGpuIdleShutdown });
  const job = submit('upload-reboot', true);
  await service.tick();
  await service.tick();
  expect(platform.clearGpuIdleShutdown).toHaveBeenCalledExactlyOnceWith('1');
  platform.getInstanceStatus.mockResolvedValue('22');
  await service.tick();
  await service.tick();
  expect(platform.openInstance).toHaveBeenCalledExactlyOnceWith('1');
  expect(store.instance('1')!.idle_policy_applied_at).toBeNull();
  expect(platform.clearGpuIdleShutdown).toHaveBeenCalledTimes(1);
  platform.getInstanceStatus.mockResolvedValue('2');
  await service.tick();
  expect(store.instance('1')!.idle_policy_applied_at).toBeNull();
  await service.tick();
  expect(platform.clearGpuIdleShutdown.mock.calls).toEqual([['1'], ['1']]);
  expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', instance_id: '1' });
  expect(clients[0]!.submit).not.toHaveBeenCalled();
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

test.each(['submitting', 'running'] as const)('expired %s work retains its slot without repeatedly waking a stopped instance across restart', async stage => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, store, platform, clients, submit } = fixture();
  const job = submit('expired-stopped');
  await service.tick();
  store.updateJob(job.id, { stage, provider_confirmed: stage === 'running' ? 1 : 0, deadline: Date.now() - 1 });
  store.updateInstance('1', { state: 'starting', action_sent: 1, action_started_at: Date.now() - 60_001 });
  platform.getInstanceStatus.mockResolvedValue('22');
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED', prompt_id: job.prompt_id });
  expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id, action_sent: 0, action_started_at: null,
    error_code: 'COMFY_RECOVERY_PAUSED', stopped_at: Date.now() });
  expect(service.publicJob(service.get(job.id)).progress.message).toContain('已暂停自动开机恢复');
  await service.close();
  const restarted = new ComfyService(service.options);
  try {
    for (const elapsed of [600_001, 3_600_000, 86_400_000]) {
      clock.mockReturnValue(1_800_000_000_000 + elapsed);
      await restarted.tick();
    }
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
    expect(clients[0]!.history).not.toHaveBeenCalled();
    expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
    expect(store.instance('1')!.job_id).toBe(job.id);
    platform.getInstanceStatus.mockResolvedValue('2');
    clients[0]!.history.mockResolvedValue({ state: 'failed', outputs: [] });
    clock.mockReturnValue(Date.now() + 30_000);
    await restarted.tick();
    expect(clients[0]!.history).toHaveBeenCalledWith(job.prompt_id);
    expect(restarted.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_RENDER_FAILED' });
    expect(store.instance('1')!.job_id).toBeNull();
    expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
  } finally { await restarted.close(); }
});

test('cancelling an expired unconfirmed submission does not free its protected slot or wake the instance', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, store, platform, clients, submit } = fixture();
  const job = submit('cancel-unknown');
  await service.tick();
  store.updateJob(job.id, { stage: 'submitting', provider_confirmed: 0, deadline: Date.now() - 1 });
  service.cancel(job.id);
  platform.getInstanceStatus.mockResolvedValue('22');
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'cancelled', error_code: 'COMFY_REMOTE_UNCONFIRMED' });
  expect(store.instance('1')).toMatchObject({ job_id: job.id, error_code: 'COMFY_RECOVERY_PAUSED' });
  expect(platform.openInstance).not.toHaveBeenCalled();
  expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
  platform.getInstanceStatus.mockResolvedValue('2');
  clients[0]!.history.mockResolvedValue({ state: 'missing', outputs: [] });
  clock.mockReturnValue(Date.now() + 30_000);
  await service.tick();
  expect(service.get(job.id).stage).toBe('cancelled');
  expect(store.instance('1')!.job_id).toBe(job.id);
  clients[0]!.history.mockResolvedValue({ state: 'succeeded', outputs: [] });
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'cancelled', result: null, result_pending: 0 });
  expect(store.instance('1')!.job_id).toBeNull();
  expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
});

test('a paused original direct task can still recover its late result after the instance is started externally', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, store, platform, clients, submit } = fixture();
  const job = submit('late-direct-result', true);
  await service.tick();
  service.completeInputs(job.id, {});
  await service.tick();
  store.updateJob(job.id, { deadline: Date.now() - 1 });
  platform.getInstanceStatus.mockResolvedValue('22');
  await service.tick();
  expect(store.instance('1')!.error_code).toBe('COMFY_RECOVERY_PAUSED');
  platform.getInstanceStatus.mockResolvedValue('2');
  clients[0]!.history.mockResolvedValue({ state: 'succeeded', outputs: [
    { nodeId: '1', filename: 'late.mp4', subfolder: job.id, type: 'output' },
  ] });
  clock.mockReturnValue(Date.now() + 30_000);
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', error_code: null, result_pending: 1, prompt_id: job.prompt_id });
  expect(service.get(job.id).result).toContain('late.mp4');
  expect(clients[0]!.history).toHaveBeenCalledWith(job.prompt_id);
  expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
  expect(platform.openInstance).not.toHaveBeenCalled();
});

test('a direct task accepted with zero instances creates an instance and receives an upload reservation', async () => {
  const { service, configuration, platform, submit } = fixture();
  const authenticatedInstance = { ...configuration.instances[0]!, headers: { Authorization: 'server-only' } };
  configuration.instances.length = 0;
  configuration.elastic = { enabled: true, maxInstances: 6, maxHourlyCost: 10, createCooldownMs: 60_000,
    releaseAfterMs: 3_600_000, reconcileTimeoutMs: 300_000,
    templates: [{ id: 'template', areaName: '华东一区', gpuModel: '5090', skuName: 'RTX 5090', imageId: '123', imageType: '3',
      workflowIds: ['test'], hourlyCost: 1, storageHourlyCost: 0.2, skuPriceToHourlyFactor: 1, skuPriceUnitVerified: true,
      allowRelease: true, rebuildVerified: true }] };
  const createInstance = vi.fn().mockResolvedValue('1');
  Object.assign(platform, {
    createInstance,
    skuList: vi.fn().mockResolvedValue([{ areaName: '华东一区', skuName: 'RTX 5090', price: '1.00' }]),
    getInstance: vi.fn().mockResolvedValue({ id: '1', status: '2', areaName: '华东一区', imageId: '123', imageType: '3', count: 1,
      services: [{ host: 'created.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 8188 }] }),
  });
  configuration.autoOpen = false;
  expect(() => submit('disabled-auto-open', true)).toThrow('No instance supports');
  configuration.autoOpen = true;
  configuration.elastic.enabled = false;
  expect(() => submit('disabled-elastic', true)).toThrow('No instance supports');
  configuration.elastic.enabled = true;
  configuration.elastic.templates[0]!.workflowIds = ['other'];
  expect(() => submit('unsupported-template', true)).toThrow('No instance supports');
  configuration.elastic.templates[0]!.workflowIds = ['test'];
  configuration.instances.push(authenticatedInstance);
  expect(() => submit('authenticated-pool', true)).toThrow('No instance supports');
  configuration.instances.length = 0;
  const job = submit('zero-pool', true);
  await service.tick();
  await service.tick();
  expect(createInstance).toHaveBeenCalledTimes(1);
  expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', instance_id: '1' });
  expect(service.publicJob(service.get(job.id)).upload?.baseUrl).toBe('https://created.waas.aigate.cc');
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

test.each([
  ['missing', 'submitting'], ['rejected', 'submitting'],
  ['missing', 'running'], ['rejected', 'running'],
] as const)('dispatch and observation ignore %s timer cancellation for an original %s task', async (scenario, stage) => {
  const { service, store, platform, submit, clients } = fixture();
  const clearGpuIdleShutdown = platform.clearGpuIdleShutdown;
  const setGpuIdleShutdown = vi.fn().mockResolvedValue(undefined);
  Object.assign(platform, { setGpuIdleShutdown });
  if (scenario === 'missing') Object.assign(platform, { clearGpuIdleShutdown: undefined });
  else clearGpuIdleShutdown.mockRejectedValue(new AigateError('BUSINESS_REJECTED', 'Timer cancellation rejected'));
  const job = submit('timer');
  await service.tick();
  expect(service.get(job.id).stage).toBe('running');
  expect(setGpuIdleShutdown).not.toHaveBeenCalled();
  const promptId = service.get(job.id).prompt_id;
  store.updateJob(job.id, { stage, provider_confirmed: 0 });
  store.updateInstance('1', { idle_policy_applied_at: null });
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'running', prompt_id: promptId, provider_confirmed: 1 });
  expect(clients[0]!.history).toHaveBeenCalledExactlyOnceWith(promptId);
  expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
  expect(clients[0]!.findAttempt).not.toHaveBeenCalled();
  expect(store.instance('1')!.job_id).toBe(job.id);
  expect(setGpuIdleShutdown).not.toHaveBeenCalled();
  expect(clearGpuIdleShutdown).toHaveBeenCalledTimes(scenario === 'missing' ? 0 : 1);
});

test('transient GPU idle cancellation failure does not block dispatch or query and recovers on its next retry', async () => {
  const { service, store, platform, clients, submit } = fixture();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const setGpuIdleShutdown = vi.fn();
  Object.assign(platform, { setGpuIdleShutdown });
  platform.clearGpuIdleShutdown.mockRejectedValueOnce(new AigateError('NETWORK_ERROR', 'Timer cancellation connection failed'));
  const job = submit('timer-recovery');
  await service.tick();
  expect(store.instance('1')).toMatchObject({ idle_policy_applied_at: null, error_code: null });
  expect(service.get(job.id).stage).toBe('running');
  expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
  expect(store.events.list({ instanceId: '1' }).some(event => event.code === 'COMFY_GPU_IDLE_CLEAR_FAILED')).toBe(true);
  await service.tick();
  expect(clients[0]!.history).toHaveBeenCalledTimes(1);
  expect(platform.clearGpuIdleShutdown).toHaveBeenCalledTimes(1);
  vi.mocked(Date.now).mockReturnValue(now + 30_000);
  await service.tick();
  expect(service.get(job.id).stage).toBe('running');
  expect(platform.clearGpuIdleShutdown.mock.calls).toEqual([['1'], ['1']]);
  expect(setGpuIdleShutdown).not.toHaveBeenCalled();
  expect(clients[0]!.submit).toHaveBeenCalledTimes(1);
  expect(store.events.list({ instanceId: '1' }).some(event => event.code === 'COMFY_GPU_IDLE_CLEARED')).toBe(true);
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
