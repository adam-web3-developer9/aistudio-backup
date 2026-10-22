import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadComfyConfiguration } from './configuration.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore, type ComfyInput } from './store.js';

type DataClient = ReturnType<ComfyServiceOptions['client']>;
type Configuration = ComfyServiceOptions['configuration'];
const resources: Array<{ service: ComfyService; db: Database.Database }> = [];
const directories: string[] = [];
const startedAt = 1_800_000_000_000;

function fixture(overrides: Partial<Configuration> = {}, filename?: string, enableIdlePolicy = false) {
  if (!filename) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'comfy-capacity-test-'));
    directories.push(directory);
    filename = path.join(directory, 'pool.sqlite');
  }
  const db = new Database(filename);
  const store = new ComfyStore(db);
  const configuration: Configuration = {
    autoOpen: true, pollIntervalMs: 1_000, bootTimeoutMs: 30_000, jobTimeoutMs: 60_000,
    capacityPollIntervalMs: 30_000, capacityWaitTimeoutMs: 21_600_000,
    instances: [{ id: '1', baseUrl: 'https://native-1.invalid', areaName: '华东一区', gpuModel: '5090', headers: {}, workflowIds: ['capacity'] }],
    workflows: [{ id: 'capacity', version: '1', graph: {
      '1': { class_type: 'LoadImage', inputs: { image: '' } },
      '2': { class_type: 'Render', inputs: { image: ['1', 0], text: '', filename_prefix: '' } }
    }, bindings: { image: { nodeId: '1', input: 'image', kind: 'media', required: true },
      text: { nodeId: '2', input: 'text', kind: 'value', required: true },
      output: { nodeId: '2', input: 'filename_prefix', kind: 'output-prefix', required: true } }, outputNodeIds: ['2'] }],
    ...overrides
  };
  const clients = Object.fromEntries(configuration.instances.map(instance => [instance.id, {
    health: vi.fn<DataClient['health']>().mockResolvedValue(undefined),
    queue: vi.fn<DataClient['queue']>().mockResolvedValue({ running: [], pending: [] }),
    upload: vi.fn<DataClient['upload']>(),
    submit: vi.fn<DataClient['submit']>().mockImplementation(async ({ promptId }) => ({ promptId })),
    history: vi.fn<DataClient['history']>().mockResolvedValue({ state: 'running', outputs: [] }),
    findAttempt: vi.fn<DataClient['findAttempt']>().mockResolvedValue(undefined),
    download: vi.fn<DataClient['download']>()
  }]));
  const statuses = new Map(configuration.instances.map(instance => [instance.id, '22']));
  const idlePolicyClearer = vi.fn<NonNullable<ComfyServiceOptions['platform']['clearGpuIdleShutdown']>>().mockResolvedValue(undefined);
  const platform = {
    getInstanceStatus: vi.fn<ComfyServiceOptions['platform']['getInstanceStatus']>().mockImplementation(async id => statuses.get(id)!),
    openInstance: vi.fn<ComfyServiceOptions['platform']['openInstance']>().mockImplementation(async id => { statuses.set(id, '2'); }),
    closeInstance: vi.fn<ComfyServiceOptions['platform']['closeInstance']>(),
    ...(enableIdlePolicy ? { clearGpuIdleShutdown: idlePolicyClearer } : {})
  };
  const assets = { get: vi.fn<ComfyServiceOptions['assets']['get']>(), read: vi.fn<ComfyServiceOptions['assets']['read']>() };
  const results = { save: vi.fn<ComfyServiceOptions['results']['save']>(), read: vi.fn<ComfyServiceOptions['results']['read']>() };
  const service = new ComfyService({ store, configuration, platform, assets, results,
    client: instance => clients[instance.id]!, ownsAsset: () => false, owner: 'owner' });
  resources.push({ service, db });
  const input = (key = 'capacity'): ComfyInput => ({ adapterId: 'comfyui-v1', requestKey: key,
    workflowId: 'capacity', transport: 'direct', media: {}, values: { text: key }, directMedia: {
      image: { filename: 'frame.png', contentType: 'image/png', sha256: 'a'.repeat(64) }
    } });
  const submit = (key = 'capacity') => service.submit(input(key)).job;
  return { filename, db, store, configuration, service, clients, client: clients['1']!, platform, statuses, assets, results, input, submit, idlePolicyClearer };
}

beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(startedAt); });
afterEach(async () => {
  for (const { service, db } of resources.splice(0)) { if (db.open) { await service.close(); db.close(); } }
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('comfy-capacity-test-')) throw new Error('Unsafe test cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('capacity scheduling with SQLite and mock clients', () => {
  it.each([
    [['华东一区'], '华东一区 / 5090'],
    [['华东一区', '华东二区'], '华东一区 / 5090、华东二区 / 5090'],
    [['华东一区', '华东一区'], '华东一区 / 5090']
  ] as const)('describes all waiting regions without implying a single assigned instance: %j', (areas, targets) => {
    const instances: Configuration['instances'] = areas.map((areaName, index) => ({
      id: String(index + 1), baseUrl: `https://native-${index + 1}.invalid`, areaName, gpuModel: '5090', workflowIds: ['capacity']
    }));
    const { service, store, submit, platform, clients } = fixture({ instances });
    const job = submit();
    for (const instance of instances) store.updateInstance(instance.id, { state: 'waiting_capacity',
      capacity_started_at: startedAt, next_action_at: startedAt + 30_000 });
    const projected = service.publicJob(service.get(job.id));
    expect(projected).toMatchObject({ stage: 'waiting_capacity', status: 'queued', progress: {
      message: `已登记实例开机暂缺可分配GPU，正在轮询候卡（${targets}）；尚未开始生成`,
      nextRetryAt: new Date(startedAt + 30_000).toISOString(), waitingSince: new Date(startedAt).toISOString()
    } });
    expect(projected.progress).not.toHaveProperty('instance');
    expect(platform.openInstance).not.toHaveBeenCalled();
    for (const client of Object.values(clients)) expect(client.submit).not.toHaveBeenCalled();
  });

  it('shows the starting region instead of stale capacity text from another region', () => {
    const instances: Configuration['instances'] = [
      { id: '1', baseUrl: 'https://native-1.invalid', areaName: '华东一区', gpuModel: '5090', workflowIds: ['capacity'] },
      { id: '2', baseUrl: 'https://native-2.invalid', areaName: '华东二区', gpuModel: '5090', workflowIds: ['capacity'] }
    ];
    const { service, store, submit } = fixture({ instances });
    const job = submit();
    store.updateInstance('1', { state: 'waiting_capacity', capacity_started_at: startedAt, next_action_at: startedAt + 30_000 });
    store.updateInstance('2', { state: 'starting' });
    expect(service.publicJob(service.get(job.id))).toMatchObject({ stage: 'booting', progress: {
      message: '正在启动GPU实例并等待ComfyUI就绪', instance: { id: '2', areaName: '华东二区', gpuModel: '5090' }
    } });
  });

  it('does not describe a cancelled job as waiting for GPU capacity', () => {
    const { service, store, submit } = fixture();
    const job = submit();
    store.updateInstance('1', { state: 'waiting_capacity', capacity_started_at: startedAt, next_action_at: startedAt + 30_000 });
    store.updateJob(job.id, { cancel_requested: 1 });
    const projected = service.publicJob(service.get(job.id));
    expect(projected.stage).toBe('cancelled');
    expect(projected.progress.message).not.toContain('轮询候卡');
    expect(projected.progress.message).toContain('取消');
  });

  it('persists capacity backoff across restart without reserving a job slot or opening early', async () => {
    const first = fixture();
    first.platform.openInstance.mockRejectedValue({ code: 'CAPACITY_UNAVAILABLE' });
    const job = first.submit();
    await first.service.tick();
    expect(first.store.instance('1')).toMatchObject({ state: 'waiting_capacity', job_id: null,
      capacity_started_at: startedAt, next_action_at: startedAt + 30_000, action_started_at: null, action_sent: 0 });
    expect(first.service.publicJob(first.service.get(job.id))).toMatchObject({ status: 'queued', stage: 'waiting_capacity' });
    await first.service.close();
    first.db.close();
    const restarted = fixture({}, first.filename);
    vi.mocked(Date.now).mockReturnValue(startedAt + 29_999);
    await restarted.service.tick();
    expect(restarted.platform.openInstance).not.toHaveBeenCalled();
    expect(restarted.platform.getInstanceStatus).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(startedAt + 30_000);
    restarted.platform.openInstance.mockRejectedValue({ code: 'CAPACITY_UNAVAILABLE' });
    await restarted.service.tick();
    expect(restarted.platform.openInstance).toHaveBeenCalledTimes(1);
    expect(restarted.store.instance('1')).toMatchObject({ state: 'waiting_capacity', job_id: null,
      capacity_started_at: startedAt, next_action_at: startedAt + 60_000 });
    expect(restarted.service.get(job.id).stage).toBe('queued');
    expect(restarted.client.submit).not.toHaveBeenCalled();
  });

  it.each(['5090', '4090'] as const)('tries another region with %s after the preferred region has no capacity', async availableGpu => {
    const instances: Configuration['instances'] = [
      { id: '1', baseUrl: 'https://native-1.invalid', areaName: '华东二区', gpuModel: '4090', workflowIds: ['capacity'] },
      { id: '2', baseUrl: 'https://native-2.invalid', areaName: '华东一区', gpuModel: '5090', workflowIds: ['capacity'] },
      { id: '3', baseUrl: 'https://native-3.invalid', areaName: '华东二区', gpuModel: '5090', workflowIds: ['capacity'] }
    ];
    const { service, platform, statuses, store, submit } = fixture({ instances });
    const availableId = availableGpu === '5090' ? '3' : '1';
    platform.openInstance.mockImplementation(async id => {
      if (id !== availableId) throw { code: 'CAPACITY_UNAVAILABLE' };
      statuses.set(id, '2');
    });
    const job = submit();
    await service.tick();
    expect(platform.openInstance.mock.calls.map(([id]) => id)).toEqual(availableGpu === '5090' ? ['2', '3'] : ['2', '3', '1']);
    expect(store.instance('2')!.state).toBe('waiting_capacity');
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ instance_id: availableId, stage: 'awaiting_upload' });
    expect(store.instance(availableId)!.job_id).toBe(job.id);
    expect(store.instance('2')!.job_id).toBeNull();
  });

  it('prefers a ready 5090 even when a ready 4090 is configured first', async () => {
    const instances: Configuration['instances'] = [
      { id: '1', baseUrl: 'https://native-1.invalid', areaName: '华东一区', gpuModel: '4090', workflowIds: ['capacity'] },
      { id: '2', baseUrl: 'https://native-2.invalid', areaName: '华东二区', gpuModel: '5090', workflowIds: ['capacity'] }
    ];
    const { service, statuses, store, submit, platform } = fixture({ instances });
    statuses.set('1', '2'); statuses.set('2', '2');
    const job = submit();
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ instance_id: '2', stage: 'awaiting_upload' });
    expect(store.instance('1')!.job_id).toBeNull();
    expect(platform.openInstance).not.toHaveBeenCalled();
  });

  it.each(['NETWORK_ERROR', 'TIMEOUT', 'BUSINESS_REJECTED'])('never repeats an uncertain or rejected open (%s)', async code => {
    const { service, platform, store, submit } = fixture();
    platform.openInstance.mockRejectedValue({ code });
    submit();
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'starting', action_sent: 1, error_code: 'COMFY_' + code,
      capacity_started_at: null, next_action_at: startedAt + 30_000 });
    await service.tick();
    vi.mocked(Date.now).mockReturnValue(startedAt + 30_001);
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'offline', error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT',
      action_started_at: null, action_sent: 0, next_action_at: startedAt + 60_001 });
    platform.getInstanceStatus.mockClear();
    await service.tick();
    vi.mocked(Date.now).mockReturnValue(startedAt + 60_000);
    await service.tick();
    expect(platform.getInstanceStatus).not.toHaveBeenCalled();
    expect(platform.openInstance).toHaveBeenCalledTimes(1);
    expect(store.instance('1')).toMatchObject({ state: 'offline', error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT',
      next_action_at: startedAt + 60_001 });
  });

  it('does not spend bootTimeout while waiting for capacity and grants a fresh boot window on success', async () => {
    const { service, platform, store, submit, statuses } = fixture({ capacityPollIntervalMs: 90_000 });
    platform.openInstance.mockRejectedValueOnce({ code: 'CAPACITY_UNAVAILABLE' });
    const job = submit();
    await service.tick();
    vi.mocked(Date.now).mockReturnValue(startedAt + 60_001);
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'waiting_capacity', action_started_at: null });
    expect(service.get(job.id).stage).toBe('queued');
    expect(platform.openInstance).toHaveBeenCalledTimes(1);
    vi.mocked(Date.now).mockReturnValue(startedAt + 90_000);
    platform.openInstance.mockImplementationOnce(async () => { statuses.set('1', '11'); });
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'starting', action_started_at: startedAt + 90_000 });
    vi.mocked(Date.now).mockReturnValue(startedAt + 119_999);
    await service.tick();
    expect(store.instance('1')!.state).toBe('starting');
    statuses.set('1', '2');
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', deadline: startedAt + 179_999 });
    expect(store.instance('1')).toMatchObject({ capacity_started_at: null, next_action_at: null });
  });

  it('extends queue deadlines by configured capacity wait and resets them to jobTimeout after assignment', async () => {
    const { service, submit, platform, statuses } = fixture({ capacityWaitTimeoutMs: 43_200_000 });
    platform.openInstance.mockRejectedValueOnce({ code: 'CAPACITY_UNAVAILABLE' });
    const job = submit();
    expect(job.deadline).toBe(startedAt + 43_200_000);
    await service.tick();
    vi.mocked(Date.now).mockReturnValue(startedAt + 7_200_000);
    statuses.set('1', '2');
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', deadline: startedAt + 7_260_000 });
  });

  it('uses default 30-second backoff and six-hour timeout when optional capacity fields are omitted', async () => {
    const { configuration, service, platform, store, submit } = fixture({ jobTimeoutMs: 43_200_000 });
    delete configuration.capacityPollIntervalMs; delete configuration.capacityWaitTimeoutMs;
    platform.openInstance.mockRejectedValue({ code: 'CAPACITY_UNAVAILABLE' });
    const job = submit();
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'waiting_capacity', next_action_at: startedAt + 30_000 });
    expect(job.stage).toBe('queued');
    vi.mocked(Date.now).mockReturnValue(startedAt + 21_600_000 - 1);
    await service.tick();
    expect(store.instance('1')!.state).toBe('waiting_capacity');
    vi.mocked(Date.now).mockReturnValue(startedAt + 21_600_000);
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'offline', error_code: 'COMFY_CAPACITY_WAIT_TIMEOUT',
      capacity_started_at: null, action_started_at: null, action_sent: 0, next_action_at: startedAt + 21_630_000 });
    expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_QUEUE_TIMEOUT' });
    expect(platform.openInstance).toHaveBeenCalledTimes(2);
    vi.mocked(Date.now).mockReturnValue(startedAt + 21_629_999);
    await service.tick();
    expect(platform.openInstance).toHaveBeenCalledTimes(2);
    const next = submit('after-capacity-timeout');
    platform.getInstanceStatus.mockResolvedValue('2');
    vi.mocked(Date.now).mockReturnValue(startedAt + 21_630_000);
    await service.tick();
    expect(service.get(next.id).stage).toBe('awaiting_upload');
    expect(store.instance('1')).toMatchObject({ state: 'busy', job_id: next.id, next_action_at: null, error_code: null });
    expect(platform.openInstance).toHaveBeenCalledTimes(2);
  });

  it.each(['running', 'pending'] as const)('recovers an upload slot after foreign %s work clears without losing its job', async queueState => {
    const { service, submit, statuses, store, client, platform } = fixture();
    statuses.set('1', '2');
    const job = submit('upload-busy');
    await service.tick();
    expect(service.get(job.id).stage).toBe('awaiting_upload');
    client.queue.mockResolvedValue({ running: [], pending: [], [queueState]: [{ promptId: 'foreign' }] });
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id,
      error_code: 'COMFY_EXTERNAL_OCCUPANCY', next_action_at: startedAt + 30_000 });
    expect(service.get(job.id).stage).toBe('awaiting_upload');
    expect(service.publicJob(service.get(job.id))).toMatchObject({ stage: 'waiting_instance', progress: {
      message: '原GPU实例正在执行其他任务，等待空闲后自动重查，不抢占、不重复提交',
      nextRetryAt: new Date(startedAt + 30_000).toISOString(),
    } });
    const checks = client.queue.mock.calls.length;
    vi.mocked(Date.now).mockReturnValue(startedAt + 29_999);
    await service.tick();
    expect(client.queue).toHaveBeenCalledTimes(checks);
    expect(client.submit).not.toHaveBeenCalled();
    client.queue.mockResolvedValue({ running: [], pending: [] });
    vi.mocked(Date.now).mockReturnValue(startedAt + 30_000);
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'busy', job_id: job.id, next_action_at: null, error_code: null });
    service.completeInputs(job.id, { image: { name: 'frame.png', subfolder: job.id, type: 'input' } });
    await service.tick();
    expect(service.get(job.id).stage).toBe('running');
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('extends the queue deadline to the default six hours when optional capacity settings are absent', () => {
    const { configuration, submit } = fixture();
    delete configuration.capacityPollIntervalMs; delete configuration.capacityWaitTimeoutMs;
    expect(submit().deadline).toBeGreaterThanOrEqual(startedAt + 21_600_000);
  });

  it.each(['INSTANCE_NOT_FOUND', 'NETWORK_ERROR'])('rechecks instance lookup failure %s after backoff without losing queued work', async code => {
    const { service, submit, platform, statuses, store, client } = fixture();
    statuses.set('1', '2');
    platform.getInstanceStatus.mockRejectedValueOnce({ code });
    const job = submit('lookup-backoff');
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: null,
      error_code: 'COMFY_' + code, next_action_at: startedAt + 30_000 });
    expect(service.publicJob(service.get(job.id))).toMatchObject({ status: 'queued', stage: 'waiting_instance', progress: {
      message: 'GPU实例暂未就绪，正在退避后重新检查；保留原任务，不重复生成（COMFY_' + code + '）',
      nextRetryAt: new Date(startedAt + 30_000).toISOString(),
    } });
    vi.mocked(Date.now).mockReturnValue(startedAt + 29_999);
    await service.tick();
    expect(platform.getInstanceStatus).toHaveBeenCalledTimes(1);
    expect(client.submit).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(startedAt + 30_000);
    await service.tick();
    expect(platform.getInstanceStatus).toHaveBeenCalledTimes(2);
    expect(service.get(job.id).stage).toBe('awaiting_upload');
    expect(store.instance('1')).toMatchObject({ state: 'busy', job_id: job.id, error_code: null, next_action_at: null });
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('loads persistent capacity defaults from a real configuration file', async () => {
    const { configuration, filename } = fixture();
    const directory = path.dirname(filename);
    writeFileSync(path.join(directory, 'graph.json'), JSON.stringify(configuration.workflows[0]!.graph));
    const configFile = path.join(directory, 'pool.json');
    writeFileSync(configFile, JSON.stringify({ instances: configuration.instances.map(({ headers: _headers, ...instance }) => instance),
      workflows: configuration.workflows.map(({ graph: _graph, ...profile }) => ({ ...profile, file: 'graph.json' })) }));
    const loaded = await loadComfyConfiguration(configFile, {});
    expect(loaded).toMatchObject({ capacityPollIntervalMs: 30_000, capacityWaitTimeoutMs: 21_600_000, capacityErrorCodes: [] });
  });

  it('reopens a SQL-ready instance externally powered off before a new job arrives', async () => {
    const { service, submit, platform, statuses, store } = fixture();
    store.updateInstance('1', { state: 'ready' });
    const job = submit();
    await service.tick();
    expect(platform.openInstance).toHaveBeenCalledExactlyOnceWith('1');
    expect(store.instance('1')).toMatchObject({ state: 'starting', job_id: null });
    statuses.set('1', '2');
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', instance_id: '1' });
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('wakes an externally stopped instance solely to collect its original pending direct result', async () => {
    const { service, submit, platform, statuses, store, client, assets, results, db } = fixture();
    statuses.set('1', '2');
    const job = submit();
    await service.tick();
    service.completeInputs(job.id, { image: { name: 'frame.png', subfolder: job.id, type: 'input' } });
    await service.tick();
    client.history.mockResolvedValue({ state: 'succeeded', outputs: [
      { filename: 'original.mp4', subfolder: job.id, type: 'output', nodeId: '2' }
    ] });
    await service.tick();
    const resultBeforeShutdown = service.get(job.id).result;
    expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 1 });
    expect(store.instance('1')!.job_id).toBeNull();
    expect(() => service.control('1', 'close')).toThrow(expect.objectContaining({ statusCode: 409 }));
    statuses.set('1', '22');
    for (const elapsed of [1_800_001, 3_600_001, 5_400_001]) {
      vi.mocked(Date.now).mockReturnValue(startedAt + elapsed);
      await service.tick();
      expect(platform.openInstance).not.toHaveBeenCalled();
      expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 1, result_wake_requested: 0, result: resultBeforeShutdown });
      expect(store.instance('1')).toMatchObject({ state: 'ready', job_id: null });
    }
    client.health.mockRejectedValueOnce(new Error('Instance is powered off'))
      .mockRejectedValueOnce(new Error('Instance is powered off'));
    expect(await service.requestResultAvailability(job.id)).toMatchObject({ stage: 'succeeded', result_wake_requested: 1 });
    expect(service.publicJob(service.get(job.id))).toMatchObject({ status: 'running', stage: 'preparing_result' });
    await service.tick();
    expect(platform.openInstance).toHaveBeenCalledExactlyOnceWith('1');
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 1, result_wake_requested: 0, result: resultBeforeShutdown });
    expect(store.instance('1')).toMatchObject({ state: 'ready', job_id: null });
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM comfy_jobs').get()).toEqual({ count: 1 });
    service.acknowledgeCollected(job.id);
    expect(service.get(job.id).result_pending).toBe(0);
    for (const operation of [platform.closeInstance, assets.read, client.upload, client.download, results.save]) expect(operation).not.toHaveBeenCalled();
  });

  it.each(['already-ready', 'newly-opened'])(
    'clears GPU idle shutdown once before allocating or generating on an %s instance', async lifecycle => {
      const { service, submit, platform, statuses, store, idlePolicyClearer, client } = fixture({}, undefined, true);
      if (lifecycle === 'already-ready') {
        statuses.set('1', '2');
        store.updateInstance('1', { state: 'ready' });
      }
      const job = submit();
      await service.tick();
      if (lifecycle === 'newly-opened') {
        expect(platform.openInstance).toHaveBeenCalledExactlyOnceWith('1');
        expect(idlePolicyClearer).not.toHaveBeenCalled();
        expect(service.get(job.id).stage).toBe('queued');
        await service.tick();
      }
      expect(idlePolicyClearer).toHaveBeenCalledExactlyOnceWith('1');
      expect(store.instance('1')).toMatchObject({ state: 'busy', idle_policy_applied_at: null });
      expect(service.get(job.id).stage).toBe('awaiting_upload');
      await service.tick();
      await service.tick();
      expect(idlePolicyClearer).toHaveBeenCalledTimes(1);
      service.completeInputs(job.id, { image: { name: 'frame.png', subfolder: job.id, type: 'input' } });
      await service.tick();
      await service.tick();
      expect(client.submit).toHaveBeenCalledTimes(1);
      expect(idlePolicyClearer.mock.invocationCallOrder[0]!).toBeLessThan(client.submit.mock.invocationCallOrder[0]!);
      expect(idlePolicyClearer).toHaveBeenCalledTimes(1);
      expect(platform.closeInstance).not.toHaveBeenCalled();
    }
  );

  it('clears GPU idle shutdown on an explicitly opened instance without inventing a generation job', async () => {
    const { service, store, platform, idlePolicyClearer, client, db } = fixture({}, undefined, true);
    service.control('1', 'open');
    await service.tick();
    expect(platform.openInstance).toHaveBeenCalledExactlyOnceWith('1');
    expect(idlePolicyClearer).not.toHaveBeenCalled();
    await service.tick();
    await service.tick();
    expect(idlePolicyClearer).toHaveBeenCalledExactlyOnceWith('1');
    expect(store.instance('1')).toMatchObject({ state: 'ready', idle_policy_applied_at: null, job_id: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM comfy_jobs').get()).toEqual({ count: 0 });
    expect(client.submit).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('clears GPU idle shutdown again after external shutdown and reopening, but not during continued polling', async () => {
    const { service, submit, statuses, store, platform, idlePolicyClearer } = fixture({}, undefined, true);
    statuses.set('1', '2');
    const first = submit('before-idle-shutdown');
    await service.tick();
    expect(idlePolicyClearer).toHaveBeenCalledTimes(1);
    service.cancel(first.id);
    await service.tick();
    expect(store.instance('1')!.job_id).toBeNull();
    statuses.set('1', '22');
    vi.mocked(Date.now).mockReturnValue(startedAt + 1_800_001);
    await service.tick();
    expect(platform.openInstance).not.toHaveBeenCalled();
    const second = submit('after-idle-shutdown');
    await service.tick();
    expect(platform.openInstance).toHaveBeenCalledExactlyOnceWith('1');
    expect(store.instance('1')).toMatchObject({ state: 'starting', idle_policy_applied_at: null });
    expect(idlePolicyClearer).toHaveBeenCalledTimes(1);
    await service.tick();
    expect(idlePolicyClearer).toHaveBeenCalledTimes(2);
    expect(store.instance('1')!.idle_policy_applied_at).toBeNull();
    expect(service.get(second.id).stage).toBe('awaiting_upload');
    await service.tick();
    await service.tick();
    expect(idlePolicyClearer).toHaveBeenCalledTimes(2);
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('clears GPU idle shutdown again after service and SQLite connection restarts', async () => {
    const first = fixture({}, undefined, true);
    first.statuses.set('1', '2');
    const job = first.submit('before-restart');
    await first.service.tick();
    expect(first.idlePolicyClearer).toHaveBeenCalledTimes(1);
    first.store.updateInstance('1', { idle_policy_applied_at: startedAt });
    first.service.cancel(job.id);
    await first.service.tick();
    await first.service.close();
    first.db.close();
    const restarted = fixture({}, first.filename, true);
    restarted.statuses.set('1', '2');
    const next = restarted.submit('after-restart');
    await restarted.service.tick();
    expect(restarted.service.get(next.id).stage).toBe('awaiting_upload');
    expect(restarted.store.instance('1')!.idle_policy_applied_at).toBe(startedAt);
    expect(restarted.idlePolicyClearer).toHaveBeenCalledExactlyOnceWith('1');
    expect(restarted.platform.openInstance).not.toHaveBeenCalled();
    expect(restarted.platform.closeInstance).not.toHaveBeenCalled();
  });

  it.each(['already-ready', 'newly-opened'])(
    'continues allocation and generation when GPU idle cancellation fails on an %s instance', async lifecycle => {
      const { service, submit, platform, statuses, store, idlePolicyClearer, client, assets, results } = fixture({}, undefined, true);
      if (lifecycle === 'already-ready') {
        statuses.set('1', '2');
        store.updateInstance('1', { state: 'ready' });
      }
      idlePolicyClearer.mockRejectedValue({ code: 'NETWORK_ERROR' });
      const job = submit();
      await service.tick();
      await service.tick();
      await service.tick();
      expect(idlePolicyClearer).toHaveBeenCalledTimes(1);
      expect(store.instance('1')).toMatchObject({ job_id: job.id, idle_policy_applied_at: null, error_code: null });
      expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', instance_id: '1' });
      expect(store.events.list({ instanceId: '1' }).some(event => event.code === 'COMFY_GPU_IDLE_CLEAR_FAILED')).toBe(true);
      for (const operation of [client.submit, client.upload, client.download, assets.read, results.save, platform.closeInstance]) expect(operation).not.toHaveBeenCalled();
      expect(platform.openInstance).toHaveBeenCalledTimes(lifecycle === 'already-ready' ? 0 : 1);
      idlePolicyClearer.mockResolvedValue(undefined);
      vi.mocked(Date.now).mockReturnValue(startedAt + 30_000);
      await service.tick();
      expect(service.get(job.id).stage).toBe('awaiting_upload');
      expect(store.instance('1')).toMatchObject({ idle_policy_applied_at: null, error_code: null });
      expect(idlePolicyClearer).toHaveBeenCalledTimes(2);
      service.completeInputs(job.id, { image: { name: 'frame.png', subfolder: job.id, type: 'input' } });
      await service.tick();
      expect(client.submit).toHaveBeenCalledTimes(1);
      expect(platform.closeInstance).not.toHaveBeenCalled();
    }
  );

  it('keeps GPU idle cancellation optional for legacy mock platforms', async () => {
    const { service, submit, statuses, platform, idlePolicyClearer } = fixture();
    expect(platform.clearGpuIdleShutdown).toBeUndefined();
    statuses.set('1', '2');
    const job = submit();
    await service.tick();
    expect(service.get(job.id).stage).toBe('awaiting_upload');
    expect(idlePolicyClearer).not.toHaveBeenCalled();
  });

  it('never implements programmatic idle-close after the external idle-shutdown interval', async () => {
    const { service, store, platform } = fixture();
    store.updateInstance('1', { state: 'ready' });
    vi.mocked(Date.now).mockReturnValue(startedAt + 1_800_001);
    await service.tick();
    expect(platform.closeInstance).not.toHaveBeenCalled();
    expect(store.instance('1')!.state).not.toBe('closing');
  });
});
