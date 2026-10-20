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
    expect(service.requestResultAvailability(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 0, result_wake_requested: 0, result });
    await service.tick();
    expect(service.publicJob(service.get(job.id))).toMatchObject({ status: 'succeeded', stage: 'succeeded' });
    expect(store.instance('1')!.job_id).toBeNull();
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });
});
