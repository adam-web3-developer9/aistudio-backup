import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { ComfyError } from './comfy-client.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore } from './store.js';
import { nativeCheckpoint } from './native-submission.js';
import { schedulerPolicy } from './scheduler.js';

const contexts: Array<{ db: Database.Database; services: ComfyService[] }> = [];
async function fixture() {
  const db = new Database(':memory:');
  const store = new ComfyStore(db);
  type Client = ReturnType<ComfyServiceOptions['client']>;
  const client = {
    health: vi.fn<Client['health']>().mockResolvedValue(undefined),
    queue: vi.fn<Client['queue']>().mockResolvedValue({ running: [], pending: [] }),
    upload: vi.fn<Client['upload']>(),
    submit: vi.fn<Client['submit']>().mockRejectedValue(new ComfyError('SUBMISSION_UNKNOWN', 'Safe failure', true,
      { requestType: 'http', httpStatus: 502, elapsedMs: 30_000 })),
    history: vi.fn<Client['history']>().mockResolvedValue({ state: 'missing', outputs: [] }),
    findAttempt: vi.fn<Client['findAttempt']>().mockResolvedValue(undefined),
    download: vi.fn<Client['download']>(),
  };
  const configuration: ComfyServiceOptions['configuration'] = {
    autoOpen: false, pollIntervalMs: 1000, bootTimeoutMs: 30_000, jobTimeoutMs: 300_000,
    instances: [{ id: '1', baseUrl: 'https://native.invalid', workflowIds: ['fixture'] }],
    workflows: [{ id: 'fixture', version: '1', graph: {
      '1': { class_type: 'Render', inputs: { text: '', image: ['2', 0], filename_prefix: '', seed: 123 } },
      '2': { class_type: 'LoadImage', inputs: { image: '' } },
    }, bindings: { text: { nodeId: '1', input: 'text' }, image1: { nodeId: '2', input: 'image', kind: 'media', required: true },
      output: { nodeId: '1', input: 'filename_prefix', kind: 'output-prefix' } }, outputNodeIds: ['1'] }],
  };
  const options: ComfyServiceOptions = { store, configuration, owner: 'owner', client: () => client,
    platform: { getInstanceStatus: vi.fn().mockResolvedValue('2'), openInstance: vi.fn(), closeInstance: vi.fn() },
    assets: { get: () => undefined, read: async () => undefined }, ownsAsset: () => false,
    results: { save: vi.fn(), read: vi.fn() } };
  const service = new ComfyService(options);
  const context = { db, services: [service] };
  contexts.push(context);
  const job = service.submit({ adapterId: 'comfyui-v1', requestKey: 'original', workflowId: 'fixture',
    values: { text: 'FROZEN_PROMPT_DO_NOT_LOG' }, media: {}, transport: 'direct',
    directMedia: { image1: { filename: 'image1.png', contentType: 'image/png', sha256: 'a'.repeat(64) } } }).job;
  await service.tick();
  service.completeInputs(job.id, { image1: { name: 'image1.png', subfolder: job.id, type: 'input' } });
  return { service, options, store, client, job, context };
}

afterEach(async () => {
  for (const { db, services } of contexts.splice(0)) {
    for (const service of services) await service.close();
    db.close();
  }
  vi.restoreAllMocks();
});

test('native recovery persists three total attempts and frozen inputs across restart; query errors never permit another submit', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, options, store, client, job, context } = await fixture();
  options.configuration.scheduler = schedulerPolicy(options.configuration);
  await service.tick();
  const deadline = service.get(job.id).deadline;
  const event = store.events.recent(job.id, 20).find(event => event.code === 'COMFY_SUBMISSION_UNCONFIRMED');
  expect(event?.details).toMatchObject({ requestType: 'http', httpStatus: 502, elapsedMs: 30_000, attempt: 1 });
  expect(JSON.stringify(store.events.recent(job.id, 30))).not.toContain('FROZEN_PROMPT');
  now.mockReturnValue(Date.now() + 10_000);
  await service.tick();
  expect(client.submit).toHaveBeenCalledTimes(2);
  client.history.mockRejectedValueOnce(new ComfyError('TRANSPORT_ERROR', 'Safe query failure', undefined, { requestType: 'connection', elapsedMs: 5 }));
  now.mockReturnValue(Date.now() + 30_000);
  await service.tick();
  expect(client.submit).toHaveBeenCalledTimes(2);
  await service.close();
  const restarted = new ComfyService(options);
  context.services.push(restarted);
  now.mockReturnValue(Date.now() + 30_000);
  await restarted.tick();
  expect(client.submit).toHaveBeenCalledTimes(3);
  now.mockReturnValue(Date.now() + 30_000);
  await restarted.tick();
  expect(restarted.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED', deadline });
  expect(restarted.publicJob(restarted.get(job.id)).error).toMatchObject({ providerTerminal: false });
  const requests = client.submit.mock.calls.map(([request]) => request);
  expect(new Set(requests.map(request => request.attemptId)).size).toBe(3);
  expect(new Set(requests.map(request => request.promptId)).size).toBe(3);
  expect(requests.every(request => JSON.stringify(request.graph) === JSON.stringify(requests[0]!.graph))).toBe(true);
  expect(nativeCheckpoint(restarted.get(job.id)).attempts).toHaveLength(3);
  expect(store.instance('1')!.job_id).toBeNull();
  await restarted.tick();
  expect(client.submit).toHaveBeenCalledTimes(3);
  // The normal five-minute idle lifecycle can now stop a GPU with no visible work.
  now.mockReturnValue(Date.now() + 300_000);
  await restarted.tick();
  expect(options.platform.closeInstance).toHaveBeenCalledTimes(1);
});

test('a recovered native acceptance prevents resubmission even if its history later disappears; reconcile never submits', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, client, job } = await fixture();
  await service.tick();
  now.mockReturnValue(Date.now() + 10_000);
  await service.reconcile(job.id);
  expect(client.submit).toHaveBeenCalledTimes(1);
  client.findAttempt.mockImplementationOnce(async (_marker, onConfirmed) => {
    onConfirmed?.('accepted-original');
    throw new ComfyError('TRANSPORT_ERROR', 'History read failed after the queue acknowledgement');
  });
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ provider_confirmed: 1, stage: 'running', prompt_id: 'accepted-original' });
  now.mockReturnValue(Date.now() + 60_000);
  await service.tick();
  expect(client.submit).toHaveBeenCalledTimes(1);
  expect(nativeCheckpoint(service.get(job.id)).attempts[0]).toMatchObject({ confirmed: true, promptId: 'accepted-original' });
});

test('the first valid result wins, sibling execution retains its slot, and late success cannot overwrite it or revive cancellation', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, store, client, job } = await fixture();
  await service.tick();
  now.mockReturnValue(Date.now() + 10_000);
  await service.tick();
  const [first, second] = nativeCheckpoint(service.get(job.id)).attempts;
  const good = (filename: string) => ({ state: 'succeeded' as const, outputs: [{ nodeId: '1', type: 'output', subfolder: '', filename }] });
  client.history.mockImplementation(async id => id === first!.plannedId ? { state: 'running', outputs: [] } : good('chosen.mp4'));
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', prompt_id: second!.plannedId });
  const selected = service.get(job.id).result;
  service.acknowledgeCollected(job.id);
  expect(store.instance('1')!.job_id).toBe(job.id);
  client.history.mockImplementation(async id => good(id === first!.plannedId ? 'late.mp4' : 'chosen.mp4'));
  await service.tick();
  expect(service.get(job.id).result).toBe(selected);
  expect(store.instance('1')!.job_id).toBeNull();
  expect(client.submit).toHaveBeenCalledTimes(2);

  const cancellation = await fixture();
  await cancellation.service.tick();
  cancellation.service.cancel(cancellation.job.id);
  cancellation.client.history.mockResolvedValue(good('cancelled.mp4'));
  await cancellation.service.tick();
  expect(cancellation.service.get(cancellation.job.id)).toMatchObject({ stage: 'cancelled', result: null, result_pending: 0 });
  expect(cancellation.client.submit).toHaveBeenCalledTimes(1);
});

test('a malformed successful output cannot win selection ahead of a valid sibling result', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, client, job } = await fixture();
  await service.tick();
  now.mockReturnValue(Date.now() + 10_000);
  await service.tick();
  const [first, second] = nativeCheckpoint(service.get(job.id)).attempts;
  client.history.mockImplementation(async id => ({ state: 'succeeded', outputs: [
    { nodeId: '1', type: 'output', subfolder: '', filename: id === first!.plannedId ? 'bad.png' : 'valid.mp4' },
  ] }));
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', prompt_id: second!.plannedId });
  expect(JSON.parse(service.get(job.id).result!).output.filename).toBe('valid.mp4');
});

test('manual native retry reclaims only its original slot and every old window key remains idempotent', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, store, client, job } = await fixture();
  for (const elapsed of [0, 10_000, 30_000, 30_000]) {
    now.mockReturnValue(Date.now() + elapsed);
    await service.tick();
  }
  expect(service.get(job.id).stage).toBe('failed');
  expect(store.instance('1')!.job_id).toBeNull();
  const frozen = service.get(job.id).input;
  const originalInputs = service.get(job.id).direct_inputs;
  const resumed = service.resumeSubmission(job.id, 'manual-window-1');
  expect(resumed).toMatchObject({ stage: 'queued', instance_id: '1', input: frozen, direct_inputs: originalInputs });
  const deadline = resumed.deadline;
  // Another task's slot cannot be stolen by the retry route.
  store.updateInstance('1', { state: 'busy', job_id: 'another-original-job' });
  expect(service.resumeSubmission(job.id, 'manual-window-1').deadline).toBe(deadline);
  expect(store.instance('1')!.job_id).toBe('another-original-job');
  store.updateInstance('1', { state: 'ready', job_id: null });
  now.mockReturnValue(Date.now() + 30_000);
  await service.tick();
  expect(service.get(job.id)).toMatchObject({ stage: 'submitting', deadline, input: frozen, direct_inputs: originalInputs });
  await service.tick();
  expect(client.submit).toHaveBeenCalledTimes(4);
  expect(client.upload).not.toHaveBeenCalled();
  expect(service.get(job.id).deadline).toBe(deadline);
  now.mockReturnValue(deadline + 1);
  await service.tick();
  const second = service.resumeSubmission(job.id, 'manual-window-2');
  now.mockReturnValue(Date.now() + 1000);
  expect(service.resumeSubmission(job.id, 'manual-window-1').deadline).toBe(second.deadline);
  expect(service.resumeSubmission(job.id, 'manual-window-2').deadline).toBe(second.deadline);
  expect(nativeCheckpoint(service.get(job.id)).windowKeys).toEqual(['manual-window-1', 'manual-window-2']);
});

test('GET availability recovers a late original success after its empty slot was released without reopening submission', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { service, store, client, job, options } = await fixture();
  for (const elapsed of [0, 10_000, 30_000, 30_000]) {
    now.mockReturnValue(Date.now() + elapsed);
    await service.tick();
  }
  expect(service.get(job.id).stage).toBe('failed');
  expect(store.instance('1')!.job_id).toBeNull();
  client.history.mockResolvedValue({ state: 'succeeded', outputs: [
    { nodeId: '1', type: 'output', subfolder: job.id, filename: 'late-original.mp4' },
  ] });
  expect(await service.requestResultAvailability(job.id)).toMatchObject({ stage: 'succeeded', error_code: null });
  expect(JSON.parse(service.get(job.id).result!).output.filename).toBe('late-original.mp4');
  expect(nativeCheckpoint(service.get(job.id)).windowKeys).toBeUndefined();
  expect(client.submit).toHaveBeenCalledTimes(3);
  expect(client.upload).not.toHaveBeenCalled();
  expect(options.platform.openInstance).not.toHaveBeenCalled();
  expect(nativeCheckpoint(service.get(job.id)).attempts).toHaveLength(3);
});
