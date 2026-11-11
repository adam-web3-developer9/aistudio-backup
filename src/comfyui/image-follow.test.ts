import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { AigateError } from './aigate-client.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { schedulerPolicy } from './scheduler.js';
import { ComfyStore, type ComfyInput } from './store.js';

const cleanup: Array<() => Promise<void>> = [];
let clock = 1_800_000_000_000;
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); clock = 1_800_000_000_000; });

const imageName = 'Minimax-H3-字字动画';
const image = (id: string, version: string, sku = '5090-32GB') => ({ id, name: imageName, status: '1', areaName: '华东一区' as const,
  imageType: '2', imageVersion: version, comfyPort: true, sku });

function fixture(patch: { template?: Record<string, unknown>; existing?: boolean } = {}) {
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const db = new Database(':memory:');
  const store = new ComfyStore(db);
  const configuration: ComfyServiceOptions['configuration'] = {
    autoOpen: true, pollIntervalMs: 1_000, bootTimeoutMs: 30_000, jobTimeoutMs: 3_600_000,
    instances: patch.existing ? [{ id: '1', baseUrl: 'https://gpu.waas.aigate.cc', workflowIds: ['render'] }] : [],
    workflows: [{ id: 'render', version: '1', graph: { '1': { class_type: 'Render', inputs: {} } }, bindings: {}, outputNodeIds: ['1'] }],
    elastic: { enabled: !patch.existing, maxInstances: 4, createCooldownMs: 10_000, releaseAfterMs: 3_600_000, reconcileTimeoutMs: 300_000,
      templates: [{ id: 'template', areaName: '华东一区', imageName, imageType: '2', skuNames: ['5090-32GB', '4090D-48GB'],
        workflowIds: ['render'], storageHourlyCost: 0.1, skuPriceToHourlyFactor: 0.01, skuPriceUnitVerified: true,
        allowRelease: false, rebuildVerified: false, ...patch.template }] },
  };
  configuration.scheduler = schedulerPolicy(configuration);
  const platform = {
    getInstanceStatus: vi.fn().mockResolvedValue('22'), openInstance: vi.fn().mockResolvedValue(undefined), closeInstance: vi.fn(),
    skuList: vi.fn().mockResolvedValue([{ areaName: '华东一区', skuName: '5090-32GB', price: '319', sysDiskSize: '100' }]),
    listImages: vi.fn().mockResolvedValue([image('200', 'v0.8.9'), image('100', 'v0.8.8')]),
    getImage: vi.fn().mockResolvedValue(undefined),
    createInstance: vi.fn().mockResolvedValue('7'),
    getInstance: vi.fn().mockResolvedValue({ id: '7', status: '2', areaName: '华东一区', imageId: '200', imageType: '2', count: 1,
      services: [{ host: 'created.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 8188 }] }),
  };
  const client = { health: vi.fn().mockResolvedValue({}), queue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
    upload: vi.fn(), submit: vi.fn(), history: vi.fn(), findAttempt: vi.fn(), download: vi.fn() };
  const service = new ComfyService({ store, configuration, platform, client: () => client,
    assets: { get: () => undefined, read: async () => undefined }, ownsAsset: () => false,
    results: { save: vi.fn(), read: async () => null }, owner: 'owner' });
  cleanup.push(async () => { await service.close(); db.close(); });
  const submit = (key: string) => {
    const input: ComfyInput = { adapterId: 'comfyui-v1', requestKey: key, workflowId: 'render', media: {}, values: {} };
    return store.submit('owner', { ...input, profile: configuration.workflows[0]! }, 3_600_000).job;
  };
  return { service, store, platform, client, configuration, submit };
}

it('rents with the newest available image version and pins it on the resource', async () => {
  const { service, store, platform, submit } = fixture();
  const job = submit('follow');
  await service.tick();
  expect(platform.createInstance).toHaveBeenCalledWith({ areaName: '华东一区', count: 1, skuName: '5090-32GB', imageId: '200', imageType: '2' });
  expect(platform.listImages).toHaveBeenCalledWith({ imageType: '2', imageName, areaName: '华东一区', skuName: '5090-32GB', maxPages: 5 });
  expect(store.resources()[0]).toMatchObject({ state: 'registered', instance_id: '7', image_id: '200', image_type: '2',
    sku_name: '5090-32GB', area_name: '华东一区', error_code: null });
  expect(service.lifecycle.lastError).toBeNull();
  expect(service.publicJob(service.get(job.id)).progress.message).not.toContain('拒绝');
});

it('uses the first in-stock SKU from the allowlist and records its real GPU family', async () => {
  const { service, store, platform, configuration, submit } = fixture();
  platform.skuList.mockResolvedValue([{ areaName: '华东一区', skuName: '4090D-48GB', price: '329', sysDiskSize: '100' }]);
  platform.listImages.mockResolvedValue([image('300', 'v0.9.0', '4090D-48GB')]);
  platform.getInstance.mockResolvedValue({ id: '7', status: '2', areaName: '华东一区', imageId: '300', imageType: '2', count: 1,
    services: [{ host: 'created.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 8188 }] });
  submit('sku');
  await service.tick();
  expect(platform.createInstance).toHaveBeenCalledWith({ areaName: '华东一区', count: 1, skuName: '4090D-48GB', imageId: '300', imageType: '2' });
  const registered = configuration.instances.find(instance => instance.id === '7')!;
  expect(registered).toMatchObject({ gpuModel: '4090D', gpuModels: ['4090D', '4090'] });
  expect(store.resources()[0]).toMatchObject({ sku_name: '4090D-48GB', hourly_cost: 3.29 });
});

it('keeps queued work waiting when the image is temporarily unavailable instead of failing it', async () => {
  const { service, store, platform, submit } = fixture();
  const job = submit('missing-image');
  platform.listImages.mockResolvedValue([]);
  await service.tick();
  expect(platform.createInstance).not.toHaveBeenCalled();
  expect(store.get(job.id)).toMatchObject({ stage: 'queued', error_code: null });
  expect(service.publicJob(service.get(job.id))).not.toHaveProperty('error');
  expect(service.lifecycle.lastError).toBe('COMFY_IMAGE_UNAVAILABLE');
});

it('skips a template whose pinned image disappeared and never calls create with the stale ID', async () => {
  const { service, store, platform, submit } = fixture({ template: { imageName: undefined, imageId: '1164259372090134528' } });
  const job = submit('pinned');
  platform.getImage.mockResolvedValue(undefined);
  await service.tick();
  expect(platform.createInstance).not.toHaveBeenCalled();
  expect(store.get(job.id)).toMatchObject({ stage: 'queued', error_code: null });
  expect(service.lifecycle.lastError).toBe('COMFY_IMAGE_UNAVAILABLE');
  clock += 300_001;
  platform.getImage.mockResolvedValue({ id: '1164259372090134528', name: imageName, status: '1', areaName: '华东一区', imageType: '2', comfyPort: true });
  platform.getInstance.mockResolvedValue({ id: '7', status: '2', areaName: '华东一区', imageId: '1164259372090134528', imageType: '2', count: 1,
    services: [{ host: 'created.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 8188 }] });
  await service.tick();
  expect(platform.createInstance).toHaveBeenCalledWith({ areaName: '华东一区', count: 1, skuName: '5090-32GB',
    imageId: '1164259372090134528', imageType: '2' });
});

it('re-resolves the image after a create rejection and succeeds on the next tick without failing the job', async () => {
  const { service, store, platform, submit } = fixture();
  const job = submit('republish');
  platform.listImages.mockResolvedValueOnce([image('100', 'v0.8.8')]).mockResolvedValue([image('200', 'v0.8.9')]);
  platform.createInstance.mockRejectedValueOnce(new AigateError('BUSINESS_REJECTED', 'rejected', undefined, false, 'IMAGE_UNAVAILABLE'))
    .mockResolvedValue('7');
  await service.tick();
  expect(platform.createInstance).toHaveBeenLastCalledWith(expect.objectContaining({ imageId: '100' }));
  expect(store.get(job.id)).toMatchObject({ stage: 'queued', error_code: null });
  expect(service.lifecycle.lastError).toBe('COMFY_IMAGE_UNAVAILABLE');
  clock += 10_000;
  await service.tick();
  expect(platform.listImages).toHaveBeenCalledTimes(2);
  expect(platform.createInstance).toHaveBeenLastCalledWith(expect.objectContaining({ imageId: '200' }));
  expect(store.get(job.id)?.stage).not.toBe('failed');
});

it('verifies reconciled metadata against the image pinned at creation, not the moving template', async () => {
  const { service, store, platform, submit } = fixture();
  const job = submit('pin');
  platform.getInstance.mockResolvedValueOnce({ id: '7', status: '2', areaName: '华东一区', imageId: '200', imageType: '2', count: 1, services: [] });
  platform.listImages.mockResolvedValue([image('200', 'v0.8.9')]);
  await service.tick();
  expect(store.resources()[0]).toMatchObject({ state: 'creating', instance_id: '7', image_id: '200' });
  expect(service.lifecycle.lastError).toBe('COMFY_RESOURCE_INITIALIZING');
  // 发布者随后又发了新版本：模板解析到 300，但已租实例必须按创建时钉住的 200 核对。
  platform.listImages.mockResolvedValue([image('300', 'v0.9.0')]);
  platform.getInstance.mockResolvedValue({ id: '7', status: '2', areaName: '华东一区', imageId: '200', imageType: '2', count: 1,
    services: [{ host: 'created.waas.aigate.cc', protocol: 'HTTP', httpType: '1', port: 8188 }] });
  await service.tick();
  expect(store.resources()[0]).toMatchObject({ state: 'registered', instance_id: '7', image_id: '200' });
  expect(platform.createInstance).toHaveBeenCalledTimes(1);
});
