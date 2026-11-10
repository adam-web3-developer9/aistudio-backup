import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { AigateError } from './aigate-client.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { schedulerPolicy } from './scheduler.js';
import { ComfyStore, type ComfyInput } from './store.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });

function fixture(existing = false) {
  vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const db = new Database(':memory:');
  const store = new ComfyStore(db);
  const configuration: ComfyServiceOptions['configuration'] = {
    autoOpen: true, pollIntervalMs: 1_000, bootTimeoutMs: 30_000, jobTimeoutMs: 60_000,
    instances: existing ? [{ id: '1', baseUrl: 'https://gpu.waas.aigate.cc', workflowIds: ['render'] }] : [],
    workflows: ['render', 'other'].map(id => ({ id, version: '1', graph: { '1': { class_type: 'Render', inputs: {} } }, bindings: {}, outputNodeIds: ['1'] })),
    elastic: { enabled: !existing, maxInstances: 2, maxHourlyCost: 10, createCooldownMs: 10_000, releaseAfterMs: 3_600_000, reconcileTimeoutMs: 300_000,
      templates: [{ id: 'template', areaName: '华东一区', gpuModel: '5090', skuName: 'RTX 5090', imageId: '123', imageType: '3',
        workflowIds: ['render'], hourlyCost: 1, storageHourlyCost: 0.2, skuPriceToHourlyFactor: 1, skuPriceUnitVerified: true,
        allowRelease: true, rebuildVerified: true }] },
  };
  configuration.scheduler = schedulerPolicy(configuration);
  const platform = {
    getInstanceStatus: vi.fn().mockResolvedValue('22'), openInstance: vi.fn().mockResolvedValue(undefined), closeInstance: vi.fn(),
    skuList: vi.fn().mockResolvedValue([{ areaName: '华东一区', skuName: 'RTX 5090', price: '1.00' }]),
    createInstance: vi.fn(), getInstance: vi.fn(),
  };
  const client = { health: vi.fn(), queue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
    upload: vi.fn(), submit: vi.fn(), history: vi.fn(), findAttempt: vi.fn(), download: vi.fn() };
  const service = new ComfyService({ store, configuration, platform, client: () => client,
    assets: { get: () => undefined, read: async () => undefined }, ownsAsset: () => false,
    results: { save: vi.fn(), read: async () => null }, owner: 'owner' });
  cleanup.push(async () => { await service.close(); db.close(); });
  const submit = (key: string, workflowId = 'render') => {
    const input: ComfyInput = { adapterId: 'comfyui-v1', requestKey: key, workflowId, transport: 'direct', resultDelivery: 'archive', media: {}, values: {} };
    return store.submit('owner', { ...input, profile: configuration.workflows.find(profile => profile.id === workflowId)! }, 60_000).job;
  };
  return { service, store, platform, client, configuration, submit };
}

it.each([
  ['INSUFFICIENT_BALANCE', 'COMFY_INSUFFICIENT_BALANCE', '余额不足'],
  ['INSTANCE_START_REJECTED', 'COMFY_INSTANCE_CREATE_REJECTED', '租赁被平台拒绝'],
] as const)('returns a terminal rental error for a confirmed %s creation rejection', async (reason, code, message) => {
  const { service, store, platform, submit } = fixture();
  const job = submit('rent');
  platform.createInstance.mockRejectedValue(new AigateError('BUSINESS_REJECTED', 'private upstream response', 'DENIED', false, reason));
  await service.tick();
  const failed = service.publicJob(service.get(job.id));
  expect(failed).toMatchObject({ status: 'failed', stage: 'failed', error: { code, message: expect.stringContaining(message), providerTerminal: true },
    progress: { message: expect.stringContaining(message) } });
  expect(store.resources()[0]).toMatchObject({ state: 'released', instance_id: null, error_code: code });
  expect(store.events.recent(job.id)).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'failed', code })]));
  expect(JSON.stringify(failed)).not.toContain('private upstream response');
  vi.mocked(Date.now).mockReturnValue(Date.now() + 10_001);
  await service.tick();
  expect(platform.createInstance).toHaveBeenCalledTimes(1);
});

it('limits rental failure to compatible unsubmitted jobs and preserves execution uncertainty', async () => {
  const { service, store, platform, client, submit } = fixture();
  const pending = submit('pending');
  const unrelated = submit('unrelated', 'other');
  const uncertain = submit('uncertain');
  store.updateJob(uncertain.id, { native_checkpoint: JSON.stringify({ attempts: [{ state: 'submitting' }] }) });
  const running = submit('running');
  store.updateJob(running.id, { stage: 'running', provider_confirmed: 1 });
  platform.createInstance.mockRejectedValue(new AigateError('BUSINESS_REJECTED', 'rejected', undefined, false, 'INSUFFICIENT_BALANCE'));
  await service.tick();
  expect(store.get(pending.id)?.stage).toBe('failed');
  expect(store.get(unrelated.id)).toMatchObject({ stage: 'queued', error_code: null });
  expect(store.get(uncertain.id)).toMatchObject({ stage: 'queued', error_code: null, native_checkpoint: expect.any(String) });
  expect(store.get(running.id)).toMatchObject({ stage: 'running', error_code: null, provider_confirmed: 1 });
  expect(client.submit).not.toHaveBeenCalled();
});

it.each([
  new AigateError('CAPACITY_UNAVAILABLE', 'no GPUs'),
  new AigateError('TIMEOUT', 'outcome unknown', undefined, true),
])('keeps $code rental outcomes waiting without terminal billing failure', async error => {
  const { service, store, platform, submit } = fixture();
  const job = submit('waiting');
  platform.createInstance.mockRejectedValue(error);
  await service.tick();
  expect(store.get(job.id)).toMatchObject({ stage: 'queued', error_code: null });
  expect(service.publicJob(service.get(job.id))).not.toHaveProperty('error');
});

it('fails a pre-submit upload wake on balance rejection and releases its slot as offline', async () => {
  const { service, store, platform, client, submit } = fixture(true);
  const job = submit('upload');
  store.updateInstance('1', { state: 'ready' });
  store.claim('1', ['render']);
  store.updateJob(job.id, { stage: 'awaiting_upload' });
  platform.openInstance.mockRejectedValue(new AigateError('BUSINESS_REJECTED', 'rejected', undefined, false, 'INSUFFICIENT_BALANCE'));
  await service.tick();
  expect(service.publicJob(service.get(job.id))).toMatchObject({ status: 'failed', stage: 'failed',
    error: { code: 'COMFY_INSUFFICIENT_BALANCE', providerTerminal: true } });
  expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: null, error_code: 'COMFY_INSUFFICIENT_BALANCE' });
  expect(client.submit).not.toHaveBeenCalled();
});

it('preserves an already submitted execution when waking the original GPU is rejected', async () => {
  const { service, store, platform, client, submit } = fixture(true);
  const job = submit('running');
  store.updateInstance('1', { state: 'ready' });
  store.claim('1', ['render']);
  store.updateJob(job.id, { stage: 'running', provider_confirmed: 1 });
  platform.openInstance.mockRejectedValue(new AigateError('BUSINESS_REJECTED', 'rejected', undefined, false, 'INSUFFICIENT_BALANCE'));
  await service.tick();
  expect(store.get(job.id)).toMatchObject({ stage: 'running', error_code: null, provider_confirmed: 1 });
  expect(service.publicJob(service.get(job.id))).toMatchObject({ status: 'running', stage: 'waiting_billing' });
  expect(service.publicJob(service.get(job.id))).not.toHaveProperty('error');
  expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id });
  expect(client.submit).not.toHaveBeenCalled();
});

it('does not hide a billing block behind a different instance waiting for capacity', () => {
  const { service, store, configuration, submit } = fixture(true);
  const job = submit('billing');
  configuration.instances.push({ id: '2', baseUrl: 'https://other.waas.aigate.cc', workflowIds: ['render'] });
  store.registerInstances(['2']);
  store.updateInstance('1', { state: 'offline', error_code: 'COMFY_INSUFFICIENT_BALANCE' });
  store.updateInstance('2', { state: 'waiting_capacity', capacity_started_at: Date.now(), next_action_at: Date.now() + 30_000 });
  expect(service.publicJob(service.get(job.id))).toMatchObject({ stage: 'waiting_billing',
    progress: { message: expect.stringContaining('余额不足'), instance: { id: '1' } } });
});

it('allows a healthy second instance to take queued work after an instance-specific rejection', async () => {
  const { service, store, configuration, platform, submit } = fixture(true);
  configuration.instances.push({ id: '2', baseUrl: 'https://other.waas.aigate.cc', workflowIds: ['render'] });
  store.registerInstances(['2']);
  platform.getInstanceStatus.mockImplementation(async (id: string) => id === '1' ? '22' : '2');
  platform.openInstance.mockRejectedValue(new AigateError('BUSINESS_REJECTED', 'rejected', undefined, false, 'INSTANCE_START_REJECTED'));
  const job = submit('alternative');
  await service.tick();
  expect(store.get(job.id)).toMatchObject({ instance_id: '2', error_code: null });
  expect(store.get(job.id)?.stage).not.toBe('failed');
});

it('does not fail queued work when existing busy capacity can serve it without another rental', async () => {
  const { service, store, configuration, platform, submit } = fixture(true);
  configuration.elastic!.enabled = true;
  const active = submit('active');
  store.updateInstance('1', { state: 'ready' });
  store.claim('1', ['render']);
  store.updateJob(active.id, { stage: 'running', provider_confirmed: 1 });
  store.updateInstance('1', { next_action_at: Date.now() + 30_000 });
  const pending = submit('pending');
  platform.createInstance.mockRejectedValue(new AigateError('BUSINESS_REJECTED', 'rejected', undefined, false, 'INSUFFICIENT_BALANCE'));
  await service.tick();
  expect(platform.createInstance).toHaveBeenCalledTimes(1);
  expect(store.get(pending.id)).toMatchObject({ stage: 'queued', error_code: null });
  expect(store.get(active.id)).toMatchObject({ stage: 'running', provider_confirmed: 1 });
});
