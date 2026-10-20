import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadComfyConfiguration } from './configuration.js';
import { compileWorkflow } from './workflow.js';

const directories: string[] = [];
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

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('loadComfyConfiguration', () => {
  it('loads a relative API graph fixture, resolves explicit secrets, and applies pool defaults', async () => {
    const file = await fixture();
    const loaded = await loadComfyConfiguration(file, { COMFY_TEST_SECRET: 'Bearer fixture-secret' });
    expect(loaded).toMatchObject({ autoOpen: false, pollIntervalMs: 5_000,
      bootTimeoutMs: 600_000, jobTimeoutMs: 7_200_000,
      capacityPollIntervalMs: 30_000, capacityWaitTimeoutMs: 21_600_000, capacityErrorCodes: [] });
    expect(loaded.instances).toEqual([{ id: '1096749550260588544', baseUrl: 'https://comfy.example',
      headers: { Authorization: 'Bearer fixture-secret' }, workflowIds: ['fixture'], areaName: '华东一区', gpuModel: '5090' }]);
    expect(loaded.workflows).toHaveLength(1);
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

  it.each([1, 3])('accepts a fixed pool of %i instances', async count => {
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
  ])('requires explicit metadata spanning both areas for three instances %#', async metadata => {
    const config = configuration();
    const instances = Array.from({ length: 3 }, (_, index) => ({ ...config.instances[0]!, id: String(index + 1), ...metadata }));
    await expect(loadComfyConfiguration(await fixture({ ...config, instances }), {})).rejects.toThrow('across both areas');
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

  it.each([0, 4])('rejects a pool of %i instances', async count => {
    const config = configuration();
    config.instances = Array.from({ length: count }, (_, index) => ({ ...config.instances[0]!, id: String(index + 1) }));
    await expect(loadComfyConfiguration(await fixture(config), {})).rejects.toThrow();
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
