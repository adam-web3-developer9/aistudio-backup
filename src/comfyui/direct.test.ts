import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComfyError } from './comfy-client.js';
import { comfyJobSchema } from './routes.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore, type ComfyInput } from './store.js';

type DataClient = ReturnType<ComfyServiceOptions['client']>;
const resources: Array<{ service: ComfyService; db: Database.Database }> = [];
const directories: string[] = [];

function fixture(filename?: string, authenticated = false) {
  if (!filename) {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'comfy-direct-test-'));
    directories.push(directory);
    filename = path.join(directory, 'pool.sqlite');
  }
  const db = new Database(filename);
  const store = new ComfyStore(db);
  const client = {
    health: vi.fn<DataClient['health']>().mockResolvedValue(undefined),
    queue: vi.fn<DataClient['queue']>().mockResolvedValue({ running: [], pending: [] }),
    upload: vi.fn<DataClient['upload']>(),
    submit: vi.fn<DataClient['submit']>().mockImplementation(async ({ promptId }) => ({ promptId })),
    history: vi.fn<DataClient['history']>().mockResolvedValue({ state: 'running', outputs: [] }),
    findAttempt: vi.fn<DataClient['findAttempt']>().mockResolvedValue(undefined),
    download: vi.fn<DataClient['download']>()
  };
  const platform = {
    getInstanceStatus: vi.fn<ComfyServiceOptions['platform']['getInstanceStatus']>().mockResolvedValue('2'),
    openInstance: vi.fn<ComfyServiceOptions['platform']['openInstance']>(),
    closeInstance: vi.fn<ComfyServiceOptions['platform']['closeInstance']>().mockResolvedValue(undefined)
  };
  const assets = { get: vi.fn<ComfyServiceOptions['assets']['get']>(), read: vi.fn<ComfyServiceOptions['assets']['read']>() };
  const results = { save: vi.fn<ComfyServiceOptions['results']['save']>(), read: vi.fn<ComfyServiceOptions['results']['read']>() };
  const configuration: ComfyServiceOptions['configuration'] = {
    autoOpen: false, pollIntervalMs: 1_000, bootTimeoutMs: 30_000, jobTimeoutMs: 60_000,
    instances: [{ id: '1', baseUrl: 'https://native.invalid/api', workflowIds: ['direct'],
      headers: authenticated ? { Authorization: 'Bearer fixture-only' } : {} }],
    workflows: [{ id: 'direct', version: '1', graph: {
      '1': { class_type: 'LoadImage', inputs: { image: '' } },
      '2': { class_type: 'LoadAudio', inputs: { audio: '' } },
      '3': { class_type: 'Render', inputs: { image: ['1', 0], audio: ['2', 0], text: '', filename_prefix: '' } }
    }, bindings: {
      image: { nodeId: '1', input: 'image', kind: 'media', required: true },
      audio: { nodeId: '2', input: 'audio', kind: 'media', required: true },
      text: { nodeId: '3', input: 'text', kind: 'value', required: true },
      output: { nodeId: '3', input: 'filename_prefix', kind: 'output-prefix', required: true }
    }, outputNodeIds: ['3'] }]
  };
  const clientFactory = vi.fn<ComfyServiceOptions['client']>().mockReturnValue(client);
  const service = new ComfyService({ store, configuration, platform, client: clientFactory,
    assets, results, ownsAsset: vi.fn().mockReturnValue(false), owner: 'owner' });
  resources.push({ service, db });
  const input = (key = 'direct'): ComfyInput => ({ adapterId: 'comfyui-v1', requestKey: key,
    workflowId: 'direct', transport: 'direct', values: { text: key }, media: {}, directMedia: {
      image: { filename: 'image.png', contentType: 'image/png', sha256: 'a'.repeat(64) },
      audio: { filename: 'audio.wav', contentType: 'audio/wav', sha256: 'b'.repeat(64) }
    } });
  const submit = (key = 'direct') => service.submit(input(key)).job;
  const receipt = (id: string) => ({ image: { name: 'image.png', subfolder: id, type: 'input' as const },
    audio: { name: 'audio.wav', subfolder: id, type: 'input' as const } });
  const succeed = () => client.history.mockResolvedValue({ state: 'succeeded', outputs: [
    { nodeId: '3', filename: 'clip final.mp4', subfolder: 'render output', type: 'output' }
  ] });
  return { filename, db, store, service, client, clientFactory, platform, configuration, assets, results, input, submit, receipt, succeed };
}

afterEach(async () => {
  for (const { service, db } of resources.splice(0)) { if (db.open) { await service.close(); db.close(); } }
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('comfy-direct-test-')) throw new Error('Unsafe test cleanup');
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('direct transfer with SQLite and mock clients', () => {
  it('persists ComfyError.details.upstreamCode in the failed job event', async () => {
    const { service, submit, receipt, client, db } = fixture();
    const job = submit();
    await service.tick();
    service.completeInputs(job.id, receipt(job.id));
    client.submit.mockRejectedValueOnce(new ComfyError('PROMPT_REJECTED', 'Fixture rejection', false,
      { upstreamCode: 'TEST_UPSTREAM_REJECTED' }));
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_PROMPT_REJECTED' });
    const event = db.prepare('SELECT details FROM comfy_events WHERE job_id=? AND code=? ORDER BY sequence DESC LIMIT 1')
      .get(job.id, 'COMFY_PROMPT_REJECTED') as { details: string } | undefined;
    expect(event).toBeDefined();
    expect(JSON.parse(event!.details)).toMatchObject({ upstreamCode: 'TEST_UPSTREAM_REJECTED' });
  });

  it('reserves an upload manifest, submits the exact graph once, and never relays media', async () => {
    const context = fixture();
    const { service, store, client, input, submit, receipt, assets, results } = context;
    const job = submit();
    expect(job).toMatchObject({ stage: 'queued', instance_id: null });
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', instance_id: '1' });
    expect(service.publicJob(service.get(job.id))).toMatchObject({ upload: {
      baseUrl: 'https://native.invalid/api', subfolder: job.id,
      files: Object.entries(input().directMedia!).map(([binding, media]) => ({ binding, ...media }))
    } });
    expect(client.submit).not.toHaveBeenCalled();
    service.completeInputs(job.id, receipt(job.id));
    await service.tick();
    await service.tick();
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(client.submit).toHaveBeenCalledWith({ promptId: job.prompt_id, attemptId: job.id, graph: {
      '1': { class_type: 'LoadImage', inputs: { image: job.id + '/image.png' } },
      '2': { class_type: 'LoadAudio', inputs: { audio: job.id + '/audio.wav' } },
      '3': { class_type: 'Render', inputs: { image: ['1', 0], audio: ['2', 0], text: 'direct', filename_prefix: job.id } }
    } });
    context.succeed();
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 1 });
    const videoUrl = service.publicJob(service.get(job.id)).result!.videoUrl;
    const native = new URL(videoUrl);
    expect(native.origin + native.pathname).toBe('https://native.invalid/api/view');
    expect(Object.fromEntries(native.searchParams)).toEqual({ filename: 'clip final.mp4', subfolder: 'render output', type: 'output' });
    expect(store.pendingResults('1').map(result => result.id)).toEqual([job.id]);
    expect(() => service.control('1', 'close')).toThrow(expect.objectContaining({ statusCode: 409 }));
    service.acknowledgeCollected(job.id);
    expect(service.get(job.id).result_pending).toBe(0);
    expect(store.pendingResults('1')).toEqual([]);
    service.control('1', 'close');
    await service.tick();
    expect(context.platform.closeInstance).toHaveBeenCalledWith('1');
    for (const operation of [assets.get, assets.read, client.upload, client.download, results.save, results.read]) expect(operation).not.toHaveBeenCalled();
  });

  it.each([true, false])('checks an existing result independently of external occupancy when health succeeds=%s', async healthy => {
    const { service, store, client, platform, assets, results, submit, receipt, succeed } = fixture();
    const job = submit();
    await service.tick();
    service.completeInputs(job.id, receipt(job.id));
    await service.tick();
    succeed();
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 1 });
    const result = service.get(job.id).result;
    const videoUrl = service.publicJob(service.get(job.id)).result!.videoUrl;
    expect(store.instance('1')!.job_id).toBeNull();
    const reserved = healthy ? undefined : submit('next');
    if (reserved) await service.tick();
    const promptId = reserved ? service.get(reserved.id).prompt_id : null;
    const checkedAt = Date.now() - 3_600_000;
    store.updateJob(job.id, { result_checked_at: checkedAt });
    store.updateInstance('1', { state: 'offline', error_code: 'EXTERNAL_OCCUPANCY', next_action_at: Date.now() + 30_000 });
    client.queue.mockResolvedValue({ running: [{ promptId: 'foreign-prompt' }], pending: [] });
    client.health.mockClear();
    if (!healthy) client.health.mockRejectedValue(new ComfyError('NETWORK_ERROR', 'Fixture health unavailable', true));
    const claim = vi.spyOn(store, 'claim');
    const available = await service.requestResultAvailability(job.id);
    expect(available).toMatchObject({
      stage: 'succeeded', result_pending: 1, result_wake_requested: healthy ? 0 : 1, result
    });
    expect(client.health).toHaveBeenCalledTimes(1);
    expect(service.publicJob(available)).toMatchObject(healthy ? {
      status: 'succeeded', stage: 'succeeded', result: { videoUrl }
    } : { status: 'running', stage: 'preparing_result' });
    await service.tick();
    expect(client.health).toHaveBeenCalledTimes(healthy ? 1 : 2);
    expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 1,
      result_wake_requested: healthy ? 0 : 1, result });
    if (healthy) {
      expect(service.publicJob(service.get(job.id))).toMatchObject({
        status: 'succeeded', stage: 'succeeded', result: { videoUrl }
      });
      expect(service.get(job.id).result_checked_at).toBeGreaterThan(checkedAt);
    } else {
      expect(service.publicJob(service.get(job.id))).toMatchObject({ status: 'running', stage: 'preparing_result' });
      expect(service.get(job.id).result_checked_at).toBe(checkedAt);
      expect(store.instance('1')!.job_id).toBe(reserved!.id);
      expect(service.get(reserved!.id)).toMatchObject({ stage: 'awaiting_upload', prompt_id: promptId, direct_inputs: null });
    }
    expect(store.instance('1')!.state).toBe('offline');
    expect(claim).not.toHaveBeenCalled();
    expect(client.submit).toHaveBeenCalledTimes(1);
    for (const operation of [assets.get, assets.read, client.upload, client.download, results.save, results.read,
      platform.openInstance, platform.closeInstance]) expect(operation).not.toHaveBeenCalled();
  });

  it('returns the existing healthy result without opening when cloud status is stale and stopped', async () => {
    const { service, store, client, platform, configuration, assets, results, submit, receipt, succeed } = fixture();
    const job = submit();
    await service.tick();
    service.completeInputs(job.id, receipt(job.id));
    await service.tick();
    succeed();
    await service.tick();
    const result = service.get(job.id).result;
    const videoUrl = service.publicJob(service.get(job.id)).result!.videoUrl;
    expect(store.instance('1')!.job_id).toBeNull();
    configuration.autoOpen = true;
    platform.getInstanceStatus.mockClear().mockResolvedValue('22');
    client.health.mockClear();
    store.updateInstance('1', { state: 'offline', next_action_at: null });
    store.updateJob(job.id, { result_checked_at: Date.now() - 3_600_000 });
    const available = await service.requestResultAvailability(job.id);
    expect(available).toMatchObject({ result_wake_requested: 0 });
    expect(service.publicJob(available)).toMatchObject({ status: 'succeeded', stage: 'succeeded', result: { videoUrl } });
    await service.tick();
    expect(client.health).toHaveBeenCalledTimes(1);
    expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 1, result_wake_requested: 0, result });
    expect(service.publicJob(service.get(job.id))).toMatchObject({
      status: 'succeeded', stage: 'succeeded', result: { videoUrl }
    });
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: null });
    await service.tick();
    expect(client.health).toHaveBeenCalledTimes(1);
    expect(client.submit).toHaveBeenCalledTimes(1);
    for (const operation of [assets.get, assets.read, client.upload, client.download, results.save, results.read,
      platform.openInstance, platform.closeInstance]) expect(operation).not.toHaveBeenCalled();
  });

  it('returns the original result immediately on every sixty-second availability poll without a worker tick', async () => {
    const { service, store, client, platform, configuration, assets, results, submit, receipt, succeed } = fixture();
    const startedAt = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const job = submit();
    await service.tick();
    service.completeInputs(job.id, receipt(job.id));
    await service.tick();
    succeed();
    await service.tick();
    const result = service.get(job.id).result;
    const videoUrl = service.publicJob(service.get(job.id)).result!.videoUrl;
    configuration.autoOpen = true;
    store.updateInstance('1', { state: 'offline', next_action_at: null });
    client.health.mockClear();
    client.queue.mockClear().mockResolvedValue({ running: [{ promptId: 'foreign-prompt' }], pending: [] });
    platform.getInstanceStatus.mockClear().mockResolvedValue('22');
    for (const poll of [1, 2, 3]) {
      const now = startedAt + poll * 60_000;
      vi.mocked(Date.now).mockReturnValue(now);
      const available = await service.requestResultAvailability(job.id);
      expect(available).toMatchObject({ stage: 'succeeded', result_pending: 1, result_wake_requested: 0,
        result_checked_at: now, result });
      expect(service.publicJob(available)).toMatchObject({ status: 'succeeded', stage: 'succeeded', result: { videoUrl } });
      expect(client.health).toHaveBeenCalledTimes(poll);
    }
    store.updateJob(job.id, { result_wake_requested: 1 });
    const available = await service.requestResultAvailability(job.id);
    expect(available).toMatchObject({ result_wake_requested: 0, result });
    expect(service.publicJob(available)).toMatchObject({ status: 'succeeded', stage: 'succeeded', result: { videoUrl } });
    expect(client.health).toHaveBeenCalledTimes(4);
    expect(client.queue).not.toHaveBeenCalled();
    expect(platform.getInstanceStatus).not.toHaveBeenCalled();
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: null });
    expect(client.submit).toHaveBeenCalledTimes(1);
    for (const operation of [assets.get, assets.read, client.upload, client.download, results.save, results.read,
      platform.openInstance, platform.closeInstance]) expect(operation).not.toHaveBeenCalled();
  });

  it('waits for an externally busy queue and rechecks after offline backoff without submitting', async () => {
    const { service, store, client, platform, submit } = fixture();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    client.queue.mockResolvedValue({ running: [{ promptId: 'foreign-prompt' }], pending: [] });
    const job = submit();
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: null });
    const retryAt = store.instance('1')!.next_action_at!;
    expect(retryAt).toBeGreaterThan(now);
    expect(service.get(job.id)).toMatchObject({ stage: 'queued', instance_id: null, prompt_id: job.prompt_id });
    expect(service.publicJob(service.get(job.id))).toMatchObject({ stage: 'waiting_instance', progress: {
      phase: 'waiting_instance', nextRetryAt: new Date(retryAt).toISOString(),
      message: '原GPU实例正在执行其他任务，等待空闲后自动重查，不抢占、不重复提交'
    } });
    client.queue.mockClear();
    await service.tick();
    expect(client.queue).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(retryAt);
    client.queue.mockResolvedValue({ running: [], pending: [] });
    await service.tick();
    expect(client.queue).toHaveBeenCalledTimes(1);
    expect(store.instance('1')).toMatchObject({ state: 'busy', job_id: job.id });
    expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', instance_id: '1', prompt_id: job.prompt_id });
    expect(client.submit).not.toHaveBeenCalled();
    expect(client.upload).not.toHaveBeenCalled();
    expect(client.download).not.toHaveBeenCalled();
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('rejects direct mode when every compatible instance requires native authentication', () => {
    const { submit, platform, client } = fixture(undefined, true);
    expect(submit).toThrow(expect.objectContaining({ code: 'COMFY_DIRECT_UNAVAILABLE' }));
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('excludes authenticated instances even when they are first and ready', async () => {
    const { service, configuration, store, clientFactory, submit } = fixture(undefined, true);
    configuration.instances.push({ id: '2', baseUrl: 'https://public-native.invalid', workflowIds: ['direct'], headers: {} });
    store.registerInstances(['2']);
    const job = submit();
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ instance_id: '2', stage: 'awaiting_upload' });
    expect(service.publicJob(service.get(job.id)).upload!.baseUrl).toBe('https://public-native.invalid');
    expect(clientFactory).toHaveBeenCalled();
  });

  it.each(['../image.png', '/image.png', 'dir/image.png', 'dir\\image.png', 'C:image.png'])(
    'rejects path-escaping manifest filename %s at the public schema boundary', filename => {
      const { input } = fixture();
      const request = input();
      request.directMedia!.image!.filename = filename;
      expect(comfyJobSchema.safeParse(request).success).toBe(false);
    }
  );

  it.each(['missing', 'extra', 'parent', 'absolute', 'filename', 'type'])(
    'rejects incomplete or escaping upload receipts (%s) without consuming the reservation', async mutation => {
      const { service, submit, receipt, client, store } = fixture();
      const job = submit();
      await service.tick();
      const inputs: Record<string, { name: string; subfolder: string; type: string }> = receipt(job.id);
      if (mutation === 'missing') delete inputs.audio;
      if (mutation === 'extra') inputs.extra = { ...inputs.image! };
      if (mutation === 'parent') inputs.image!.subfolder = job.id + '/../other';
      if (mutation === 'absolute') inputs.image!.subfolder = '/' + job.id;
      if (mutation === 'filename') inputs.image!.name = '../image.png';
      if (mutation === 'type') inputs.image!.type = 'output';
      expect(() => service.completeInputs(job.id, inputs as ReturnType<typeof receipt>)).toThrow(expect.objectContaining({ code: 'COMFY_UPLOAD_INVALID' }));
      expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', direct_inputs: null });
      expect(store.instance('1')!.job_id).toBe(job.id);
      expect(client.submit).not.toHaveBeenCalled();
    }
  );

  it('requires all declared media bindings and rejects an unregistered binding', () => {
    const { input, service, db } = fixture();
    const missing = input('missing');
    delete missing.directMedia!.audio;
    expect(() => service.submit(missing)).toThrow(expect.objectContaining({ code: 'COMFY_MEDIA_REQUIRED' }));
    const extra = input('extra');
    extra.directMedia!.unknown = extra.directMedia!.image!;
    expect(() => service.submit(extra)).toThrow(expect.objectContaining({ code: 'COMFY_BINDING_INVALID' }));
    expect(db.prepare('SELECT COUNT(*) AS count FROM comfy_jobs').get()).toEqual({ count: 0 });
  });

  it('rejects upload completion before allocation and conflicting request-key reuse without adding another job', () => {
    const { service, submit, receipt, input, db } = fixture();
    const job = submit();
    expect(() => service.completeInputs(job.id, receipt(job.id))).toThrow(expect.objectContaining({ code: 'COMFY_UPLOAD_UNAVAILABLE' }));
    const altered = input();
    altered.directMedia!.image!.sha256 = 'c'.repeat(64);
    expect(() => service.submit(altered)).toThrow(expect.objectContaining({ code: 'COMFY_REQUEST_CONFLICT' }));
    expect(service.get(job.id)).toMatchObject({ stage: 'queued', direct_inputs: null, instance_id: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM comfy_jobs').get()).toEqual({ count: 1 });
  });

  it.each(['cancel', 'expire'])('releases an awaiting-upload slot after %s and rejects late receipts', async action => {
    const { service, submit, store, receipt, client } = fixture();
    const job = submit();
    await service.tick();
    if (action === 'cancel') service.cancel(job.id);
    else store.updateJob(job.id, { deadline: Date.now() - 1 });
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: action === 'cancel' ? 'cancelled' : 'failed',
      error_code: action === 'cancel' ? 'COMFY_CANCELLED' : 'COMFY_UPLOAD_TIMEOUT' });
    expect(store.instance('1')!.job_id).toBeNull();
    expect(() => service.completeInputs(job.id, receipt(job.id))).toThrow(expect.objectContaining({ code: 'COMFY_UPLOAD_UNAVAILABLE' }));
    expect(client.submit).not.toHaveBeenCalled();
  });

  it('restores the original reservation and idempotent receipts across a disk-backed restart', async () => {
    const first = fixture();
    const job = first.submit();
    await first.service.tick();
    first.service.completeInputs(job.id, first.receipt(job.id));
    await first.service.close();
    first.db.close();
    const restarted = fixture(first.filename);
    expect(restarted.service.submit(restarted.input())).toMatchObject({ created: false, job: { id: job.id, stage: 'preparing' } });
    const acknowledgement = restarted.receipt(job.id);
    restarted.service.completeInputs(job.id, { audio: acknowledgement.audio, image: acknowledgement.image });
    await restarted.service.tick();
    restarted.service.completeInputs(job.id, acknowledgement);
    await restarted.service.tick();
    expect(restarted.client.submit).toHaveBeenCalledTimes(1);
    expect(restarted.client.submit.mock.calls[0]![0]).toMatchObject({ attemptId: job.id, promptId: job.prompt_id });
    expect(restarted.db.prepare('SELECT COUNT(*) AS count FROM comfy_jobs').get()).toEqual({ count: 1 });
  });

  it('recovers a lost submit acknowledgement by original attempt without resubmitting', async () => {
    const first = fixture();
    const job = first.submit();
    await first.service.tick();
    first.service.completeInputs(job.id, first.receipt(job.id));
    first.client.submit.mockRejectedValueOnce(new ComfyError('SUBMISSION_UNKNOWN', 'Fixture acknowledgement lost', true));
    await first.service.tick();
    expect(first.service.get(job.id).stage).toBe('submitting');
    await first.service.close();
    first.db.close();
    const restarted = fixture(first.filename);
    restarted.client.history.mockResolvedValueOnce({ state: 'missing', outputs: [] });
    restarted.client.findAttempt.mockResolvedValueOnce({ promptId: 'recovered-prompt' });
    restarted.succeed();
    await restarted.service.tick();
    expect(restarted.client.findAttempt).toHaveBeenCalledWith(job.id);
    expect(restarted.client.history).toHaveBeenCalledWith('recovered-prompt');
    expect(restarted.client.submit).not.toHaveBeenCalled();
    expect(restarted.service.get(job.id)).toMatchObject({ stage: 'succeeded', prompt_id: 'recovered-prompt', result_pending: 1 });
  });

  it('treats upload receipt replays as identical regardless of JSON property order', async () => {
    const { service, submit, receipt, client } = fixture();
    const job = submit();
    await service.tick();
    service.completeInputs(job.id, receipt(job.id));
    expect(() => service.completeInputs(job.id, {
      audio: { type: 'input', subfolder: job.id, name: 'audio.wav' },
      image: { subfolder: job.id, type: 'input', name: 'image.png' }
    })).not.toThrow();
    await service.tick();
    expect(client.submit).toHaveBeenCalledTimes(1);
  });

  it('replays collection receipts without releasing a newer job slot, including after restart', async () => {
    const first = fixture();
    const job = first.submit();
    await first.service.tick();
    first.service.completeInputs(job.id, first.receipt(job.id));
    await first.service.tick();
    first.succeed();
    await first.service.tick();
    first.service.acknowledgeCollected(job.id);
    const next = first.submit('next');
    await first.service.tick();
    first.service.acknowledgeCollected(job.id);
    expect(first.store.instance('1')!.job_id).toBe(next.id);
    await first.service.close();
    first.db.close();
    const restarted = fixture(first.filename);
    expect(restarted.service.acknowledgeCollected(job.id).result_pending).toBe(0);
    expect(restarted.store.instance('1')!.job_id).toBe(next.id);
    expect(() => restarted.service.control('1', 'close')).toThrow(expect.objectContaining({ statusCode: 409 }));
    expect(() => restarted.service.acknowledgeCollected(next.id)).toThrow(expect.objectContaining({ code: 'COMFY_RESULT_UNAVAILABLE' }));
  });

  it('does not wake an instance for an already collected result even when availability is explicitly requested later', async () => {
    const { service, submit, receipt, succeed, client, store, platform } = fixture();
    const job = submit();
    await service.tick();
    service.completeInputs(job.id, receipt(job.id));
    await service.tick();
    succeed();
    await service.tick();
    const result = service.get(job.id).result;
    service.acknowledgeCollected(job.id);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000);
    platform.getInstanceStatus.mockResolvedValue('22');
    client.health.mockClear();
    expect(await service.requestResultAvailability(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 0, result_wake_requested: 0, result });
    await service.tick();
    expect(service.publicJob(service.get(job.id))).toMatchObject({ status: 'succeeded', stage: 'succeeded' });
    expect(store.instance('1')!.job_id).toBeNull();
    expect(client.health).not.toHaveBeenCalled();
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });
});

describe('direct upload reservation recovery after external GPU shutdown', () => {
  async function reservedUpload(jobTimeoutMs = 60_000) {
    const startedAt = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    const context = fixture();
    context.configuration.jobTimeoutMs = jobTimeoutMs;
    const job = context.submit();
    await context.service.tick();
    expect(context.service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', instance_id: '1' });
    context.store.updateInstance('1', { idle_policy_applied_at: startedAt });
    context.platform.getInstanceStatus.mockClear().mockResolvedValue('22');
    context.platform.openInstance.mockResolvedValue(undefined);
    context.client.health.mockClear();
    return { ...context, job, startedAt };
  }

  it('opens the occupied original instance only once while stopped or booting and preserves the upload reservation', async () => {
    const { service, store, platform, client, job, startedAt } = await reservedUpload();
    await service.tick();
    expect(platform.openInstance).toHaveBeenCalledExactlyOnceWith('1');
    expect(store.instance('1')).toMatchObject({ state: 'starting', job_id: job.id,
      action_started_at: startedAt, action_sent: 1, idle_policy_applied_at: null });
    expect(service.publicJob(service.get(job.id))).toMatchObject({ stage: 'booting', progress: { phase: 'booting' } });
    expect(service.publicJob(service.get(job.id))).not.toHaveProperty('upload');
    await service.tick();
    platform.getInstanceStatus.mockResolvedValue('11');
    await service.tick();
    await service.tick();
    expect(platform.openInstance).toHaveBeenCalledTimes(1);
    expect(service.get(job.id)).toMatchObject({ id: job.id, instance_id: '1', prompt_id: job.prompt_id,
      stage: 'awaiting_upload', direct_inputs: null, provider_confirmed: 0 });
    expect(client.health).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('persists the accepted open across a SQLite restart and does not resend it for status 26 or 11', async () => {
    const first = await reservedUpload();
    await first.service.tick();
    expect(first.platform.openInstance).toHaveBeenCalledTimes(1);
    await first.service.close();
    first.db.close();
    const restarted = fixture(first.filename);
    restarted.platform.getInstanceStatus.mockResolvedValue('26');
    await restarted.service.tick();
    restarted.platform.getInstanceStatus.mockResolvedValue('11');
    await restarted.service.tick();
    expect(restarted.platform.openInstance).not.toHaveBeenCalled();
    expect(restarted.store.instance('1')).toMatchObject({ state: 'starting', job_id: first.job.id,
      action_sent: 1, action_started_at: first.startedAt });
    expect(restarted.service.get(first.job.id)).toMatchObject({ stage: 'awaiting_upload', instance_id: '1',
      prompt_id: first.job.prompt_id, direct_inputs: null });
    expect(restarted.client.submit).not.toHaveBeenCalled();
  });

  it('restores health and idle policy before returning to busy, then confirms and submits the original job exactly once', async () => {
    const { service, store, platform, client, job, receipt, startedAt } = await reservedUpload();
    const setter = vi.fn<NonNullable<ComfyServiceOptions['platform']['setGpuIdleShutdown']>>().mockResolvedValue(undefined);
    service.options.platform.setGpuIdleShutdown = setter;
    await service.tick();
    expect(setter).not.toHaveBeenCalled();
    platform.getInstanceStatus.mockResolvedValue('11');
    await service.tick();
    platform.getInstanceStatus.mockResolvedValue('2');
    vi.mocked(Date.now).mockReturnValue(startedAt + 1_000);
    await service.tick();
    expect(client.health).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledExactlyOnceWith('1');
    expect(store.instance('1')).toMatchObject({ state: 'busy', job_id: job.id,
      action_started_at: null, idle_policy_applied_at: startedAt + 1_000 });
    expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', direct_inputs: null, prompt_id: job.prompt_id });
    expect(client.submit).not.toHaveBeenCalled();
    await service.tick();
    expect(client.health).toHaveBeenCalledTimes(1);
    expect(setter).toHaveBeenCalledTimes(1);
    service.completeInputs(job.id, receipt(job.id));
    await service.tick();
    service.completeInputs(job.id, receipt(job.id));
    await service.tick();
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(client.submit.mock.calls[0]![0]).toMatchObject({ attemptId: job.id, promptId: job.prompt_id });
    expect(platform.openInstance).toHaveBeenCalledTimes(1);
  });

  it('persists occupied capacity backoff across restart and retries only when next_action_at is due', async () => {
    const first = await reservedUpload();
    first.configuration.capacityPollIntervalMs = 10_000;
    first.platform.openInstance.mockRejectedValueOnce({ code: 'CAPACITY_UNAVAILABLE' });
    await first.service.tick();
    expect(first.store.instance('1')).toMatchObject({ state: 'waiting_capacity', job_id: first.job.id,
      next_action_at: first.startedAt + 10_000, action_started_at: null, action_sent: 0 });
    expect(first.service.publicJob(first.service.get(first.job.id))).toMatchObject({ stage: 'waiting_capacity',
      progress: { message: '原GPU实例开机暂缺可分配GPU，正在轮询恢复；保留原任务和已上传素材',
        instance: { id: '1' }, nextRetryAt: new Date(first.startedAt + 10_000).toISOString() } });
    expect(first.service.publicJob(first.service.get(first.job.id))).not.toHaveProperty('upload');
    await first.service.close();
    first.db.close();
    const restarted = fixture(first.filename);
    restarted.configuration.capacityPollIntervalMs = 10_000;
    restarted.platform.getInstanceStatus.mockResolvedValue('22');
    restarted.platform.openInstance.mockResolvedValue(undefined);
    vi.mocked(Date.now).mockReturnValue(first.startedAt + 9_999);
    await restarted.service.tick();
    expect(restarted.platform.openInstance).not.toHaveBeenCalled();
    vi.mocked(Date.now).mockReturnValue(first.startedAt + 10_000);
    await restarted.service.tick();
    expect(restarted.platform.openInstance).toHaveBeenCalledExactlyOnceWith('1');
    await restarted.service.tick();
    expect(restarted.platform.openInstance).toHaveBeenCalledTimes(1);
    expect(restarted.store.instance('1')).toMatchObject({ state: 'starting', job_id: first.job.id, action_sent: 1 });
    expect(restarted.service.get(first.job.id)).toMatchObject({ stage: 'awaiting_upload', instance_id: '1', prompt_id: first.job.prompt_id });
    expect(restarted.client.submit).not.toHaveBeenCalled();
  });

  it('releases a cancelled upload reservation without waking the externally stopped instance', async () => {
    const { service, store, platform, client, job } = await reservedUpload();
    service.cancel(job.id);
    await service.tick();
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'cancelled', cancel_requested: 1 });
    expect(store.instance('1')!.job_id).toBeNull();
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(platform.getInstanceStatus).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it.each(['awaiting_upload', 'preparing', 'submitting'] as const)('migrates a legacy quarantine to offline without losing a %s reservation', async stage => {
    const first = fixture();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const job = first.submit();
    await first.service.tick();
    if (stage !== 'awaiting_upload') first.service.completeInputs(job.id, first.receipt(job.id));
    if (stage === 'submitting') {
      first.client.submit.mockRejectedValueOnce(new ComfyError('SUBMISSION_UNKNOWN', 'Fixture acknowledgement lost', true));
      await first.service.tick();
      expect(first.client.submit).toHaveBeenCalledTimes(1);
    }
    const original = first.service.get(job.id);
    expect(original.stage).toBe(stage);
    first.store.updateInstance('1', { state: 'quarantined', error_code: 'EXTERNAL_OCCUPANCY', next_action_at: now + 30_000 });
    await first.service.close();
    first.db.close();
    const restarted = fixture(first.filename);
    restarted.client.history.mockResolvedValue({ state: 'missing', outputs: [] });
    await restarted.service.tick();
    expect(restarted.store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id });
    expect(restarted.store.instance('1')!.next_action_at).toBeGreaterThan(now);
    expect(restarted.service.get(job.id)).toMatchObject({ stage, instance_id: '1',
      prompt_id: original.prompt_id, direct_inputs: original.direct_inputs, provider_confirmed: original.provider_confirmed });
    expect(restarted.client.submit).not.toHaveBeenCalled();
    expect(restarted.client.upload).not.toHaveBeenCalled();
    expect(restarted.platform.openInstance).not.toHaveBeenCalled();
    expect(restarted.platform.closeInstance).not.toHaveBeenCalled();
  });

  it('backs off a recovery boot timeout and rechecks without losing the original reserved slot', async () => {
    const { service, store, platform, client, job, startedAt } = await reservedUpload(120_000);
    await service.tick();
    expect(platform.openInstance).toHaveBeenCalledTimes(1);
    platform.getInstanceStatus.mockResolvedValue('11');
    vi.mocked(Date.now).mockReturnValue(startedAt + 30_001);
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id, error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT' });
    const retryAt = store.instance('1')!.next_action_at!;
    expect(retryAt).toBeGreaterThan(Date.now());
    expect(service.publicJob(service.get(job.id))).toMatchObject({ stage: 'waiting_instance', progress: {
      phase: 'waiting_instance', nextRetryAt: new Date(retryAt).toISOString(),
      message: 'GPU实例暂未就绪，正在退避后重新检查；保留原任务，不重复生成（COMFY_INSTANCE_ACTION_TIMEOUT）'
    } });
    expect(service.publicJob(service.get(job.id))).not.toHaveProperty('upload');
    await service.tick();
    expect(platform.openInstance).toHaveBeenCalledTimes(1);
    expect(client.submit).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
    platform.getInstanceStatus.mockResolvedValue('2');
    vi.mocked(Date.now).mockReturnValue(retryAt);
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'busy', job_id: job.id });
    expect(service.get(job.id)).toMatchObject({ stage: 'awaiting_upload', direct_inputs: null, prompt_id: job.prompt_id });
    expect(service.publicJob(service.get(job.id))).toHaveProperty('upload');
    expect(client.submit).not.toHaveBeenCalled();
    expect(platform.openInstance).toHaveBeenCalledTimes(1);
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });
});
