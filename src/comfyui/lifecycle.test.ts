import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AigateError, type AigateClient, type AigateInstance, type AigateSku } from './aigate-client.js';
import type { ComfyClient } from './comfy-client.js';
import type { ComfyPoolConfiguration } from './configuration.js';
import { ComfyLifecycle } from './lifecycle.js';
import { schedulerPolicy } from './scheduler.js';
import { ComfyStore, type ComfyResource } from './store.js';

const startedAt = 1_800_000_000_000;
const createdId = '1096749550260588544';
let clock: number;
const databases: Database.Database[] = [];
const lifecycles: ComfyLifecycle[] = [];

function fixture(overrides: Partial<ComfyPoolConfiguration> = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  const store = new ComfyStore(db);
  const configuration: ComfyPoolConfiguration = {
    autoOpen: true, pollIntervalMs: 1_000, bootTimeoutMs: 30_000, jobTimeoutMs: 60_000,
    instances: [{ id: '1', baseUrl: 'https://seed.waas.aigate.cc', workflowIds: ['render'], areaName: '华东一区', gpuModel: '5090',
      lifecycle: { allowRelease: false, rebuildVerified: false, hourlyCost: 1, storageHourlyCost: 0.1 } }],
    workflows: [{ id: 'render', version: '1', graph: { '1': { class_type: 'Render', inputs: {} } }, bindings: {}, outputNodeIds: ['1'] }],
    elastic: { enabled: true, maxInstances: 6, maxHourlyCost: 10, createCooldownMs: 60_000, releaseAfterMs: 3_600_000, reconcileTimeoutMs: 300_000,
      templates: [{ id: 'template', areaName: '华东一区', gpuModel: '5090', skuName: 'RTX 5090', imageId: '123', imageType: '3',
        workflowIds: ['render'], hourlyCost: 1, storageHourlyCost: 0.2, skuPriceToHourlyFactor: 1, skuPriceUnitVerified: true,
        allowRelease: true, rebuildVerified: true }] },
    ...overrides,
  };
  configuration.scheduler = schedulerPolicy(configuration);
  const initialConfiguration = structuredClone(configuration);
  store.registerInstances(configuration.instances.map(instance => instance.id));
  for (const instance of configuration.instances) store.updateInstance(instance.id, { state: 'ready' });
  const metadata: AigateInstance = { id: createdId, status: '2', areaName: '华东一区', imageId: '123', imageType: '3', count: 1,
    services: [{ host: 'created.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 8188 }] };
  const sku: AigateSku = { areaName: '华东一区', skuName: 'RTX 5090', price: '1.00', vmSize: 'gpu', cpuMf: 'cpu',
    cpuCore: 8, memorySize: '32G', sysDiskSize: '100G', maxGpuCount: 1 };
  const platform = {
    getInstanceStatus: vi.fn<AigateClient['getInstanceStatus']>().mockResolvedValue('2'),
    closeInstance: vi.fn<AigateClient['closeInstance']>().mockResolvedValue(undefined),
    skuList: vi.fn<AigateClient['skuList']>().mockResolvedValue([sku]),
    createInstance: vi.fn<AigateClient['createInstance']>().mockResolvedValue(createdId),
    getInstance: vi.fn<AigateClient['getInstance']>().mockResolvedValue(metadata),
    releaseInstance: vi.fn<AigateClient['releaseInstance']>().mockResolvedValue(undefined),
    pageInstances: vi.fn<AigateClient['pageInstances']>().mockResolvedValue({ total: 1, records: [metadata] }),
  };
  const client = { health: vi.fn<ComfyClient['health']>().mockResolvedValue(undefined),
    queue: vi.fn<ComfyClient['queue']>().mockResolvedValue({ running: [], pending: [] }) };
  const assertWorker = vi.fn<() => void>();
  const lifecycle = new ComfyLifecycle({ store, configuration, platform, client: () => client, assertWorker });
  lifecycles.push(lifecycle);
  let submitted = 0;
  const submit = (workflowId = 'render') => store.submit('owner', { adapterId: 'comfyui-v1', requestKey: 'request-' + submitted++,
    workflowId, media: {}, values: {}, profile: { ...configuration.workflows[0]!, id: workflowId } }, 60_000, clock).job;
  const demand = () => { submit(); submit(); };
  const restart = () => {
    const restartedConfiguration = structuredClone(initialConfiguration);
    const restartedStore = new ComfyStore(db);
    const restarted = new ComfyLifecycle({ store: restartedStore, configuration: restartedConfiguration, platform, client: () => client, assertWorker });
    lifecycles.push(restarted);
    return { lifecycle: restarted, configuration: restartedConfiguration, store: restartedStore };
  };
  return { db, store, configuration, platform, metadata, sku, client, assertWorker, lifecycle, submit, demand, restart };
}

function resource(patch: Partial<ComfyResource> = {}): ComfyResource {
  return { key: 'resource', name: 'hailuo-resource', state: 'creating', instance_id: null, configuration: null,
    template_id: 'template', hourly_cost: 1, storage_hourly_cost: 0.2, created_at: clock, updated_at: clock, error_code: null, ...patch };
}

function fallbackFixture() {
  const context = fixture();
  context.configuration.elastic!.templates.push({ ...context.configuration.elastic!.templates[0]!, id: 'fallback', areaName: '华东二区' });
  context.platform.skuList.mockImplementation(async areaName => [{ ...context.sku, areaName }]);
  context.demand();
  return context;
}

function idleFixture(stopped = false) {
  const context = fixture({ autoOpen: false });
  context.store.updateInstance('1', { state: stopped ? 'offline' : 'ready', idle_since: clock - 300_000,
    stopped_at: stopped ? clock - 3_600_000 : null });
  context.platform.getInstanceStatus.mockResolvedValue(stopped ? '22' : '2');
  return context;
}

function releasableFixture() {
  const context = idleFixture(true);
  const configuration = context.configuration.instances[0]!;
  configuration.lifecycle = { allowRelease: true, rebuildVerified: true, hourlyCost: 1, storageHourlyCost: 0.1 };
  context.store.saveResource(resource({ state: 'registered', instance_id: '1', configuration: JSON.stringify(configuration) }));
  return context;
}

beforeEach(() => {
  clock = startedAt;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(async () => {
  for (const lifecycle of lifecycles.splice(0)) await lifecycle.close();
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});

describe('ComfyLifecycle elastic creation', () => {
  it('falls back to the next region after a confirmed capacity rejection without an ID', async () => {
    const context = fallbackFixture();
    context.platform.createInstance.mockRejectedValueOnce(new AigateError('CAPACITY_UNAVAILABLE', 'no capacity'));
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, areaName: '华东二区' });
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(2);
    expect(context.platform.createInstance).toHaveBeenNthCalledWith(1, expect.objectContaining({ areaName: '华东一区' }));
    expect(context.platform.createInstance).toHaveBeenNthCalledWith(2, expect.objectContaining({ areaName: '华东二区' }));
    expect(context.store.resources()).toEqual(expect.arrayContaining([
      expect.objectContaining({ template_id: 'template', state: 'released', instance_id: null, error_code: 'COMFY_CAPACITY_UNAVAILABLE' }),
      expect.objectContaining({ template_id: 'fallback', state: 'registered', instance_id: createdId, error_code: null }),
    ]));
    expect(context.store.resources()).toHaveLength(2);
    expect(context.configuration.instances.map(instance => instance.id)).toEqual(['1', createdId]);
    expect(context.lifecycle.lastError).toBeNull();
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(2);
  });

  it('reports confirmed capacity exhaustion and preserves creation cooldown', async () => {
    const context = fallbackFixture();
    context.platform.createInstance.mockRejectedValue(new AigateError('CAPACITY_UNAVAILABLE', 'no capacity'));
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(2);
    expect(context.store.resources()).toHaveLength(2);
    for (const row of context.store.resources()) {
      expect(row).toMatchObject({ state: 'released', instance_id: null, error_code: 'COMFY_CAPACITY_UNAVAILABLE' });
    }
    expect(context.lifecycle.lastError).toBe('COMFY_CAPACITY_UNAVAILABLE');
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: 'TIMEOUT', uncertain: true, state: 'uncertain' },
    { code: 'CAPACITY_UNAVAILABLE', uncertain: true, state: 'uncertain' },
    { code: 'CAPACITY_UNAVAILABLE', uncertain: undefined, state: 'uncertain' },
    { code: 'BUSINESS_REJECTED', uncertain: false, state: 'released' },
  ])('does not fall back for $code with uncertainty $uncertain', async ({ code, uncertain, state }) => {
    const context = fallbackFixture();
    context.platform.createInstance.mockRejectedValue(Object.assign(new Error('creation failed'), { code, uncertain }));
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
    expect(context.platform.skuList).toHaveBeenCalledExactlyOnceWith('华东一区');
    expect(context.store.resources()).toEqual([expect.objectContaining({ state, instance_id: null, error_code: 'COMFY_' + code })]);
    expect(context.lifecycle.lastError).toBe('COMFY_CREATION_UNCONFIRMED');
    if (uncertain !== false) {
      clock += context.configuration.elastic!.createCooldownMs;
      await context.lifecycle.tick();
      expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
      expect(context.lifecycle.lastError).toBe('COMFY_RESOURCE_RECONCILIATION_REQUIRED');
    }
  });

  it('does not fall back after a known ID even for a confirmed initialization capacity rejection', async () => {
    const context = fallbackFixture();
    context.platform.getInstance.mockRejectedValue(new AigateError('CAPACITY_UNAVAILABLE', 'initialization failed'));
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
    expect(context.platform.skuList).toHaveBeenCalledExactlyOnceWith('华东一区');
    expect(context.store.resources()).toEqual([expect.objectContaining({ state: 'creating', instance_id: createdId, error_code: 'COMFY_CAPACITY_UNAVAILABLE' })]);
    expect(context.lifecycle.lastError).toBe('COMFY_RESOURCE_INITIALIZING');
    clock += context.configuration.elastic!.createCooldownMs;
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
  });

  it('creates one instance for compatible queue pressure and durably registers verified metadata', async () => {
    const context = fixture();
    context.demand();
    context.platform.createInstance.mockImplementation(async request => {
      expect(request).toEqual({ areaName: '华东一区', count: 1, skuName: 'RTX 5090', imageId: '123', imageType: '3' });
      expect(context.store.resources()).toEqual([expect.objectContaining({ state: 'creating', instance_id: null, configuration: null })]);
      return createdId;
    });
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
    expect(context.platform.getInstance).toHaveBeenCalledWith(createdId);
    expect(context.store.resources()).toEqual([expect.objectContaining({ state: 'registered', instance_id: createdId, error_code: null })]);
    const registered = context.configuration.instances.find(instance => instance.id === createdId)!;
    expect(registered).toMatchObject({ baseUrl: 'https://created.waas.aigate.cc', headers: {}, workflowIds: ['render'],
      lifecycle: { allowRelease: true, rebuildVerified: true, hourlyCost: 1, storageHourlyCost: 0.2 } });
    const persistedConfiguration = context.store.resources()[0]!.configuration!;
    expect(JSON.parse(persistedConfiguration)).toEqual({ id: createdId, baseUrl: 'https://created.waas.aigate.cc',
      areaName: '华东一区', gpuModel: '5090', workflowIds: ['render'],
      lifecycle: { allowRelease: true, rebuildVerified: true, hourlyCost: 1, storageHourlyCost: 0.2 } });
    expect(JSON.parse(persistedConfiguration)).not.toHaveProperty('headers');
    expect(persistedConfiguration).not.toMatch(/"[^"\n]*(?:token|authorization|password|secret|headers|api.?key)[^"\n]*"\s*:/i);
    expect(context.store.instance(createdId)).toBeDefined();
    expect(context.assertWorker).toHaveBeenCalled();
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
  });

  it.each(['no-demand', 'unsupported', 'auto-open-disabled', 'elastic-disabled', 'delayed', 'expired'] as const)('does not create for %s', async scenario => {
    const context = fixture();
    if (scenario !== 'no-demand') {
      const jobs = [context.submit(scenario === 'unsupported' ? 'other' : 'render'), context.submit(scenario === 'unsupported' ? 'other' : 'render')];
      if (scenario === 'delayed') for (const job of jobs) context.store.updateJob(job.id, { eligible_at: clock + 1_000 });
      if (scenario === 'expired') for (const job of jobs) context.store.updateJob(job.id, { deadline: clock });
    }
    if (scenario === 'auto-open-disabled') context.configuration.autoOpen = false;
    if (scenario === 'elastic-disabled') context.configuration.elastic!.enabled = false;
    await context.lifecycle.tick();
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    expect(context.store.resources()).toEqual([]);
  });

  it('fails closed when an existing instance has unknown compute or storage cost', async () => {
    const context = fixture();
    delete context.configuration.instances[0]!.lifecycle;
    context.demand();
    await context.lifecycle.tick();
    expect(context.lifecycle.lastError).toBe('COMFY_COST_UNKNOWN');
    expect(context.platform.skuList).not.toHaveBeenCalled();
    expect(context.platform.createInstance).not.toHaveBeenCalled();
  });

  it('includes existing compute and storage reservations in the hourly budget', async () => {
    const context = fixture();
    context.configuration.elastic!.maxHourlyCost = 2.29;
    context.demand();
    await context.lifecycle.tick();
    expect(context.lifecycle.lastError).toBe('COMFY_ELASTIC_BUDGET_EXCEEDED');
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    context.configuration.elastic!.maxHourlyCost = 2.31;
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
  });

  it.each(['overpriced', 'malformed', 'missing', 'wrong-area', 'wrong-sku'] as const)('rejects an unverified %s SKU quote', async scenario => {
    const context = fixture();
    context.demand();
    const sku = { ...context.sku };
    if (scenario === 'overpriced') sku.price = '1.01';
    if (scenario === 'malformed') sku.price = 'NaN';
    if (scenario === 'wrong-area') sku.areaName = '华东二区';
    if (scenario === 'wrong-sku') sku.skuName = 'RTX 4090';
    context.platform.skuList.mockResolvedValue(scenario === 'missing' ? [] : [sku]);
    await context.lifecycle.tick();
    expect(context.lifecycle.lastError).toBe('COMFY_SKU_QUOTE_UNVERIFIED');
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    expect(context.store.resources()).toEqual([]);
  });

  it.each([false, undefined])('refuses creation unless the SKU price unit is explicitly verified: %s', async skuPriceUnitVerified => {
    const context = fixture();
    context.demand();
    Object.assign(context.configuration.elastic!.templates[0]!, { skuPriceUnitVerified });
    await context.lifecycle.tick();
    expect(context.lifecycle.lastError).toBe('COMFY_SKU_PRICE_UNIT_UNVERIFIED');
    expect(context.platform.skuList).not.toHaveBeenCalled();
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    expect(context.store.resources()).toEqual([]);
  });

  it.each([undefined, 0, -1, NaN, Infinity])('refuses an invalid or missing hourly price conversion factor: %s', async skuPriceToHourlyFactor => {
    const context = fixture();
    context.demand();
    Object.assign(context.configuration.elastic!.templates[0]!, { skuPriceToHourlyFactor });
    await context.lifecycle.tick();
    expect(context.lifecycle.lastError).toBe('COMFY_SKU_PRICE_UNIT_UNVERIFIED');
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    expect(context.store.resources()).toEqual([]);
  });

  it.each([
    { price: '100', factor: 0.01, accepted: true },
    { price: '101', factor: 0.01, accepted: false },
    { price: '0.5', factor: 3, accepted: false },
    { price: '1', factor: 0.5, accepted: true },
    { price: '1' + '0'.repeat(309), factor: 1, accepted: false },
  ])('compares converted hourly cost against the template ceiling: %j', async ({ price, factor, accepted }) => {
    const context = fixture();
    context.demand();
    context.configuration.elastic!.templates[0]!.skuPriceToHourlyFactor = factor;
    context.platform.skuList.mockResolvedValue([{ ...context.sku, price }]);
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(accepted ? 1 : 0);
    if (accepted) expect(context.store.resources()[0]).toMatchObject({ state: 'registered', hourly_cost: 1, storage_hourly_cost: 0.2 });
    else {
      expect(context.lifecycle.lastError).toBe('COMFY_SKU_QUOTE_UNVERIFIED');
      expect(context.store.resources()).toEqual([]);
    }
  });

  it.each(['elastic', 'scheduler'] as const)('honors the %s instance count limit', async limit => {
    const context = fixture();
    context.demand();
    if (limit === 'elastic') context.configuration.elastic!.maxInstances = 1;
    else context.configuration.scheduler!.maxConcurrentInstances = 1;
    await context.lifecycle.tick();
    expect(context.platform.createInstance).not.toHaveBeenCalled();
  });

  it('honors persisted creation cooldown after restart, including released reservations', async () => {
    const context = fixture();
    context.demand();
    context.store.saveResource(resource({ state: 'released', created_at: clock - 59_999 }));
    const restarted = context.restart();
    await restarted.lifecycle.tick();
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    clock += 1;
    await restarted.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
  });

  it('restores registered instances from persisted configuration without duplicate creation', async () => {
    const context = fixture();
    context.demand();
    await context.lifecycle.tick();
    const restarted = context.restart();
    expect(restarted.configuration.instances.map(instance => instance.id)).toEqual(['1', createdId]);
    expect(restarted.store.instance(createdId)).toBeDefined();
    await restarted.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
    expect(restarted.configuration.instances.filter(instance => instance.id === createdId)).toHaveLength(1);
  });

  it('persists a timed-out creation as uncertain and never retries it after restart or cooldown', async () => {
    const context = fixture();
    context.demand();
    context.platform.createInstance.mockRejectedValue(new AigateError('TIMEOUT', 'outcome unknown', undefined, true));
    await context.lifecycle.tick();
    expect(context.store.resources()).toEqual([expect.objectContaining({ state: 'uncertain', instance_id: null, error_code: 'COMFY_TIMEOUT' })]);
    const restarted = context.restart();
    clock += 3_600_000;
    context.demand();
    for (let attempt = 0; attempt < 3; attempt++) await restarted.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
    expect(context.platform.getInstance).not.toHaveBeenCalled();
    expect(restarted.lifecycle.lastError).toBe('COMFY_RESOURCE_RECONCILIATION_REQUIRED');
  });

  it('turns an interrupted creating reservation without an ID into uncertain without creating again', async () => {
    const context = fixture();
    context.demand();
    context.store.saveResource(resource({ created_at: clock - 120_000 }));
    const restarted = context.restart();
    await restarted.lifecycle.tick();
    await restarted.lifecycle.tick();
    expect(context.store.resource('resource')).toMatchObject({ state: 'uncertain', instance_id: null, error_code: 'COMFY_CREATION_UNCONFIRMED' });
    expect(context.platform.createInstance).not.toHaveBeenCalled();
  });

  it('recovers a known created ID after metadata timeout without creating another instance', async () => {
    const context = fixture();
    context.demand();
    context.platform.getInstance.mockRejectedValueOnce(new AigateError('TIMEOUT', 'metadata unavailable'));
    await context.lifecycle.tick();
    expect(context.store.resources()[0]).toMatchObject({ state: 'creating', instance_id: createdId, configuration: null });
    const restarted = context.restart();
    await restarted.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
    expect(context.store.resources()[0]).toMatchObject({ state: 'registered', instance_id: createdId });
    expect(restarted.configuration.instances.some(instance => instance.id === createdId)).toBe(true);
  });

  it.each(['id', 'areaName', 'imageId', 'imageType', 'count'] as const)('does not register mismatched %s metadata', async field => {
    const context = fixture();
    context.demand();
    const metadata = { ...context.metadata, [field]: field === 'count' ? 2 : 'mismatch' };
    context.platform.getInstance.mockResolvedValue(metadata);
    await context.lifecycle.tick();
    expect(context.store.resources()[0]).toMatchObject({ state: 'creating', instance_id: createdId, configuration: null });
    expect(context.configuration.instances.map(instance => instance.id)).toEqual(['1']);
    clock += context.configuration.elastic!.reconcileTimeoutMs;
    await context.lifecycle.tick();
    expect(context.store.resources()[0]?.state).toBe('blocked');
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
  });
});

describe('ComfyLifecycle resource tracking and inspection', () => {
  it.each(['COMFY_RESOURCE_STOP_REQUESTED', 'COMFY_RESOURCE_STOPPED'])('preserves the durable administrator stop intent %s through failed observations and restart', async errorCode => {
    const context = fixture();
    context.store.saveResource(resource({ state: 'blocked', instance_id: createdId, error_code: errorCode }));
    context.platform.getInstance.mockRejectedValueOnce(new Error('temporary platform failure'));
    await context.lifecycle.tick();
    expect(context.store.resource('resource')).toMatchObject({ state: 'blocked', error_code: errorCode });
    const restarted = context.restart();
    await restarted.lifecycle.tick();
    expect(restarted.configuration.instances.map(instance => instance.id)).not.toContain(createdId);
    expect(context.store.resource('resource')).toMatchObject({ state: 'blocked', error_code: errorCode });
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
  });

  it('persists administrator stop intent before an uncertain close and never retries or registers it', async () => {
    const context = fixture();
    context.store.saveResource(resource({ state: 'blocked', instance_id: createdId }));
    context.platform.closeInstance.mockRejectedValueOnce(new Error('unknown close result'));
    await expect(context.lifecycle.stopUnregistered('resource')).rejects.toThrow('unknown close result');
    expect(context.store.resource('resource')).toMatchObject({ state: 'blocked', error_code: 'COMFY_RESOURCE_STOP_REQUESTED' });
    await expect(context.lifecycle.stopUnregistered('resource')).rejects.toMatchObject({ code: 'RESOURCE_STOP_UNCONFIRMED' });
    await context.lifecycle.tick();
    expect(context.platform.closeInstance).toHaveBeenCalledExactlyOnceWith(createdId);
    expect(context.configuration.instances.map(instance => instance.id)).not.toContain(createdId);
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, status: '22' });
    await context.lifecycle.tick();
    expect(context.store.resource('resource')).toMatchObject({ state: 'blocked', error_code: 'COMFY_RESOURCE_STOPPED' });
    expect(context.store.resourceObservations()).toEqual([{ resource_key: 'resource', status: '22', observed_at: clock }]);
  });

  it('refuses administrator stop of a registered resource', async () => {
    const context = fixture();
    context.store.saveResource(resource({ state: 'registered', instance_id: '1' }));
    await expect(context.lifecycle.stopUnregistered('resource')).rejects.toMatchObject({ code: 'RESOURCE_STOP_UNSAFE' });
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
  });

  it('continues probing a blocked known instance after timeout and restart until registration succeeds', async () => {
    const context = fixture();
    context.demand();
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, status: '22', services: [] });
    await context.lifecycle.tick();
    const key = context.store.resources()[0]!.key;
    expect(context.store.resource(key)).toMatchObject({ state: 'creating', instance_id: createdId });
    clock += context.configuration.elastic!.reconcileTimeoutMs;
    await context.lifecycle.tick();
    expect(context.store.resource(key)?.state).toBe('blocked');
    expect(context.platform.getInstance).toHaveBeenCalledTimes(2);
    const restarted = context.restart();
    clock += 1;
    await restarted.lifecycle.tick();
    expect(context.platform.getInstance).toHaveBeenCalledTimes(3);
    expect(context.store.resource(key)?.state).toBe('blocked');
    expect(restarted.store.resourceObservations()).toEqual([{ resource_key: key, status: '22', observed_at: clock }]);
    context.platform.getInstance.mockResolvedValue(context.metadata);
    clock += 1;
    await restarted.lifecycle.tick();
    expect(context.store.resource(key)).toMatchObject({ state: 'registered', instance_id: createdId });
    expect(restarted.configuration.instances.map(instance => instance.id)).toEqual(['1', createdId]);
    expect(context.store.resourceObservations()).toEqual([{ resource_key: key, status: '2', observed_at: clock }]);
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
  });

  it('inspects only the bound ID and persists a safe, restart-stable observation without changing lifecycle state', async () => {
    const context = fixture();
    const row = resource({ state: 'blocked', instance_id: createdId });
    context.store.saveResource(row);
    const configuration = structuredClone(context.configuration);
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, status: '22', operationStatus: '4', instanceName: 'secret-private-name',
      services: [{ host: 'https://private.invalid?token=secret', protocol: 'SSH', port: 22 }] });
    await context.lifecycle.inspect(row.key);
    expect(context.platform.getInstance).toHaveBeenCalledExactlyOnceWith(createdId);
    expect(context.store.resourceObservations()).toEqual([{ resource_key: row.key, status: '4', observed_at: clock }]);
    expect(context.store.resource(row.key)).toEqual(row);
    expect(context.configuration).toEqual(configuration);
    expect(context.store.instance(createdId)).toBeUndefined();
    clock += 1;
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, status: '22' });
    await context.lifecycle.inspect(row.key);
    const restarted = context.restart();
    expect(restarted.store.resourceObservations()).toEqual([{ resource_key: row.key, status: '22', observed_at: clock }]);
    expect(context.store.resource(row.key)).toEqual(row);
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    expect(context.platform.pageInstances).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unbound'] as const)('rejects inspection of a %s resource without making platform calls', async scenario => {
    const context = fixture();
    if (scenario === 'unbound') context.store.saveResource(resource());
    await expect(context.lifecycle.inspect('resource')).rejects.toMatchObject({ code: 'RESOURCE_INSPECTION_UNAVAILABLE' });
    expect(context.platform.getInstance).not.toHaveBeenCalled();
    expect(context.store.resourceObservations()).toEqual([]);
  });

  it('refuses to attribute another instance metadata to the inspected resource', async () => {
    const context = fixture();
    context.store.saveResource(resource({ state: 'blocked', instance_id: createdId }));
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, id: '999', status: '4' });
    await expect(context.lifecycle.inspect('resource')).rejects.toMatchObject({ code: 'RESOURCE_ID_MISMATCH' });
    expect(context.store.resourceObservations()).toEqual([]);
    expect(context.store.resource('resource')?.state).toBe('blocked');
  });

  it('rejects an unsafe status instead of persisting a provider payload or secrets', async () => {
    const context = fixture();
    context.store.saveResource(resource({ state: 'blocked', instance_id: createdId }));
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, status: 'token=secret\nAuthorization: password' });
    await expect(context.lifecycle.inspect('resource')).rejects.toThrow('Invalid ComfyUI resource observation');
    expect(context.store.resourceObservations()).toEqual([]);
    expect(context.store.resource('resource')?.state).toBe('blocked');
  });
});

describe('ComfyLifecycle idle and release safety', () => {
  it('does not mutate platform resources after losing worker ownership', async () => {
    const context = releasableFixture();
    context.assertWorker.mockImplementation(() => { throw new Error('lease lost'); });
    await context.lifecycle.tick();
    expect(context.platform.getInstanceStatus).not.toHaveBeenCalled();
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
    expect(context.store.resource('resource')?.state).toBe('registered');
  });

  it('records idle time before closing and sends only one close request', async () => {
    const context = fixture({ autoOpen: false });
    await context.lifecycle.tick();
    expect(context.store.instance('1')?.idle_since).toBe(clock);
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    clock += 299_999;
    await context.lifecycle.tick();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    clock += 1;
    await context.lifecycle.tick();
    expect(context.platform.closeInstance).toHaveBeenCalledExactlyOnceWith('1');
    expect(context.store.instance('1')).toMatchObject({ state: 'closing', action_sent: 1, action_started_at: clock });
    await context.lifecycle.tick();
    expect(context.platform.closeInstance).toHaveBeenCalledTimes(1);
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
  });

  it('retains the configured minimum number of warm instances', async () => {
    const context = idleFixture();
    context.configuration.scheduler!.minWarmInstances = 1;
    await context.lifecycle.tick();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
  });

  it.each([false, true])('protects pending results from close and release when stopped=%s', async stopped => {
    const context = idleFixture(stopped);
    context.configuration.instances[0]!.lifecycle = { allowRelease: true, rebuildVerified: true, hourlyCost: 1, storageHourlyCost: 0.1 };
    const job = context.submit();
    context.store.updateInstance('1', { state: 'ready' });
    context.store.claim('1', ['render'], clock);
    context.store.updateJob(job.id, { stage: 'succeeded', result_pending: 1, result: '{}' });
    context.store.releaseSlot(job.id);
    await context.lifecycle.tick();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
    expect(context.store.instance('1')?.idle_since).toBeNull();
  });

  it.each([false, true])('protects sticky queued jobs even when not eligible and stopped=%s', async stopped => {
    const context = idleFixture(stopped);
    context.configuration.instances[0]!.lifecycle = { allowRelease: true, rebuildVerified: true, hourlyCost: 1, storageHourlyCost: 0.1 };
    const job = context.submit();
    context.store.updateInstance('1', { state: 'ready' });
    context.store.claim('1', ['render'], clock);
    context.store.updateJob(job.id, { stage: 'queued', eligible_at: clock + 600_000 });
    context.store.releaseSlot(job.id);
    await context.lifecycle.tick();
    expect(context.store.get(job.id)?.instance_id).toBe('1');
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
    expect(context.store.instance('1')?.idle_since).toBeNull();
  });

  it.each(['running', 'pending'] as const)('does not close or release when the external ComfyUI queue has %s work', async kind => {
    const context = idleFixture();
    context.client.queue.mockResolvedValue({ running: [], pending: [], [kind]: [{ promptId: 'external-prompt' }] });
    await context.lifecycle.tick();
    expect(context.client.health).toHaveBeenCalledTimes(1);
    expect(context.client.queue).toHaveBeenCalledTimes(1);
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
  });

  it.each(['health', 'queue'] as const)('fails closed if external %s cannot be verified', async method => {
    const context = idleFixture();
    context.client[method].mockRejectedValue(new Error('unavailable'));
    await context.lifecycle.tick();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
    expect(context.store.instance('1')?.error_code).toBe('COMFY_LIFECYCLE_FAILED');
  });

  it.each([false, true])('rechecks work arriving during an asynchronous status query when stopped=%s', async stopped => {
    const context = idleFixture(stopped);
    context.configuration.instances[0]!.lifecycle = { allowRelease: true, rebuildVerified: true, hourlyCost: 1, storageHourlyCost: 0.1 };
    context.platform.getInstanceStatus.mockImplementation(async () => {
      context.submit();
      return stopped ? '22' : '2';
    });
    await context.lifecycle.tick();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
  });

  it('rechecks gateway work arriving during the external queue query before closing', async () => {
    const context = idleFixture();
    context.client.queue.mockImplementation(async () => {
      context.submit();
      return { running: [], pending: [] };
    });
    await context.lifecycle.tick();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
  });

  it.each([[false, false], [false, true], [true, false]])('requires both release consent and rebuild verification: %s/%s', async (allowRelease, rebuildVerified) => {
    const context = releasableFixture();
    context.configuration.instances[0]!.lifecycle!.allowRelease = allowRelease;
    context.configuration.instances[0]!.lifecycle!.rebuildVerified = rebuildVerified;
    await context.lifecycle.tick();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
    expect(context.store.resource('resource')?.state).toBe('registered');
  });

  it('releases only a consented, rebuild-verified instance after its stopped retention period', async () => {
    const context = releasableFixture();
    context.store.updateInstance('1', { stopped_at: clock - 3_599_999 });
    await context.lifecycle.tick();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
    clock += 1;
    context.platform.releaseInstance.mockImplementation(async id => {
      expect(id).toBe('1');
      expect(context.store.resource('resource')?.state).toBe('releasing');
      expect(context.store.instance('1')?.draining).toBe(1);
    });
    await context.lifecycle.tick();
    expect(context.platform.releaseInstance).toHaveBeenCalledExactlyOnceWith('1');
    expect(context.store.resource('resource')?.state).toBe('releasing');
    expect(context.configuration.instances.map(instance => instance.id)).toEqual(['1']);
    expect(context.store.instance('1')).toMatchObject({ state: 'offline', draining: 1 });
    await context.lifecycle.tick();
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
    expect(context.store.resource('resource')?.state).toBe('releasing');
    context.platform.pageInstances.mockResolvedValue({ total: 1, records: [{ id: '1', status: '4', services: [] }] });
    await context.lifecycle.tick();
    expect(context.platform.pageInstances).toHaveBeenLastCalledWith({ current: 1, pageSize: 20, operationStatus: '4' });
    expect(context.store.resource('resource')?.state).toBe('released');
    expect(context.configuration.instances).toEqual([]);
    expect(context.store.resourceObservations()).toEqual([{ resource_key: 'resource', status: '4', observed_at: clock }]);
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
  });

  it('never releases a running instance or an unconfigured platform instance', async () => {
    const context = releasableFixture();
    context.platform.getInstanceStatus.mockResolvedValue('2');
    context.platform.pageInstances.mockResolvedValue({ total: 1, records: [{ id: '999', status: '22', services: [] }] });
    await context.lifecycle.tick();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
    expect(context.configuration.instances.map(instance => instance.id)).toEqual(['1']);
    expect(context.store.instance('999')).toBeUndefined();
  });

  it('does not release a configured legacy instance without an explicit lifecycle opt-in', async () => {
    const context = idleFixture(true);
    delete context.configuration.instances[0]!.lifecycle;
    await context.lifecycle.tick();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
    expect(context.store.resources()).toEqual([]);
  });

  it('keeps a release timeout uncertain, resumes status queries after restart and never resends release', async () => {
    const context = releasableFixture();
    context.platform.releaseInstance.mockRejectedValue(new AigateError('TIMEOUT', 'outcome unknown', undefined, true));
    await context.lifecycle.tick();
    expect(context.store.resource('resource')).toMatchObject({ state: 'releasing', error_code: 'COMFY_TIMEOUT' });
    const metadata = { id: '1', status: '22', services: [] };
    context.platform.pageInstances.mockResolvedValue({ total: 1, records: [metadata] });
    const restarted = context.restart();
    expect(restarted.store.instance('1')?.draining).toBe(1);
    for (let attempt = 0; attempt < 2; attempt++) await restarted.lifecycle.tick();
    expect(context.platform.pageInstances).toHaveBeenCalledTimes(2);
    expect(context.platform.pageInstances).toHaveBeenLastCalledWith({ current: 1, pageSize: 20, operationStatus: '4' });
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
    expect(context.store.resource('resource')?.state).toBe('releasing');
    context.platform.pageInstances.mockResolvedValue({ total: 0, records: [] });
    await restarted.lifecycle.tick();
    expect(context.store.resource('resource')?.state).toBe('releasing');
    expect(restarted.configuration.instances.map(instance => instance.id)).toEqual(['1']);
    context.platform.pageInstances.mockResolvedValue({ total: 1, records: [{ id: '1', status: '22', operationStatus: '4', services: [] }] });
    await restarted.lifecycle.tick();
    expect(context.store.resource('resource')?.state).toBe('released');
    expect(restarted.configuration.instances).toEqual([]);
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
  });

  it('does not infer successful release from a partial or failed instance listing', async () => {
    const context = releasableFixture();
    context.platform.releaseInstance.mockRejectedValue(new AigateError('TIMEOUT', 'outcome unknown', undefined, true));
    await context.lifecycle.tick();
    context.platform.pageInstances.mockResolvedValue({ total: 2, records: [{ id: 'other', status: '22', services: [] }] });
    await context.lifecycle.tick();
    expect(context.store.resource('resource')?.state).toBe('releasing');
    context.platform.pageInstances.mockRejectedValue(new Error('network'));
    await context.lifecycle.tick();
    expect(context.store.resource('resource')?.state).toBe('releasing');
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'absent ID', records: [] },
    { name: 'different released ID', records: [{ id: '999', status: '4', services: [] }] },
    { name: 'same ID without released state', records: [{ id: '1', status: '22', services: [] }] },
    { name: 'same ID with a conflicting operation state', records: [{ id: '1', status: '4', operationStatus: '2', services: [] }] },
  ])('does not treat $name as release evidence', async ({ records }) => {
    const context = releasableFixture();
    await context.lifecycle.tick();
    context.platform.pageInstances.mockResolvedValue({ total: records.length, records });
    await context.lifecycle.tick();
    expect(context.platform.pageInstances).toHaveBeenCalledExactlyOnceWith({ current: 1, pageSize: 20, operationStatus: '4' });
    expect(context.store.resource('resource')?.state).toBe('releasing');
    expect(context.configuration.instances.map(instance => instance.id)).toEqual(['1']);
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
    expect(context.store.resourceObservations()).toEqual([]);
  });

  it('never queries the null billing list or uses it as release evidence', async () => {
    const context = releasableFixture();
    await context.lifecycle.tick();
    context.platform.pageInstances.mockImplementation(async request => request.operationStatus === null
      ? { total: 1, records: [{ id: '1', status: '4', services: [] }] } : { total: 0, records: [] });
    await context.lifecycle.tick();
    expect(context.platform.pageInstances).toHaveBeenCalledExactlyOnceWith({ current: 1, pageSize: 20, operationStatus: '4' });
    expect(context.store.resource('resource')?.state).toBe('releasing');
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
  });

  it('continues through released-state pages to find explicit same-ID confirmation', async () => {
    const context = releasableFixture();
    await context.lifecycle.tick();
    context.platform.pageInstances.mockImplementation(async request => {
      expect(request.operationStatus).toBe('4');
      return request.current === 1
        ? { total: 21, records: Array.from({ length: 20 }, (_, index) => ({ id: String(index + 100), status: '4', services: [] })) }
        : { total: 21, records: [{ id: '1', status: '4', services: [] }] };
    });
    await context.lifecycle.tick();
    expect(context.platform.pageInstances).toHaveBeenCalledTimes(2);
    expect(context.platform.pageInstances).toHaveBeenLastCalledWith({ current: 2, pageSize: 20, operationStatus: '4' });
    expect(context.store.resource('resource')?.state).toBe('released');
    expect(context.configuration.instances).toEqual([]);
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
  });

  it('keeps a releasing instance protected if an uncollected result appears before reconciliation completes', async () => {
    const context = releasableFixture();
    const job = context.submit();
    context.store.updateInstance('1', { state: 'ready' });
    context.store.claim('1', ['render'], clock);
    context.store.updateJob(job.id, { stage: 'succeeded', result_pending: 0 });
    context.store.releaseSlot(job.id);
    context.platform.releaseInstance.mockRejectedValue(new AigateError('TIMEOUT', 'outcome unknown', undefined, true));
    await context.lifecycle.tick();
    expect(context.store.resource('resource')?.state).toBe('releasing');
    context.store.updateJob(job.id, { result_pending: 1, result: '{}' });
    context.platform.pageInstances.mockResolvedValue({ total: 1, records: [{ id: '1', status: '4', services: [] }] });
    const restarted = context.restart();
    await restarted.lifecycle.tick();
    expect(context.store.resource('resource')?.state).toBe('releasing');
    expect(restarted.configuration.instances.map(instance => instance.id)).toEqual(['1']);
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
    context.store.updateJob(job.id, { result_pending: 0 });
    await restarted.lifecycle.tick();
    expect(context.store.resource('resource')?.state).toBe('released');
    expect(restarted.configuration.instances).toEqual([]);
    expect(context.platform.releaseInstance).toHaveBeenCalledTimes(1);
  });
});

describe('ComfyLifecycle managed endpoint safety', () => {
  it.each(['HTTP', 'http'])('registers an explicitly verified %s 8188 service without exposing the internal port', async protocol => {
    const context = fixture();
    context.demand();
    context.platform.getInstance.mockResolvedValue({ ...context.metadata,
      services: [{ host: 'created.waas.aigate.cc', protocol, httpType: '1', port: 8188 }] });
    await context.lifecycle.tick();
    const registered = context.configuration.instances.find(instance => instance.id === createdId)!;
    expect(registered.baseUrl).toBe('https://created.waas.aigate.cc');
    expect(new URL(registered.baseUrl).port).toBe('');
    expect(context.store.resources()[0]?.state).toBe('registered');
  });

  it.each([
    { name: 'SSH-only service', services: [{ host: 'created.waas.aigate.cc', protocol: 'SSH', port: 22 }] },
    { name: 'SSH mislabeled port', services: [{ host: 'created.waas.aigate.cc', protocol: 'SSH', httpType: '1', port: 8188 }] },
    { name: 'missing protocol', services: [{ host: 'created.waas.aigate.cc', httpType: '1', port: 8188 }] },
    { name: 'missing HTTP type', services: [{ host: 'created.waas.aigate.cc', protocol: 'HTTP', port: 8188 }] },
    { name: 'unverified HTTP type', services: [{ host: 'created.waas.aigate.cc', protocol: 'HTTP', httpType: '2', port: 8188 }] },
    { name: 'incorrect port despite instancePort', services: [{ host: 'created.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 22, instancePort: 8188 }] },
    { name: 'ambiguous HTTP endpoints', services: [
      { host: 'first.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 8188 },
      { host: 'second.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 8188 },
    ] },
  ])('does not register $name as a ComfyUI HTTP endpoint', async ({ services }) => {
    const context = fixture();
    context.demand();
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, services });
    await context.lifecycle.tick();
    expect(context.store.resources()[0]).toMatchObject({ state: 'creating', instance_id: createdId, configuration: null, error_code: 'COMFY_ELASTIC_ENDPOINT_PENDING' });
    expect(context.configuration.instances.map(instance => instance.id)).toEqual(['1']);
    expect(context.store.instance(createdId)).toBeUndefined();
  });

  it('chooses the verified HTTP service rather than an adjacent SSH service', async () => {
    const context = fixture();
    context.demand();
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, services: [
      { host: 'ssh.waas.aigate.cc', protocol: 'SSH', port: 22 },
      { host: 'created.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 8188 },
    ] });
    await context.lifecycle.tick();
    expect(context.configuration.instances.find(instance => instance.id === createdId)?.baseUrl).toBe('https://created.waas.aigate.cc');
  });

  it.each([
    'http://worker.waas.aigate.cc', 'https://127.0.0.1', 'https://worker.invalid',
    'https://worker.waas.aigate.cc.attacker.invalid', 'https://user:password@worker.waas.aigate.cc',
    'https://worker.waas.aigate.cc?token=secret', 'https://worker.waas.aigate.cc#fragment',
    'https://worker.waas.aigate.cc:8188', 'https://worker.waas.aigate.cc/private',
  ])('refuses unsafe newly created endpoint %s without registering or creating again', async host => {
    const context = fixture();
    context.demand();
    context.platform.getInstance.mockResolvedValue({ ...context.metadata, services: [{ host, protocol: 'HTTP', httpType: '1', port: 8188 }] });
    await context.lifecycle.tick();
    expect(context.configuration.instances.map(instance => instance.id)).toEqual(['1']);
    expect(context.store.instance(createdId)).toBeUndefined();
    expect(context.store.resources()[0]).toMatchObject({ state: 'creating', instance_id: createdId, configuration: null });
    await context.lifecycle.tick();
    expect(context.platform.createInstance).toHaveBeenCalledTimes(1);
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
  });

  it('refuses an unsafe persisted endpoint before restoring it into managed configuration', () => {
    const context = fixture();
    context.store.saveResource(resource({ state: 'registered', instance_id: createdId,
      configuration: JSON.stringify({ id: createdId, baseUrl: 'https://127.0.0.1', workflowIds: ['render'] }) }));
    expect(() => context.restart()).toThrow('Invalid managed ComfyUI service URL');
    expect(context.platform.createInstance).not.toHaveBeenCalled();
    expect(context.platform.releaseInstance).not.toHaveBeenCalled();
  });
});
