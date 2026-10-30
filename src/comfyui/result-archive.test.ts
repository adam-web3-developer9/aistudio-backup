import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore } from './store.js';
import { schedulerPolicy } from './scheduler.js';
import type { ArchiveObject, ResultArchiveStorage } from './tos-result-storage.js';
import type { GpuResultExporter } from './result-archive.js';

const contexts: Array<{ db: Database.Database; service: ComfyService }> = [];
const file = { size: 4096, sha256: 'a'.repeat(64), md5: Buffer.alloc(16, 1).toString('base64') };
const output = { filename: 'video.mp4', subfolder: 'result', type: 'output', nodeId: '1' };
const start = 1_800_000_000_000;

function fixture(commercial = false) {
  const workflowId = commercial ? 'minimax-h3-9plus3' : 'render';
  let now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const db = new Database(':memory:');
  const store = new ComfyStore(db);
  const remote = new Map<string, ArchiveObject>();
  const storage = {
    uploadTarget: vi.fn<ResultArchiveStorage['uploadTarget']>().mockImplementation(key => ({ url: 'https://bucket.tos-cn-beijing.volces.com/' + key, headers: {} })),
    head: vi.fn<ResultArchiveStorage['head']>().mockImplementation(async key => remote.get(key) ?? null),
    downloadUrl: vi.fn<ResultArchiveStorage['downloadUrl']>().mockImplementation((key, seconds) => `https://bucket.tos-cn-beijing.volces.com/${key}?expires=${seconds}`),
    delete: vi.fn<ResultArchiveStorage['delete']>().mockImplementation(async key => { remote.delete(key); }),
  };
  const exporter = {
    describe: vi.fn<GpuResultExporter['describe']>().mockResolvedValue(file),
    upload: vi.fn<GpuResultExporter['upload']>().mockImplementation(async (_job, _output, value, target) => {
      remote.set(new URL(target.url).pathname.slice(1), { ...value, uploadedAt: now });
      return value;
    }),
  };
  const platform = { getInstanceStatus: vi.fn().mockResolvedValue('2'), openInstance: vi.fn(), closeInstance: vi.fn().mockResolvedValue(undefined) };
  const client = { health: vi.fn().mockResolvedValue(undefined), queue: vi.fn().mockResolvedValue({ running: [], pending: [] }),
    history: vi.fn().mockResolvedValue({ state: 'running', outputs: [] }), findAttempt: vi.fn(), upload: vi.fn(), submit: vi.fn(), download: vi.fn() };
  const options: ComfyServiceOptions = {
    store, owner: 'owner', platform, client: () => client, assets: { get: vi.fn(), read: vi.fn() },
    results: { read: vi.fn(), save: vi.fn() }, ownsAsset: () => false,
    configuration: { autoOpen: false, pollIntervalMs: 1000, bootTimeoutMs: 30_000, jobTimeoutMs: 3_600_000,
      instances: [{ id: '1', baseUrl: 'https://native.waas.aigate.cc', workflowIds: [workflowId] }],
      workflows: [{ id: workflowId, version: '1', graph: { '1': { class_type: 'Render', inputs: { filename_prefix: '', duration: 5, width: 1344, height: 768 } } },
        bindings: { output: { nodeId: '1', input: 'filename_prefix', kind: 'output-prefix' },
          ...(commercial ? { duration: { nodeId: '1', input: 'duration', required: true }, width: { nodeId: '1', input: 'width', required: true }, height: { nodeId: '1', input: 'height', required: true } } : {}) }, outputNodeIds: ['1'] }] },
    resultArchive: { storage, exporter: () => exporter, keyPrefix: 'comfy-results', storageIdentity: 'fixture-private-bucket' },
  };
  options.configuration.scheduler = schedulerPolicy(options.configuration);
  let service = new ComfyService(options);
  contexts.push({ db, service });
  store.updateInstance('1', { state: 'ready', idle_since: now });
  let sequence = 0;
  function succeed() {
    const job = service.submit({ adapterId: 'comfyui-v1', requestKey: 'job-' + sequence++, workflowId,
      transport: 'direct', values: commercial ? { duration: 5, width: 1344, height: 768 } : {}, media: {}, directMedia: {},
      ...(commercial ? { resultDelivery: 'archive' as const } : {}) }).job;
    store.claim('1', [workflowId], now);
    store.updateJob(job.id, { stage: 'succeeded', result_pending: 1,
      result: JSON.stringify({ videoUrl: 'https://native.waas.aigate.cc/view?filename=video.mp4&subfolder=result&type=output', output }) });
    store.releaseSlot(job.id);
    return store.get(job.id)!;
  }
  return { db, store, get service() { return service; }, options, platform, client, storage, exporter, remote, succeed,
    advance: (milliseconds: number) => { now += milliseconds; }, now: () => now,
    run: async () => { await service.tick(); await service.archive!.settled(); },
    restart: async () => { await service.close(); service = new ComfyService(options); contexts.push({ db, service }); },
  };
}
afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) if (context.db.open) { await context.service.close(); context.db.close(); }
  vi.restoreAllMocks();
});

describe('GPU result archive fallback', () => {
  it('rejects commercial creation before accepting a job when archive storage is not configured', async () => {
    const context = fixture(true);
    const service = new ComfyService({ ...context.options, resultArchive: undefined });
    try {
      expect(() => service.submit({ adapterId: 'comfyui-v1', workflowId: 'minimax-h3-9plus3', requestKey: 'missing-storage', transport: 'direct', resultDelivery: 'archive',
        values: { duration: 5, width: 1344, height: 768 }, media: {} })).toThrow(expect.objectContaining({ statusCode: 503, code: 'COMFY_ARCHIVE_UNAVAILABLE' }));
      expect(context.store.byRequest('owner', 'missing-storage')).toBeUndefined();
    } finally { await service.close(); }
  });

  it.each([{ duration: 4, width: 480, height: 864 }, { duration: 15, width: 1920, height: 1088 }])('accepts and freezes supported commercial boundaries: %j', values => {
    const context = fixture(true);
    const input = { adapterId: 'comfyui-v1' as const, workflowId: 'minimax-h3-9plus3', requestKey: 'boundary', transport: 'direct' as const, resultDelivery: 'archive' as const, values, media: {} };
    const job = context.service.submit(input).job;
    values.duration = 10;
    expect(context.service.publicJob(job).billing?.requestedSeconds).toBe(JSON.parse(job.input).values.duration);
    expect(JSON.parse(job.input).values).not.toBe(values);
  });

  it('withholds commercial success and temporary GPU URLs until an immediate verified archive is stored', async () => {
    const context = fixture(true);
    const job = context.succeed();
    expect(context.service.publicJob(job)).toMatchObject({ status: 'running', stage: 'archiving', billing: { unit: 'second', requestedSeconds: 5 } });
    expect(context.service.publicJob(job)).not.toHaveProperty('result');
    expect(() => context.service.acknowledgeCollected(job.id)).toThrow(expect.objectContaining({ code: 'COMFY_RESULT_UNAVAILABLE' }));
    await context.run();
    expect(context.exporter.upload).toHaveBeenCalledTimes(1);
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ status: 'succeeded', result: { storage: 'tos', expiresAt: start + 86_400_000 } });
    expect(context.client.download).not.toHaveBeenCalled();
    expect(context.options.results.save).not.toHaveBeenCalled();
    await context.restart();
    expect(context.service.publicJob(context.service.get(job.id)).billing).toEqual({ unit: 'second', requestedSeconds: 5 });
  });

  it('retains commercial charges while archive transfer is retrying, and proves final delivery failure only after abandonment', async () => {
    const context = fixture(true);
    const job = context.succeed();
    context.exporter.describe.mockRejectedValue(new Error('temporary connection failure'));
    await context.run();
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ status: 'running', stage: 'archiving' });
    expect(context.service.publicJob(context.service.get(job.id)).error?.providerTerminal).not.toBe(true);
    for (let attempt = 0; attempt < 3; attempt++) {
      context.advance(60_000);
      await context.run();
    }
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ status: 'failed', error: { code: 'COMFY_ARCHIVE_TRANSFER_FAILED', providerTerminal: true } });
  });

  it('does not authorize refunds for uncertain cancellation or previously delivered expired results', async () => {
    const context = fixture(true);
    const job = context.succeed();
    context.store.updateJob(job.id, { stage: 'cancelled', result: null, result_pending: 0, provider_confirmed: 1, error_code: 'COMFY_CANCELLED',
      native_checkpoint: JSON.stringify({ attempts: [{ number: 1, marker: job.id, plannedId: job.prompt_id, sentAt: start, confirmed: true }], nextAt: start, windowStart: 0 }) });
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ error: { providerTerminal: false } });
    context.store.updateJob(job.id, { stage: 'failed', provider_confirmed: 0, error_code: 'COMFY_REMOTE_UNCONFIRMED' });
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ error: { providerTerminal: false } });
    const delivered = context.succeed();
    await context.run();
    context.advance(86_400_001);
    expect(context.service.publicJob(context.service.get(delivered.id))).toMatchObject({ status: 'failed', error: { code: 'COMFY_RESULT_EXPIRED', providerTerminal: false } });
  });

  it.each([
    { duration: 0 }, { duration: 3 }, { duration: 16 }, { duration: 5.5 }, { duration: '5' },
    { width: 1921 }, { width: 481 }, { height: -768 }, { width: 1920, height: 1920 },
  ])('rejects commercial duration or dimension multipliers before persisting: %j', values => {
    const context = fixture(true);
    expect(() => context.service.submit({ adapterId: 'comfyui-v1', workflowId: 'minimax-h3-9plus3', requestKey: 'invalid',
      transport: 'direct', resultDelivery: 'archive', values: { duration: 5, width: 1344, height: 768, ...values }, media: {} })).toThrow(expect.objectContaining({ statusCode: 400 }));
    expect(context.store.byRequest('owner', 'invalid')).toBeUndefined();
  });

  it('freezes commercial delivery in the idempotency identity and acknowledges empty media after GPU allocation', async () => {
    const context = fixture(true);
    const input = { adapterId: 'comfyui-v1' as const, workflowId: 'minimax-h3-9plus3', requestKey: 'empty-inputs', transport: 'direct' as const,
      resultDelivery: 'archive' as const, values: { duration: 10, width: 1344, height: 768 }, media: {} };
    const accepted = context.service.submit(input);
    expect(context.service.submit(input).job.id).toBe(accepted.job.id);
    expect(() => context.service.submit({ ...input, resultDelivery: undefined })).toThrow(expect.objectContaining({ code: 'COMFY_REQUEST_CONFLICT' }));
    expect(() => context.service.submit({ ...input, values: { ...input.values, duration: 5 } })).toThrow(expect.objectContaining({ code: 'COMFY_REQUEST_CONFLICT' }));
    await context.run();
    expect(context.store.get(accepted.job.id)).toMatchObject({ stage: 'preparing', direct_inputs: '{}' });
    expect(context.service.publicJob(context.service.get(accepted.job.id)).billing?.requestedSeconds).toBe(10);
    const queued = context.service.submit({ ...input, requestKey: 'cancel-before-submit' }).job;
    expect(context.service.publicJob(context.service.cancel(queued.id))).toMatchObject({ error: { providerTerminal: true } });
  });

  it('rejects stale upload acknowledgements after a new commercial reservation and accepts current receipt replays', async () => {
    const context = fixture(true);
    const profile = context.options.configuration.workflows[0]!;
    (profile.graph['1'] as { inputs: Record<string, unknown> }).inputs.image = '';
    profile.bindings.image1 = { nodeId: '1', input: 'image', kind: 'media', required: true };
    const job = context.service.submit({ adapterId: 'comfyui-v1', workflowId: profile.id, requestKey: 'reference-input', transport: 'direct', resultDelivery: 'archive',
      values: { duration: 5, width: 1344, height: 768 }, media: {}, directMedia: { image1: { filename: 'reference.png', contentType: 'image/png', sha256: 'b'.repeat(64) } } }).job;
    await context.run();
    const oldReservation = `${job.id}_1_1`;
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ stage: 'awaiting_upload', upload: { reservationId: oldReservation } });
    expect(context.store.requeueUpload(job.id, 0)).toBe(true);
    await context.run();
    const receipt = { image1: { name: 'reference.png', subfolder: job.id, type: 'input' as const } };
    expect(() => context.service.completeInputs(job.id, receipt, oldReservation)).toThrow(expect.objectContaining({ code: 'COMFY_UPLOAD_RESERVATION_STALE' }));
    const currentReservation = `${job.id}_1_2`;
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ upload: { reservationId: currentReservation } });
    const accepted = context.service.completeInputs(job.id, receipt, currentReservation);
    expect(context.service.completeInputs(job.id, receipt, currentReservation)).toEqual(accepted);
    expect(context.service.publicJob(accepted).stage).toBe('preparing');
  });

  it('persists the first SSH host fingerprint per known instance and rejects replacement across restart', async () => {
    const context = fixture();
    const fingerprint = 'a'.repeat(64);
    expect(context.store.verifySshHostKey('unregistered', fingerprint)).toBe(false);
    expect(context.store.verifySshHostKey('1', 'invalid')).toBe(false);
    expect(context.store.verifySshHostKey('1', fingerprint)).toBe(true);
    await context.restart();
    const recovered = new ComfyStore(context.db);
    expect(recovered.verifySshHostKey('1', fingerprint.toUpperCase())).toBe(true);
    expect(recovered.verifySshHostKey('1', 'b'.repeat(64))).toBe(false);
    context.store.registerInstances(['2']);
    expect(recovered.verifySshHostKey('2', 'b'.repeat(64))).toBe(true);
  });

  it('waits ten minutes from first success, verifies the object, and permits idle shutdown without another five-minute wait', async () => {
    const context = fixture();
    const job = context.succeed();
    await context.run();
    context.advance(599_999);
    await context.run();
    expect(context.exporter.describe).not.toHaveBeenCalled();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    context.advance(1);
    await context.run();
    expect(context.exporter.upload).toHaveBeenCalledTimes(1);
    expect(context.storage.head).toHaveBeenCalledTimes(1);
    expect(context.store.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 0 });
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ status: 'succeeded', result: { storage: 'tos', expiresAt: context.now() + 86_400_000 } });
    expect(context.store.hasUnresolvedWork('1')).toBe(false);
    await context.run();
    expect(context.platform.closeInstance).toHaveBeenCalledExactlyOnceWith('1');
    expect(context.client.download).not.toHaveBeenCalled();
    expect(context.options.results.save).not.toHaveBeenCalled();
  });

  it('does not archive results collected before the timeout', async () => {
    const context = fixture();
    const job = context.succeed();
    await context.run();
    context.advance(599_999);
    context.service.acknowledgeCollected(job.id);
    context.advance(1);
    await context.run();
    expect(context.exporter.describe).not.toHaveBeenCalled();
    expect(context.service.archive!.get(job.id)?.state).toBe('skipped');
  });

  it('never resets the first success timer on queries or service restart', async () => {
    const context = fixture();
    const job = context.succeed();
    await context.run();
    context.advance(599_999);
    await context.service.requestResultAvailability(job.id);
    await context.restart();
    await context.run();
    expect(context.exporter.upload).not.toHaveBeenCalled();
    context.advance(1);
    await context.run();
    expect(context.exporter.upload).toHaveBeenCalledTimes(1);
    expect(context.service.archive!.get(job.id)?.ready_at).toBe(start);
  });

  it('recovers a completed PUT with a lost response by HEAD without resending upload', async () => {
    const context = fixture();
    const job = context.succeed();
    context.exporter.upload.mockImplementationOnce(async (_job, _output, value, target) => {
      context.remote.set(new URL(target.url).pathname.slice(1), { ...value, uploadedAt: context.now() });
      throw new Error('response lost');
    });
    context.advance(600_000);
    await context.run();
    expect(context.store.get(job.id)?.result_pending).toBe(1);
    await context.restart();
    context.advance(60_000);
    await context.run();
    expect(context.exporter.upload).toHaveBeenCalledTimes(1);
    expect(context.store.get(job.id)?.result_pending).toBe(0);
    expect(context.service.archive!.get(job.id)?.expires_at).toBe(start + 600_000 + 86_400_000);
  });

  it.each(['describe', 'upload', 'head'] as const)('abandons the GPU result after bounded %s failures', async method => {
    const context = fixture();
    const job = context.succeed();
    if (method === 'head') context.storage.head.mockRejectedValue(new Error('private URL must not leak'));
    else context.exporter[method].mockRejectedValue(new Error('private URL must not leak'));
    context.advance(600_000);
    for (let attempt = 0; attempt < 6; attempt++) { await context.run(); context.advance(60_000); }
    expect(context.service.archive!.get(job.id)).toMatchObject({ state: 'failed', attempts: 3, error_code: 'COMFY_ARCHIVE_TRANSFER_FAILED' });
    expect(context.store.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_ARCHIVE_TRANSFER_FAILED',
      result: null, result_pending: 0, result_wake_requested: 0, collected_at: null });
    expect(context.store.hasUnresolvedWork('1')).toBe(false);
    expect(context.platform.closeInstance).toHaveBeenCalled();
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ status: 'failed', error: { code: 'COMFY_ARCHIVE_TRANSFER_FAILED' } });
    expect(context.service.publicJob(context.service.get(job.id)).result).toBeUndefined();
    expect(context.exporter.upload.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it.each(['size', 'md5', 'sha256'] as const)('does not trust an object with the wrong %s', async field => {
    const context = fixture();
    const job = context.succeed();
    context.storage.head.mockResolvedValue({ ...file, uploadedAt: start + 600_000,
      [field]: field === 'size' ? file.size + 1 : field === 'md5' ? Buffer.alloc(16, 2).toString('base64') : 'b'.repeat(64) });
    context.advance(600_000);
    await context.run();
    expect(context.store.get(job.id)?.result_pending).toBe(1);
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
  });

  it.each(['describe', 'upload', 'head', 'cleanup'] as const)('records only safe failure details for archive %s', async phase => {
    const context = fixture();
    const job = context.succeed();
    const sensitive = 'https://private.invalid/upload?signature=secret SSH password=secret';
    const error = Object.assign(new Error(sensitive), { code: 'ECONNRESET' });
    if (phase === 'cleanup') {
      context.advance(600_000);
      await context.run();
      context.storage.delete.mockRejectedValue(error);
      context.advance(86_400_000);
    } else {
      if (phase === 'head') context.storage.head.mockRejectedValue(error);
      else context.exporter[phase].mockRejectedValue(error);
      context.advance(600_000);
    }
    for (let attempt = 0; attempt < 2; attempt++) { await context.run(); context.advance(60_000); }
    const events = context.store.events.list({ jobId: job.id, limit: 100 });
    const failures = events.filter(event => event.details?.upstreamCode === 'archive_' + phase);
    expect(failures).toHaveLength(2);
    expect(failures.every(event => event.details?.errorType === 'ECONNRESET')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(sensitive);
    expect(JSON.stringify(events)).not.toContain('private.invalid');
    expect(failures.every(event => event.code === (phase === 'cleanup' ? 'COMFY_ARCHIVE_DELETE_FAILED' : 'COMFY_ARCHIVE_TRANSFER_FAILED'))).toBe(true);
  });

  it.each([
    { code: 'https://secret.invalid?key=private', name: 'TypeError', expected: 'TypeError' },
    { code: 'bad code with private data', name: 'bad name with private data', expected: 'Error' },
  ])('sanitizes unsafe archive error code and name: $expected', async ({ code, name, expected }) => {
    const context = fixture();
    const job = context.succeed();
    context.exporter.describe.mockRejectedValue({ code, name, message: 'private message' });
    context.advance(600_000);
    await context.run();
    const failure = context.store.events.list({ jobId: job.id, limit: 100 }).find(event => event.details?.upstreamCode === 'archive_describe');
    expect(failure?.details?.errorType).toBe(expected);
    expect(JSON.stringify(failure)).not.toContain('private');
    expect(JSON.stringify(failure)).not.toContain(code);
  });

  it.each(['failed', 'deleted'] as const)('clears a legacy %s archive hold immediately after restart without waiting for expiry', async state => {
    const context = fixture();
    const job = context.succeed();
    await context.run();
    context.db.prepare(`UPDATE comfy_result_archives SET state=?,attempts=3,error_code='COMFY_ARCHIVE_TRANSFER_FAILED',
      expires_at=NULL,next_at=? WHERE job_id=?`).run(state, context.now() + 86_400_000, job.id);
    context.store.updateJob(job.id, { result_wake_requested: 1 });
    await context.restart();
    await context.run();
    expect(context.store.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_ARCHIVE_TRANSFER_FAILED',
      result: null, result_pending: 0, result_wake_requested: 0, collected_at: null });
    expect(context.store.hasUnresolvedWork('1')).toBe(false);
    expect(context.exporter.describe).not.toHaveBeenCalled();
    expect(context.storage.delete).not.toHaveBeenCalled();
    await context.service.requestResultAvailability(job.id);
    expect(context.store.get(job.id)?.result_wake_requested).toBe(0);
  });

  it('does not abandon a result collected while its last archive check fails', async () => {
    const context = fixture();
    const job = context.succeed();
    await context.run();
    context.db.prepare('UPDATE comfy_result_archives SET attempts=3,next_at=? WHERE job_id=?').run(context.now(), job.id);
    let fail!: (reason: Error) => void;
    context.storage.head.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject; }));
    context.db.prepare('UPDATE comfy_result_archives SET file=? WHERE job_id=?').run(JSON.stringify(file), job.id);
    await context.service.tick();
    context.service.acknowledgeCollected(job.id);
    const collectedAt = context.store.get(job.id)!.collected_at;
    fail(new Error('HEAD unavailable'));
    await context.service.archive!.settled();
    expect(context.store.get(job.id)).toMatchObject({ stage: 'succeeded', result_pending: 0, collected_at: collectedAt });
    expect(context.store.get(job.id)?.result).not.toBeNull();
  });

  it('abandons an old failed archive without clearing or stopping a newer execution on the same instance', async () => {
    const context = fixture();
    const old = context.succeed();
    await context.run();
    const newer = context.succeed();
    context.store.updateJob(newer.id, { stage: 'running', result_pending: 0, result: null });
    context.store.updateInstance('1', { state: 'busy', job_id: newer.id });
    context.db.prepare(`UPDATE comfy_result_archives SET state='failed',attempts=3,error_code='COMFY_ARCHIVE_TRANSFER_FAILED'
      WHERE job_id=?`).run(old.id);
    await context.run();
    expect(context.store.get(old.id)).toMatchObject({ stage: 'failed', result_pending: 0, result: null });
    expect(context.store.instance('1')?.job_id).toBe(newer.id);
    expect(context.store.get(newer.id)?.stage).toBe('running');
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
  });

  it('keeps a live transfer protected when the client acknowledges concurrently', async () => {
    const context = fixture();
    const job = context.succeed();
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const original = context.exporter.upload.getMockImplementation()!;
    context.exporter.upload.mockImplementation(async (...args) => { await held; return original(...args); });
    context.advance(600_000);
    await context.service.tick();
    context.service.acknowledgeCollected(job.id);
    expect(context.store.get(job.id)?.result_pending).toBe(0);
    expect(context.store.hasUnresolvedWork('1')).toBe(true);
    expect(() => context.service.control('1', 'close')).toThrow();
    await context.service.tick();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
    finish();
    await context.service.archive!.settled();
    expect(context.store.hasUnresolvedWork('1')).toBe(false);
    expect(context.service.archive!.get(job.id)?.state).toBe('skipped');
    expect(context.service.publicJob(context.service.get(job.id)).result?.videoUrl).toContain('/view?');
    context.advance(86_400_000);
    await context.run();
    expect(context.storage.delete).toHaveBeenCalledTimes(1);
    expect(context.service.publicJob(context.service.get(job.id)).status).toBe('succeeded');
  });

  it('does not clear a newer execution slot or close a busy instance after archiving an older result', async () => {
    const context = fixture();
    const old = context.succeed();
    const newer = context.succeed();
    context.store.updateJob(newer.id, { stage: 'running', result_pending: 0, result: null });
    context.store.updateInstance('1', { state: 'busy', job_id: newer.id });
    context.advance(600_000);
    await context.run();
    expect(context.store.get(old.id)?.result_pending).toBe(0);
    expect(context.store.instance('1')?.job_id).toBe(newer.id);
    await context.run();
    expect(context.platform.closeInstance).not.toHaveBeenCalled();
  });

  it('queries archived results after instance removal without GPU access and expires at 24 hours', async () => {
    const context = fixture();
    const job = context.succeed();
    context.advance(600_000);
    await context.run();
    context.options.configuration.instances.length = 0;
    context.client.health.mockClear();
    await context.restart();
    const query = await context.service.requestResultAvailability(job.id);
    expect(context.service.publicJob(query).result?.videoUrl).toContain('tos-cn-beijing.volces.com');
    expect(context.client.health).not.toHaveBeenCalled();
    context.advance(86_398_000);
    context.service.publicJob(query);
    expect(context.storage.downloadUrl).toHaveBeenLastCalledWith(expect.any(String), 2);
    context.advance(2_000);
    expect(context.service.publicJob(query)).toMatchObject({ status: 'failed', stage: 'result_expired', error: { code: 'COMFY_RESULT_EXPIRED', retryable: false } });
    expect(context.service.publicJob(query).result).toBeUndefined();
    await context.run();
    expect(context.storage.delete).toHaveBeenCalledTimes(1);
    expect(context.store.get(job.id)?.stage).toBe('succeeded');
    expect(() => context.service.acknowledgeCollected(job.id)).not.toThrow();
  });

  it('retries object cleanup without restoring GPU protection or extending expiry', async () => {
    const context = fixture();
    const job = context.succeed();
    context.advance(600_000);
    await context.run();
    const expiresAt = context.service.archive!.get(job.id)!.expires_at;
    context.storage.delete.mockRejectedValueOnce(new Error('offline'));
    context.advance(86_400_000);
    await context.run();
    expect(context.service.archive!.get(job.id)).toMatchObject({ state: 'stored', expires_at: expiresAt, error_code: 'COMFY_ARCHIVE_DELETE_FAILED' });
    expect(context.store.get(job.id)?.result_pending).toBe(0);
    context.advance(60_000);
    await context.run();
    expect(context.service.archive!.get(job.id)?.state).toBe('deleted');
  });

  it('cleans up an unverified uploaded object after abandoning the original result', async () => {
    const context = fixture();
    const job = context.succeed();
    context.storage.head.mockResolvedValue({ ...file, size: file.size + 1, uploadedAt: start + 600_000 });
    context.advance(600_000);
    for (let attempt = 0; attempt < 4; attempt++) { await context.run(); context.advance(60_000); }
    expect(context.service.archive!.get(job.id)?.state).toBe('failed');
    context.advance(86_400_000);
    await context.run();
    expect(context.storage.delete).toHaveBeenCalledTimes(1);
    expect(context.store.get(job.id)?.result_pending).toBe(0);
    expect(context.platform.closeInstance).toHaveBeenCalled();
    expect(context.service.publicJob(context.service.get(job.id)).result).toBeUndefined();
  });

  it('still reconciles a lost response on the third upload attempt without a fourth upload', async () => {
    const context = fixture();
    const job = context.succeed();
    context.exporter.upload.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(async (_job, _output, value, target) => {
        context.remote.set(new URL(target.url).pathname.slice(1), { ...value, uploadedAt: context.now() });
        throw new Error('response lost');
      });
    context.advance(600_000);
    for (let attempt = 0; attempt < 4; attempt++) { await context.run(); context.advance(60_000); }
    expect(context.exporter.upload).toHaveBeenCalledTimes(3);
    expect(context.service.archive!.get(job.id)?.state).toBe('stored');
    expect(context.store.get(job.id)?.result_pending).toBe(0);
  });

  it('never signs or deletes an existing object using a different bucket configuration', async () => {
    const context = fixture();
    const job = context.succeed();
    context.advance(600_000);
    await context.run();
    context.options.resultArchive!.storageIdentity = 'another-private-bucket';
    await context.restart();
    context.storage.downloadUrl.mockClear();
    expect(context.service.publicJob(context.service.get(job.id))).toMatchObject({ status: 'failed', error: { code: 'COMFY_ARCHIVE_UNAVAILABLE' } });
    expect(context.storage.downloadUrl).not.toHaveBeenCalled();
    context.advance(86_400_000);
    await context.run();
    expect(context.storage.delete).not.toHaveBeenCalled();
    expect(context.service.archive!.get(job.id)?.error_code).toBe('COMFY_ARCHIVE_STORAGE_CHANGED');
  });

  it.each(['failed', 'cancelled', 'submitting', 'running'] as const)('does not archive an unconfirmed %s job', async stage => {
    const context = fixture();
    const job = context.succeed();
    context.store.updateJob(job.id, { stage, error_code: 'COMFY_REMOTE_UNCONFIRMED', result: null });
    context.store.updateInstance('1', { job_id: job.id, state: 'busy' });
    context.advance(600_000);
    await context.run();
    expect(context.exporter.describe).not.toHaveBeenCalled();
    expect(context.store.hasUnresolvedWork('1')).toBe(true);
    expect(context.service.archive!.get(job.id)).toBeUndefined();
  });

  it('records real collected time independently from archival and preserves it on replay', async () => {
    const context = fixture();
    const job = context.succeed();
    context.advance(600_000);
    await context.run();
    expect(context.store.get(job.id)?.collected_at).toBeNull();
    context.advance(1234);
    context.service.acknowledgeCollected(job.id);
    const collectedAt = context.now();
    context.advance(1000);
    context.service.acknowledgeCollected(job.id);
    expect(context.store.get(job.id)?.collected_at).toBe(collectedAt);
  });

  it('migrates pre-identity archive rows without guessing their destination bucket', async () => {
    const context = fixture();
    const job = context.succeed();
    await context.run();
    context.db.exec('ALTER TABLE comfy_result_archives DROP COLUMN storage_identity');
    new ComfyStore(context.db);
    await context.restart();
    context.advance(600_000);
    await context.run();
    expect(context.service.archive!.get(job.id)).toMatchObject({ storage_identity: '', error_code: 'COMFY_ARCHIVE_STORAGE_CHANGED' });
    expect(context.exporter.upload).not.toHaveBeenCalled();
    expect(context.store.get(job.id)?.result_pending).toBe(1);
  });
});
