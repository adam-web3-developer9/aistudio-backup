import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadComfyConfiguration } from './configuration.js';
import { compileWorkflow } from './workflow.js';
import { comfyOptionsFromEnv } from './runtime.js';

const directories: string[] = [];
const resultArchive = { bucket: 'public-results', region: 'cn-beijing', endpoint: 'https://tos-cn-beijing.volces.com',
  publicReadApproved: true, gpuExporterVerified: true };
const schedulerDefaults = {
  uploadReservationTimeoutMs: 600_000, uploadRetryDelayMs: 60_000, maxUploadReservations: 3,
  idleStopAfterMs: 300_000, minWarmInstances: 0, maxConcurrentInstances: 6,
  estimatedJobMs: 600_000, targetQueueWaitMs: 600_000
};

function elasticTemplate() {
  return { id: 'template-1', areaName: '华东一区', gpuModel: '5090', imageId: '1234567890123456789',
    imageType: '2', skuName: 'RTX 5090', workflowIds: ['fixture'], hourlyCost: 2.5,
    skuPriceToHourlyFactor: 1 / 60, skuPriceUnitVerified: true,
    storageHourlyCost: 0, rebuildVerified: false, allowRelease: false };
}

function elasticConfiguration() {
  return { enabled: true, maxHourlyCost: 20, templates: [elasticTemplate()] };
}
const graph = {
  '1': { class_type: 'LoadImage', inputs: { image: 'fixture.png' } },
  '2': { class_type: 'Render', inputs: { image: ['1', 0], text: 'fixture text', seed: 42 } }
};

function configuration() {
  return {
    instances: [{ id: '1096749550260588544', baseUrl: 'https://comfy.example/',
      headersEnv: { Authorization: 'COMFY_TEST_SECRET' }, workflowIds: ['fixture'] }],
    workflows: [{ id: 'fixture', version: '1', file: 'graphs/fixture.json',
      bindings: { image: { nodeId: '1', input: 'image', required: true, kind: 'media' },
        text: { nodeId: '2', input: 'text', required: true, kind: 'value' } }, outputNodeIds: ['2'] }]
  };
}

async function fixture(config: unknown = configuration()) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'comfy-config-test-'));
  directories.push(directory);
  await mkdir(path.join(directory, 'graphs'));
  await writeFile(path.join(directory, 'graphs', 'fixture.json'), JSON.stringify(graph));
  const file = path.join(directory, 'pool.json');
  await writeFile(file, JSON.stringify(config));
  return file;
}

async function loadConfiguration(config: unknown) {
  return loadComfyConfiguration(await fixture(config), { COMFY_TEST_SECRET: 'test-secret' });
}

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('loadComfyConfiguration', () => {
  it('keeps result archiving opt-in and requires explicit public read approval and exporter verification', async () => {
    const legacy = await loadConfiguration(configuration());
    expect(legacy.resultArchive).toBeUndefined();
    const enabled = await loadConfiguration({ ...configuration(), resultArchive });
    expect(enabled.resultArchive).toEqual({ ...resultArchive, keyPrefix: 'comfy-results' });
  });

  it.each([
    { publicReadApproved: false }, { gpuExporterVerified: false }, { region: 'cn-shanghai' },
    { endpoint: 'http://tos-cn-beijing.volces.com' }, { endpoint: 'https://127.0.0.1' },
    { endpoint: 'https://tos-cn-beijing.volces.com.evil.test' }, { bucket: '../private' },
    { keyPrefix: '../results' }, { keyPrefix: '/results' }, { accessKeySecret: 'must-not-be-in-json' },
  ])('rejects unsafe archive configuration %#', async patch => {
    await expect(loadConfiguration({ ...configuration(), resultArchive: { ...resultArchive, ...patch } })).rejects.toThrow();
  });

  it('loads archive secrets only from the explicit server environment', async () => {
    const file = await fixture({ ...configuration(), resultArchive });
    const environment = { SYSTEM_COMFYUI_CONFIG: file, AIGATE_ACCESS_TOKEN: 'fixture-aigate', COMFY_TEST_SECRET: 'test-secret',
      COMFY_TOS_ACCESS_KEY_ID: 'fixture-id', COMFY_TOS_ACCESS_KEY_SECRET: 'fixture-secret', COMFY_RESULT_EXPORT_SECRET: 'x'.repeat(32) };
    const loaded = await comfyOptionsFromEnv(environment);
    expect(loaded?.archiveSecrets).toEqual({ accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret', exporterSecret: 'x'.repeat(32) });
    expect(JSON.stringify(loaded?.configuration)).not.toContain('fixture-secret');
    for (const field of ['COMFY_TOS_ACCESS_KEY_ID', 'COMFY_TOS_ACCESS_KEY_SECRET', 'COMFY_RESULT_EXPORT_SECRET']) {
      await expect(comfyOptionsFromEnv({ ...environment, [field]: '' })).rejects.toThrow('credentials');
    }
  });

  it('loads a relative API graph fixture, resolves explicit secrets, and applies pool defaults', async () => {
    const file = await fixture();
    const loaded = await loadComfyConfiguration(file, { COMFY_TEST_SECRET: 'Bearer fixture-secret' });
    expect(loaded).toMatchObject({ autoOpen: false, pollIntervalMs: 5_000,
      bootTimeoutMs: 600_000, jobTimeoutMs: 7_200_000,
      capacityPollIntervalMs: 30_000, capacityWaitTimeoutMs: 21_600_000, capacityErrorCodes: [] });
    expect(loaded.instances).toEqual([{ id: '1096749550260588544', baseUrl: 'https://comfy.example',
      headers: { Authorization: 'Bearer fixture-secret' }, workflowIds: ['fixture'], areaName: '华东一区', gpuModel: '5090' }]);
    expect(loaded.workflows).toHaveLength(1);
    expect(loaded.scheduler).toEqual(schedulerDefaults);
    expect(loaded.elastic).toBeUndefined();
    expect(loaded.instances[0]!.lifecycle).toBeUndefined();
    const profile = loaded.workflows[0]!;
    expect(profile).toMatchObject({ id: 'fixture', version: '1', graph, outputNodeIds: ['2'] });
    expect(compileWorkflow(profile, { image: 'uploaded.png', text: 'bound text' })).toEqual({
      '1': { class_type: 'LoadImage', inputs: { image: 'uploaded.png' } },
      '2': { class_type: 'Render', inputs: { image: ['1', 0], text: 'bound text', seed: 42 } }
    });
    expect(profile.graph).toEqual(graph);
  });

  it('rejects duplicate instance IDs', async () => {
    const config = configuration();
    config.instances.push({ ...config.instances[0]! });
    await expect(loadComfyConfiguration(await fixture(config), {})).rejects.toThrow('Duplicate ComfyUI instance ID');
  });

  it.each([1, 3, 4, 100])('accepts a fixed pool of %i instances', async count => {
    const config = configuration();
    config.instances = Array.from({ length: count }, (_, index) => ({ ...config.instances[0]!, id: String(index + 1),
      areaName: index % 2 === 0 ? '华东一区' : '华东二区', gpuModel: '5090' }));
    const loaded = await loadComfyConfiguration(await fixture(config), { COMFY_TEST_SECRET: 'test-secret' });
    expect(loaded.instances).toHaveLength(count);
  });

  it('defaults legacy instance metadata by position without inventing a different GPU model', async () => {
    const config = configuration();
    config.instances.push({ ...config.instances[0]!, id: '2' });
    const loaded = await loadComfyConfiguration(await fixture(config), { COMFY_TEST_SECRET: 'test-secret' });
    expect(loaded.instances.map(({ areaName, gpuModel }) => ({ areaName, gpuModel }))).toEqual([
      { areaName: '华东一区', gpuModel: '5090' }, { areaName: '华东二区', gpuModel: '5090' }
    ]);
  });

  it('preserves explicit metadata and input order for service-owned GPU prioritization', async () => {
    const config = configuration();
    const instances = Array.from({ length: 3 }, (_, index) => ({ ...config.instances[0]!, id: String(index + 1),
      areaName: index === 1 ? '华东二区' : '华东一区', gpuModel: index === 0 ? '4090' : '5090' }));
    const loaded = await loadComfyConfiguration(await fixture({ ...config, instances }), { COMFY_TEST_SECRET: 'test-secret' });
    expect(loaded.instances.map(({ id, areaName, gpuModel }) => ({ id, areaName, gpuModel }))).toEqual([
      { id: '1', areaName: '华东一区', gpuModel: '4090' },
      { id: '2', areaName: '华东二区', gpuModel: '5090' },
      { id: '3', areaName: '华东一区', gpuModel: '5090' }
    ]);
  });

  it.each([
    { areaName: '华东三区', gpuModel: '5090' }, { areaName: '华东一区', gpuModel: '3090' },
    { areaName: '华东一区', gpuModel: 5090 }, { areaName: '', gpuModel: '4090' }
  ])('rejects unsupported instance metadata %#', async metadata => {
    const config = configuration();
    await expect(loadComfyConfiguration(await fixture({ ...config,
      instances: [{ ...config.instances[0]!, ...metadata }] }), {})).rejects.toThrow();
  });

  it.each([
    {}, { areaName: '华东一区' }, { gpuModel: '5090' }, { areaName: '华东一区', gpuModel: '5090' }
  ])('accepts three instances without requiring explicit metadata or both areas %#', async metadata => {
    const config = configuration();
    const instances = Array.from({ length: 3 }, (_, index) => ({ ...config.instances[0]!, id: String(index + 1), ...metadata }));
    const loaded = await loadConfiguration({ ...config, instances });
    expect(loaded.instances).toHaveLength(3);
    expect(loaded.instances[0]).toMatchObject({ areaName: '华东一区', gpuModel: '5090' });
  });

  it('loads persistent capacity settings and preserves optional-media omission flags', async () => {
    const config = configuration();
    const workflows = config.workflows.map(profile => ({ ...profile, bindings: { ...profile.bindings,
      image: { ...profile.bindings.image, required: false, omitWhenMissing: true } } }));
    const settings = { capacityPollIntervalMs: 60_000, capacityWaitTimeoutMs: 43_200_000,
      capacityErrorCodes: ['TEST_ONLY_CAPACITY_CODE', '1234'] };
    const loaded = await loadComfyConfiguration(await fixture({ ...config, ...settings, workflows }), { COMFY_TEST_SECRET: 'test-secret' });
    expect(loaded).toMatchObject(settings);
    expect(loaded.workflows[0]!.bindings.image).toMatchObject({ required: false, kind: 'media', omitWhenMissing: true });
  });

  it('validates the production example after replacing deployment placeholders', async () => {
    const example = JSON.parse(await readFile(new URL('../../docs/examples/comfyui-pool.example.json', import.meta.url), 'utf8'));
    example.instances = example.instances.map((instance: Record<string, unknown>, index: number) => ({ ...instance, id: String(index + 1) }));
    example.workflows = example.workflows.map((profile: Record<string, unknown>) => ({ ...profile, file: 'graphs/fixture.json' }));
    const loaded = await loadComfyConfiguration(await fixture(example), {});
    expect(loaded.instances).toHaveLength(3);
    expect(new Set(loaded.instances.map(instance => instance.areaName))).toEqual(new Set(['华东一区', '华东二区']));
    expect(loaded.instances.map(instance => instance.gpuModel)).toEqual(['5090', '5090', '4090']);
    expect(loaded.instances.every(instance => Object.keys(instance.headers ?? {}).length === 0)).toBe(true);
    expect(loaded.capacityErrorCodes).toEqual([]);
  });

  it.each([
    { capacityPollIntervalMs: 0 }, { capacityPollIntervalMs: 30_000.5 },
    { capacityWaitTimeoutMs: 0 }, { capacityWaitTimeoutMs: 604_800_001 },
    { capacityPollIntervalMs: 120_000, capacityWaitTimeoutMs: 60_000 },
    { capacityErrorCodes: ['not a code'] }, { capacityErrorCodes: [1234] },
    { capacityErrorCodes: ['secret\r\nvalue'] }, { capacityErrorCodes: Array(101).fill('TEST_ONLY') }
  ])('rejects unsafe or inconsistent capacity settings %#', async settings => {
    await expect(loadComfyConfiguration(await fixture({ ...configuration(), ...settings }), {})).rejects.toThrow();
  });

  it.each([0, 101])('rejects a pool of %i instances', async count => {
    const config = configuration();
    config.instances = Array.from({ length: count }, (_, index) => ({ ...config.instances[0]!, id: String(index + 1) }));
    await expect(loadConfiguration(config)).rejects.toThrow();
  });

  it('fills partial scheduler and disabled elastic defaults without granting release permission', async () => {
    const config = configuration();
    const loaded = await loadConfiguration({ ...config, scheduler: { maxUploadReservations: 5 }, elastic: {},
      instances: [{ ...config.instances[0]!, lifecycle: { hourlyCost: 0, storageHourlyCost: 0 } }] });
    expect(loaded.scheduler).toEqual({ ...schedulerDefaults, maxUploadReservations: 5 });
    expect(loaded.elastic).toEqual({ enabled: false, maxInstances: 6, createCooldownMs: 60_000,
      releaseAfterMs: 3_600_000, reconcileTimeoutMs: 300_000, templates: [] });
    expect(loaded.instances[0]!.lifecycle).toEqual({ allowRelease: false, rebuildVerified: false,
      hourlyCost: 0, storageHourlyCost: 0 });
  });

  it('preserves explicit scheduler, elastic template and approved lifecycle values', async () => {
    const scheduler = { uploadReservationTimeoutMs: 120_000, uploadRetryDelayMs: 5_000,
      maxUploadReservations: 2, idleStopAfterMs: 60_000, minWarmInstances: 1,
      maxConcurrentInstances: 2, estimatedJobMs: 180_000, targetQueueWaitMs: 240_000 };
    const template = { ...elasticTemplate(), areaName: '华东二区', gpuModel: '4090',
      storageHourlyCost: 0.1, rebuildVerified: true, allowRelease: true };
    const elastic = { enabled: true, maxInstances: 2, maxHourlyCost: 10, createCooldownMs: 10_000,
      releaseAfterMs: 60_000, reconcileTimeoutMs: 120_000, templates: [template] };
    const lifecycle = { hourlyCost: 1.2, storageHourlyCost: 0.2, rebuildVerified: true, allowRelease: true };
    const config = configuration();
    const loaded = await loadConfiguration({ ...config, scheduler, elastic,
      instances: [{ ...config.instances[0]!, lifecycle }] });
    expect(loaded.scheduler).toEqual(scheduler);
    expect(loaded.elastic).toEqual(elastic);
    expect(loaded.instances[0]!.lifecycle).toEqual(lifecycle);
  });

  it.each(Object.keys(schedulerDefaults))('rejects invalid scheduler %s values', async field => {
    for (const value of [-1, 0.5, NaN, Infinity, '1', null]) {
      await expect(loadConfiguration({ ...configuration(), scheduler: { [field]: value } })).rejects.toThrow();
    }
    if (field !== 'minWarmInstances') {
      await expect(loadConfiguration({ ...configuration(), scheduler: { [field]: 0 } })).rejects.toThrow();
    }
  });

  it('rejects minWarmInstances above maxConcurrentInstances even without elastic', async () => {
    await expect(loadConfiguration({ ...configuration(), scheduler: { minWarmInstances: 7 } }))
      .rejects.toThrow('minWarmInstances must not exceed maxConcurrentInstances');
  });

  it.each(Object.keys(schedulerDefaults).filter(field => field.endsWith('Ms')))(
    'bounds scheduler duration %s to safe positive integers no greater than seven days', async field => {
      const loaded = await loadConfiguration({ ...configuration(), scheduler: { [field]: 604_800_000 } });
      expect(loaded.scheduler).toMatchObject({ [field]: 604_800_000 });
      for (const value of [604_800_001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1e100]) {
        await expect(loadConfiguration({ ...configuration(), scheduler: { [field]: value } })).rejects.toThrow();
      }
    }
  );

  it.each(['createCooldownMs', 'releaseAfterMs', 'reconcileTimeoutMs'])(
    'bounds elastic duration %s to safe positive integers no greater than seven days', async field => {
      const loaded = await loadConfiguration({ ...configuration(), elastic: { [field]: 604_800_000 } });
      expect(loaded.elastic).toMatchObject({ [field]: 604_800_000 });
      for (const value of [604_800_001, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, 1e100]) {
        await expect(loadConfiguration({ ...configuration(), elastic: { [field]: value } })).rejects.toThrow();
      }
    }
  );

  it('loads opt-in stopped retention independently from running idle time', async () => {
    const loaded = await loadConfiguration({ ...configuration(), elastic: { releaseAfterMs: 1_800_000, stoppedRetention: {} } });
    expect(loaded.elastic?.stoppedRetention).toEqual({ maxInstances: 1, excessReleaseAfterMs: 60_000 });
    const disabled = await loadConfiguration({ ...configuration(), elastic: { stoppedRetention: { maxInstances: 0 } } });
    expect(disabled.elastic?.stoppedRetention?.maxInstances).toBe(0);
  });

  it.each([
    { maxInstances: -1 }, { maxInstances: 1.5 }, { maxInstances: 101 }, { maxInstances: '1' },
    { excessReleaseAfterMs: 0 }, { excessReleaseAfterMs: -1 }, { excessReleaseAfterMs: 1.5 },
    { excessReleaseAfterMs: 1_800_001 }, { excessReleaseAfterMs: 604_800_001 }, { unknown: true },
  ])('rejects invalid stopped retention %#', async stoppedRetention => {
    await expect(loadConfiguration({ ...configuration(), elastic: { releaseAfterMs: 1_800_000, stoppedRetention } })).rejects.toThrow();
  });

  it.each([101, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])('rejects instance limits above 100: %s', async value => {
    await expect(loadConfiguration({ ...configuration(), scheduler: { maxConcurrentInstances: value } })).rejects.toThrow();
    await expect(loadConfiguration({ ...configuration(), elastic: { maxInstances: value } })).rejects.toThrow();
  });

  it('accepts instance and concurrency limits of exactly 100', async () => {
    const loaded = await loadConfiguration({ ...configuration(),
      scheduler: { minWarmInstances: 100, maxConcurrentInstances: 100 },
      elastic: { ...elasticConfiguration(), maxInstances: 100 } });
    expect(loaded.scheduler!.maxConcurrentInstances).toBe(100);
    expect(loaded.elastic!.maxInstances).toBe(100);
  });

  it.each([
    { enabled: true, templates: [elasticTemplate()] },
    { enabled: true, maxHourlyCost: 10 },
    { enabled: true, maxHourlyCost: 10, templates: [] }
  ])('requires an explicit budget and templates when elastic is enabled %#', async elastic => {
    await expect(loadConfiguration({ ...configuration(), elastic })).rejects.toThrow(/budget|requires templates/);
  });

  it.each(['maxInstances', 'maxHourlyCost', 'createCooldownMs', 'releaseAfterMs', 'reconcileTimeoutMs'])(
    'rejects invalid elastic %s values', async field => {
      for (const value of [-1, 0, NaN, Infinity, '1', null]) {
        await expect(loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(), [field]: value } })).rejects.toThrow();
      }
      if (field !== 'maxHourlyCost') {
        await expect(loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(), [field]: 1.5 } })).rejects.toThrow();
      }
    }
  );

  it('rejects enabled elastic concurrency above maxInstances', async () => {
    await expect(loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(), maxInstances: 5 } }))
      .rejects.toThrow('maxConcurrentInstances must not exceed elastic maxInstances');
  });

  it('checks existing instance count only when elastic is enabled', async () => {
    const config = configuration();
    const instances = Array.from({ length: 7 }, (_, index) => ({ ...config.instances[0]!, id: String(index + 1) }));
    await expect(loadConfiguration({ ...config, instances, elastic: elasticConfiguration() }))
      .rejects.toThrow('Existing ComfyUI instances exceed elastic maxInstances');
    const loaded = await loadConfiguration({ ...config, instances, elastic: { maxInstances: 1 } });
    expect(loaded.instances).toHaveLength(7);
  });

  it.each([false, true])('requires releaseAfterMs to cover idleStopAfterMs with elastic enabled=%s', async enabled => {
    await expect(loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(), enabled, releaseAfterMs: 299_999 } }))
      .rejects.toThrow('releaseAfterMs must cover scheduler idleStopAfterMs');
  });

  it('accepts equal warm, concurrent and elastic instance limits', async () => {
    const loaded = await loadConfiguration({ ...configuration(),
      scheduler: { minWarmInstances: 6 }, elastic: elasticConfiguration() });
    expect(loaded.scheduler!.minWarmInstances).toBe(loaded.elastic!.maxInstances);
  });

  it('accepts 100 legacy instances with an explicit elastic limit of 100', async () => {
    const config = configuration();
    const instances = Array.from({ length: 100 }, (_, index) => ({ ...config.instances[0]!, id: String(index + 1) }));
    const loaded = await loadConfiguration({ ...config, instances, elastic: { ...elasticConfiguration(), maxInstances: 100 } });
    expect(loaded.instances).toHaveLength(100);
    expect(loaded.instances[99]).toMatchObject({ areaName: '华东二区', gpuModel: '5090' });
  });

  it.each([
    { scheduler: null }, { scheduler: [] }, { elastic: null }, { elastic: [] },
    { elastic: { enabled: 'true' } }, { elastic: { templates: null } }
  ])('rejects invalid scheduler and elastic object shapes %#', async settings => {
    await expect(loadConfiguration({ ...configuration(), ...settings })).rejects.toThrow();
  });

  it('rejects duplicate template IDs and unknown template workflows even when disabled', async () => {
    await expect(loadConfiguration({ ...configuration(), elastic: { templates: [elasticTemplate(), elasticTemplate()] } }))
      .rejects.toThrow('Duplicate ComfyUI elastic template ID');
    await expect(loadConfiguration({ ...configuration(), elastic: { templates: [{ ...elasticTemplate(), workflowIds: ['unknown'] }] } }))
      .rejects.toThrow('unknown workflow');
  });

  it.each([
    { id: '' }, { id: 'invalid id' }, { areaName: '华东三区' }, { gpuModel: '3090' },
    { imageId: '' }, { imageId: '1.5' }, { imageId: '-1' }, { imageId: '1e10' }, { imageId: 123 },
    { imageId: '0' }, { imageId: '01' }, { imageId: '+1' }, { imageId: ' 123' }, { imageId: '123 ' },
    { imageId: '1\n' }, { imageId: '1\r\n' },
    { imageId: '9223372036854775808' }, { imageId: '12345678901234567890' },
    { imageType: '1' }, { imageType: '4' }, { imageType: '' }, { imageType: 2 },
    { skuName: '' }, { skuName: '   ' }, { skuName: 'x'.repeat(101) }, { skuName: 123 },
    { workflowIds: [] }, { workflowIds: ['invalid id'] },
    { hourlyCost: 0 }, { hourlyCost: -1 }, { hourlyCost: NaN }, { hourlyCost: Infinity }, { hourlyCost: '2' },
    { storageHourlyCost: -1 }, { storageHourlyCost: NaN }, { storageHourlyCost: Infinity },
    { rebuildVerified: 'true' }, { allowRelease: 1 }
  ])('rejects invalid template parameters %#', async parameters => {
    await expect(loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(),
      templates: [{ ...elasticTemplate(), ...parameters }] } })).rejects.toThrow();
  });

  it.each(['1', '9007199254740993', '9223372036854775807'])('preserves canonical int64 image ID %s exactly', async imageId => {
    const loaded = await loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(),
      templates: [{ ...elasticTemplate(), imageId }] } });
    expect(loaded.elastic!.templates[0]!.imageId).toBe(imageId);
  });

  it.each(['2', '3'])('accepts required imageType %s and a 100-character skuName', async imageType => {
    const template = { ...elasticTemplate(), imageType, skuName: 'x'.repeat(100) };
    const loaded = await loadConfiguration({ ...configuration(), elastic: { templates: [template] } });
    expect(loaded.elastic!.templates).toEqual([template]);
  });

  it('rejects deprecated skuId even alongside a valid skuName', async () => {
    await expect(loadConfiguration({ ...configuration(), elastic: {
      templates: [{ ...elasticTemplate(), skuId: '123' }] } })).rejects.toThrow(/Unrecognized key/);
  });

  it('accepts distinct template IDs without changing create parameters', async () => {
    const templates = [elasticTemplate(), { ...elasticTemplate(), id: 'template-2', imageType: '3', skuName: 'RTX 4090' }];
    const loaded = await loadConfiguration({ ...configuration(), elastic: { templates } });
    expect(loaded.elastic!.templates).toEqual(templates);
  });

  it.each(Object.keys(elasticTemplate()))('requires template field %s', async field => {
    const template: Record<string, unknown> = elasticTemplate();
    delete template[field];
    await expect(loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(), templates: [template] } })).rejects.toThrow();
  });

  it.each([0, -1, NaN, Infinity, -Infinity, '1', null])('rejects invalid SKU price-to-hourly factors %#', async skuPriceToHourlyFactor => {
    await expect(loadConfiguration({ ...configuration(), elastic: { templates: [{ ...elasticTemplate(), skuPriceToHourlyFactor }] } }))
      .rejects.toThrow(/skuPriceToHourlyFactor/);
  });

  it.each([1 / 3_600, 0.01, 1, 3_600])('preserves an explicitly supplied finite positive SKU price factor %s', async skuPriceToHourlyFactor => {
    const loaded = await loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(),
      templates: [{ ...elasticTemplate(), skuPriceToHourlyFactor }] } });
    expect(loaded.elastic!.templates[0]!.skuPriceToHourlyFactor).toBe(skuPriceToHourlyFactor);
    expect(loaded.elastic!.templates[0]!.skuPriceUnitVerified).toBe(true);
  });

  it.each([0, 1, 'true', 'false', null])('rejects non-boolean SKU price unit verification %#', async skuPriceUnitVerified => {
    await expect(loadConfiguration({ ...configuration(), elastic: { templates: [{ ...elasticTemplate(), skuPriceUnitVerified }] } }))
      .rejects.toThrow(/skuPriceUnitVerified/);
  });

  it.each([0, 1])('rejects enabled elastic if template %i has an unverified SKU price unit', async unverifiedIndex => {
    const templates = [elasticTemplate(), { ...elasticTemplate(), id: 'template-2' }];
    templates[unverifiedIndex]!.skuPriceUnitVerified = false;
    await expect(loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(), templates } }))
      .rejects.toThrow('requires skuPriceUnitVerified for every template');
  });

  it('allows an explicitly unverified SKU price unit only while elastic is disabled', async () => {
    const loaded = await loadConfiguration({ ...configuration(), elastic: { enabled: false,
      templates: [{ ...elasticTemplate(), skuPriceUnitVerified: false }] } });
    expect(loaded.elastic!.enabled).toBe(false);
    expect(loaded.elastic!.templates[0]).toMatchObject({ skuPriceToHourlyFactor: 1 / 60, skuPriceUnitVerified: false });
  });

  it('rejects an overflowing JSON SKU price factor rather than accepting Infinity', async () => {
    const file = await fixture({ ...configuration(), elastic: { templates: [{ ...elasticTemplate(), skuPriceToHourlyFactor: 'overflow' }] } });
    const json = (await readFile(file, 'utf8')).replace(JSON.stringify('overflow'), '1e999');
    expect(JSON.parse(json).elastic.templates[0].skuPriceToHourlyFactor).toBe(Infinity);
    await writeFile(file, json);
    await expect(loadComfyConfiguration(file, { COMFY_TEST_SECRET: 'test-secret' })).rejects.toThrow(/skuPriceToHourlyFactor/);
  });

  it.each([false, true])('requires verified rebuild approval before template release with enabled=%s', async enabled => {
    await expect(loadConfiguration({ ...configuration(), elastic: { ...elasticConfiguration(), enabled,
      templates: [{ ...elasticTemplate(), allowRelease: true }] } })).rejects.toThrow('Template allowRelease requires rebuildVerified');
  });

  it.each([undefined, false])('rejects existing instance release without verified rebuild approval %#', async rebuildVerified => {
    const config = configuration();
    await expect(loadConfiguration({ ...config, instances: [{ ...config.instances[0]!, lifecycle: {
      hourlyCost: 0, storageHourlyCost: 0, allowRelease: true, rebuildVerified } }] }))
      .rejects.toThrow('Instance allowRelease requires rebuildVerified');
  });

  it('does not infer release permission from rebuild verification', async () => {
    const config = configuration();
    const loaded = await loadConfiguration({ ...config, instances: [{ ...config.instances[0]!, lifecycle: {
      hourlyCost: 0, storageHourlyCost: 0, rebuildVerified: true } }] });
    expect(loaded.instances[0]!.lifecycle!.allowRelease).toBe(false);
  });

  it.each([
    {}, { hourlyCost: 0 }, { storageHourlyCost: 0 },
    { hourlyCost: -1, storageHourlyCost: 0 }, { hourlyCost: 0, storageHourlyCost: -1 },
    { hourlyCost: NaN, storageHourlyCost: 0 }, { hourlyCost: 0, storageHourlyCost: Infinity },
    { hourlyCost: '1', storageHourlyCost: 0 },
    { hourlyCost: 0, storageHourlyCost: 0, allowRelease: 'false' },
    { hourlyCost: 0, storageHourlyCost: 0, rebuildVerified: 1 }
  ])('rejects invalid lifecycle costs or approvals %#', async lifecycle => {
    const config = configuration();
    await expect(loadConfiguration({ ...config, instances: [{ ...config.instances[0]!, lifecycle }] })).rejects.toThrow();
  });

  it.each(['pool', 'scheduler', 'elastic', 'template', 'instance', 'lifecycle'])('rejects unknown fields in %s', async scope => {
    const config = configuration();
    const unknown = { unexpected: true };
    const settings = scope === 'pool' ? unknown
      : scope === 'scheduler' ? { scheduler: unknown }
      : scope === 'elastic' ? { elastic: unknown }
      : scope === 'template' ? { elastic: { templates: [{ ...elasticTemplate(), ...unknown }] } }
      : { instances: [{ ...config.instances[0]!, ...(scope === 'instance' ? unknown
        : { lifecycle: { hourlyCost: 0, storageHourlyCost: 0, ...unknown } }) }] };
    await expect(loadConfiguration({ ...config, ...settings })).rejects.toThrow(/Unrecognized key/);
  });

  it('rejects overflowing JSON numbers rather than accepting infinite costs', async () => {
    const file = await fixture({ ...configuration(), elastic: { maxHourlyCost: 'overflow' } });
    const json = (await readFile(file, 'utf8')).replace(JSON.stringify('overflow'), '1e999');
    expect(JSON.parse(json).elastic.maxHourlyCost).toBe(Infinity);
    await writeFile(file, json);
    await expect(loadComfyConfiguration(file, { COMFY_TEST_SECRET: 'test-secret' })).rejects.toThrow();
  });

  it.each(['scheduler', 'elastic'])('rejects infinite JSON durations in %s', async scope => {
    const field = scope === 'scheduler' ? 'uploadReservationTimeoutMs' : 'createCooldownMs';
    const file = await fixture({ ...configuration(), [scope]: { [field]: 'overflow' } });
    const json = (await readFile(file, 'utf8')).replace(JSON.stringify('overflow'), '1e999');
    expect(JSON.parse(json)[scope][field]).toBe(Infinity);
    await writeFile(file, json);
    await expect(loadComfyConfiguration(file, { COMFY_TEST_SECRET: 'test-secret' })).rejects.toThrow();
  });

  it('rejects an instance referencing an unknown workflow', async () => {
    const config = configuration();
    config.instances[0]!.workflowIds = ['unknownWorkflow'];
    await expect(loadComfyConfiguration(await fixture(config), {})).rejects.toThrow('unknown workflow');
  });

  it('rejects duplicate workflow IDs', async () => {
    const config = configuration();
    config.workflows.push({ ...config.workflows[0]! });
    await expect(loadComfyConfiguration(await fixture(config), {})).rejects.toThrow('Duplicate ComfyUI workflow ID');
  });

  it.each(['http://comfy.example:8188', 'http://192.168.1.20:8188'])('rejects remote HTTP %s', async baseUrl => {
    const config = configuration();
    config.instances[0]!.baseUrl = baseUrl;
    await expect(loadComfyConfiguration(await fixture(config), {})).rejects.toThrow('require HTTPS');
  });

  it.each(['http://127.0.0.1:8188', 'http://localhost:8188', 'http://[::1]:8188'])(
    'allows explicitly configured loopback HTTP %s', async baseUrl => {
      const config = configuration();
      config.instances[0]!.baseUrl = baseUrl;
      const loaded = await loadComfyConfiguration(await fixture(config), { COMFY_TEST_SECRET: 'test-secret' });
      expect(loaded.instances[0]!.baseUrl).toBe(baseUrl);
    }
  );

  it.each([undefined, '', 'secret\r\nInjected: value'])('rejects missing or unsafe secret Env %#', async secret => {
    const environment = secret === undefined ? {} : { COMFY_TEST_SECRET: secret };
    await expect(loadComfyConfiguration(await fixture(), environment)).rejects.toThrow(
      'ComfyUI instance authentication is not configured'
    );
  });
});
