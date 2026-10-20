import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComfyError } from './comfy-client.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore, type ComfyInput } from './store.js';

type DataClient = ReturnType<ComfyServiceOptions['client']>;
const databases: Database.Database[] = [];
const services: ComfyService[] = [];
const directories: string[] = [];

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function diskDatabase(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'comfy-service-test-'));
  directories.push(directory);
  return path.join(directory, 'pool.sqlite');
}

function fixture(count = 1, filename = ':memory:') {
  const db = new Database(filename);
  databases.push(db);
  const store = new ComfyStore(db);
  const clients = Array.from({ length: count }, () => ({
    health: vi.fn<DataClient['health']>().mockResolvedValue(undefined),
    queue: vi.fn<DataClient['queue']>().mockResolvedValue({ running: [], pending: [] }),
    upload: vi.fn<DataClient['upload']>(),
    submit: vi.fn<DataClient['submit']>().mockImplementation(async ({ promptId }) => ({ promptId })),
    history: vi.fn<DataClient['history']>().mockResolvedValue({ state: 'running', outputs: [] }),
    findAttempt: vi.fn<DataClient['findAttempt']>().mockResolvedValue(undefined),
    download: vi.fn<DataClient['download']>().mockImplementation(async () => new Response(new Uint8Array([1, 2])))
  }));
  const platform = {
    getInstanceStatus: vi.fn<ComfyServiceOptions['platform']['getInstanceStatus']>().mockResolvedValue('2'),
    openInstance: vi.fn<ComfyServiceOptions['platform']['openInstance']>().mockResolvedValue(undefined),
    closeInstance: vi.fn<ComfyServiceOptions['platform']['closeInstance']>().mockResolvedValue(undefined)
  };
  const results = {
    save: vi.fn<ComfyServiceOptions['results']['save']>().mockResolvedValue({ hash: 'a'.repeat(64), size: 2, mime: 'video/mp4' }),
    read: vi.fn<ComfyServiceOptions['results']['read']>().mockResolvedValue(null)
  };
  const service = new ComfyService({
    store, owner: 'owner', platform, results,
    assets: { get: () => undefined, read: async () => undefined }, ownsAsset: () => false,
    client: (instance) => clients[Number(instance.id) - 1]!,
    configuration: {
      autoOpen: false, pollIntervalMs: 1_000, bootTimeoutMs: 30_000, jobTimeoutMs: 60_000,
      instances: clients.map((_client, index) => ({ id: String(index + 1), baseUrl: `https://instance-${index + 1}.invalid`, workflowIds: ['example'] })),
      workflows: [{ id: 'example', version: '1', graph: { '1': { class_type: 'Example', inputs: { text: '', filename_prefix: 'example' } } }, bindings: { text: { nodeId: '1', input: 'text', kind: 'value', required: true }, outputPrefix: { nodeId: '1', input: 'filename_prefix', kind: 'output-prefix', required: true } }, outputNodeIds: ['1'] }]
    }
  });
  services.push(service);
  const submit = (key: string) => service.submit({ adapterId: 'comfyui-v1', requestKey: key, workflowId: 'example', values: { text: key }, media: {} } satisfies ComfyInput).job;
  return { db, store, clients, client: clients[0]!, platform, results, service, submit };
}

afterEach(async () => {
  for (const service of services.splice(0)) if (service.store.db.open) await service.close();
  for (const db of databases.splice(0)) if (db.open) db.close();
  vi.restoreAllMocks();
  const root = path.resolve(os.tmpdir()) + path.sep;
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (!target.startsWith(root) || !path.basename(target).startsWith('comfy-service-test-')) throw new Error('Unsafe test cleanup');
    rmSync(target, { recursive: true, force: true });
  }
});

describe('ComfyService pool safety', () => {
  it('preserves a late submission acknowledgement after cancellation without publishing its result', async () => {
    const { service, submit, client, store, results } = fixture();
    const accepted = deferred<{ promptId: string }>();
    client.submit.mockReturnValueOnce(accepted.promise);
    const job = submit('cancel-inflight');
    const processing = service.tick();
    await vi.waitFor(() => expect(client.submit).toHaveBeenCalledTimes(1));
    service.cancel(job.id);
    accepted.resolve({ promptId: 'actual-late-prompt' });
    await processing;
    expect(service.get(job.id)).toMatchObject({ stage: 'running', cancel_requested: 1, prompt_id: 'actual-late-prompt', provider_confirmed: 1 });
    expect(service.publicJob(service.get(job.id))).toMatchObject({ status: 'failed', stage: 'cancelled' });
    expect(store.instance('1')?.job_id).toBe(job.id);
    client.history.mockResolvedValue({ state: 'succeeded', outputs: [] });
    await service.tick();
    expect(store.instance('1')?.job_id).toBeNull();
    expect(service.get(job.id).stage).toBe('cancelled');
    expect(results.save).not.toHaveBeenCalled();
  });

  it('keeps the generation slot through collection when unique output prefixes are not configured', async () => {
    const { service, submit, client, store, results } = fixture();
    delete service.options.configuration.workflows[0]!.bindings.outputPrefix;
    const job = submit('fixed-output-name');
    await service.tick();
    const saving = deferred<{ hash: string; size: number; mime: 'video/mp4' }>();
    results.save.mockReturnValueOnce(saving.promise);
    client.history.mockResolvedValue({ state: 'succeeded', outputs: [{ nodeId: '1', filename: 'fixed.mp4', subfolder: '', type: 'output' }] });
    await service.tick();
    await vi.waitFor(() => expect(results.save).toHaveBeenCalledTimes(1));
    expect(store.instance('1')?.job_id).toBe(job.id);
    expect(() => service.control('1', 'close')).toThrow();
    saving.resolve({ hash: 'a'.repeat(64), size: 2, mime: 'video/mp4' });
    await vi.waitFor(() => expect(service.get(job.id).stage).toBe('succeeded'));
    expect(store.instance('1')?.job_id).toBeNull();
  });

  it('does not revive a timed-out business task when an already started collection finishes late', async () => {
    const { service, submit, client, store, results, db } = fixture();
    const job = submit('late-result');
    await service.tick();
    const saving = deferred<{ hash: string; size: number; mime: 'video/mp4' }>();
    results.save.mockReturnValueOnce(saving.promise);
    client.history.mockResolvedValue({ state: 'succeeded', outputs: [{ nodeId: '1', filename: 'late.mp4', subfolder: job.id, type: 'output' }] });
    await service.tick();
    await vi.waitFor(() => expect(results.save).toHaveBeenCalledTimes(1));
    db.prepare('UPDATE comfy_jobs SET deadline=? WHERE id=?').run(Date.now() - 1, job.id);
    await service.tick();
    expect(service.get(job.id).stage).toBe('failed');
    saving.resolve({ hash: 'a'.repeat(64), size: 2, mime: 'video/mp4' });
    await vi.waitFor(() => expect(store.get(job.id)?.result_pending).toBe(0));
    expect(service.get(job.id).stage).toBe('failed');
    expect(service.publicJob(service.get(job.id))).not.toHaveProperty('result');
  });

  it('injects the attempt id into server-owned output prefixes and rejects client overrides', async () => {
    const { service, submit, client } = fixture();
    expect(() => service.submit({ adapterId: 'comfyui-v1', requestKey: 'override', workflowId: 'example', values: { text: 'hello', outputPrefix: 'shared-output' }, media: {} })).toThrow();
    const job = submit('isolated-output');
    await service.tick();
    expect(client.submit.mock.calls[0]?.[0].graph['1']).toEqual({ class_type: 'Example', inputs: { text: 'isolated-output', filename_prefix: job.id } });
  });

  it('uses three single slots while the fourth job remains queued', async () => {
    const { service, submit, store, clients, platform } = fixture(3);
    const first = [submit('one'), submit('two'), submit('three')];
    await service.tick();
    expect(first.map((job) => service.get(job.id).stage)).toEqual(['running', 'running', 'running']);
    const fourth = submit('four');
    await service.tick();
    expect(service.get(fourth.id).stage).toBe('queued');
    expect(new Set(store.instances().map((instance) => instance.job_id)).size).toBe(3);
    for (const client of clients) expect(client.submit).toHaveBeenCalledTimes(1);
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('retains the original prompt id after ack loss and observes without resubmission', async () => {
    const { service, submit, client, store } = fixture();
    client.submit.mockRejectedValueOnce(new ComfyError('SUBMISSION_UNKNOWN', 'Ack lost', true));
    const job = submit('lost-ack');
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'submitting', prompt_id: job.prompt_id });
    expect(store.instance('1')?.job_id).toBe(job.id);
    await service.tick();
    expect(client.history).toHaveBeenCalledWith(job.prompt_id);
    expect(service.get(job.id)).toMatchObject({ stage: 'running', prompt_id: job.prompt_id });
    expect(client.submit).toHaveBeenCalledTimes(1);
  });

  it('recovers the actual prompt id by attempt marker without submitting again', async () => {
    const { service, submit, client } = fixture();
    client.submit.mockRejectedValueOnce(new ComfyError('SUBMISSION_UNKNOWN', 'Ack lost', true));
    const job = submit('recovered-ack');
    await service.tick();
    client.history.mockResolvedValueOnce({ state: 'missing', outputs: [] });
    client.findAttempt.mockResolvedValueOnce({ promptId: 'server-generated-id' });
    await service.tick();
    expect(client.findAttempt).toHaveBeenCalledWith(job.id);
    expect(client.history.mock.calls.map(([id]) => id)).toEqual([job.prompt_id, 'server-generated-id']);
    expect(service.get(job.id).prompt_id).toBe('server-generated-id');
    expect(client.submit).toHaveBeenCalledTimes(1);
  });

  it('durably stores the actual acknowledgement id', async () => {
    const { service, submit, client, store } = fixture();
    client.submit.mockResolvedValueOnce({ promptId: 'legacy-server-id' });
    const job = submit('legacy-server');
    await service.tick();
    expect(store.get(job.id)?.prompt_id).toBe('legacy-server-id');
    await service.tick();
    expect(client.history).toHaveBeenCalledWith('legacy-server-id');
  });

  it('cancels a claimed preparing job without submitting', async () => {
    const { service, submit, client, store } = fixture();
    const job = submit('cancel-preparing');
    store.updateInstance('1', { state: 'ready' });
    expect(store.claim('1', ['example'])?.id).toBe(job.id);
    service.cancel(job.id);
    await service.tick();
    expect(client.submit).not.toHaveBeenCalled();
    expect(service.get(job.id).stage).toBe('cancelled');
    expect(store.instance('1')?.job_id).toBeNull();
  });

  it('retains a cancelled running slot until remote terminal confirmation', async () => {
    const { service, submit, client, store, platform } = fixture();
    const job = submit('cancel-running');
    await service.tick();
    service.cancel(job.id);
    const queued = submit('next');
    await service.tick();
    expect(store.instance('1')?.job_id).toBe(job.id);
    expect(service.get(queued.id).stage).toBe('queued');
    expect(() => service.control('1', 'close')).toThrow();
    expect(platform.closeInstance).not.toHaveBeenCalled();
    expect(client.submit).toHaveBeenCalledTimes(1);
    client.history.mockResolvedValueOnce({ state: 'failed', outputs: [] });
    await service.tick();
    expect(service.get(job.id).stage).toBe('cancelled');
    expect(store.instance('1')?.job_id).not.toBe(job.id);
  });

  it('persists the occupied slot across restart and never resubmits an unresolved submission', async () => {
    const filename = diskDatabase();
    const first = fixture(1, filename);
    first.client.submit.mockRejectedValueOnce(new ComfyError('SUBMISSION_UNKNOWN', 'Ack lost', true));
    const job = first.submit('restart');
    await first.service.tick();
    await first.service.close();
    first.db.close();
    const restarted = fixture(1, filename);
    expect(restarted.store.instance('1')?.job_id).toBe(job.id);
    expect(restarted.service.get(job.id)).toMatchObject({ stage: 'submitting', prompt_id: job.prompt_id });
    await restarted.service.tick();
    expect(restarted.client.history).toHaveBeenCalledWith(job.prompt_id);
    expect(restarted.client.submit).not.toHaveBeenCalled();
  });

  it('allows only one worker to claim and submit across independent database connections', async () => {
    const filename = diskDatabase();
    const first = fixture(1, filename);
    const second = fixture(1, filename);
    const job = first.submit('worker-race');
    await Promise.all([first.service.tick(), second.service.tick()]);
    expect(first.client.submit.mock.calls.length + second.client.submit.mock.calls.length).toBe(1);
    expect(first.store.instance('1')?.job_id).toBe(job.id);
    expect(second.store.instance('1')?.job_id).toBe(job.id);
    await second.service.tick();
    expect(second.client.submit).not.toHaveBeenCalled();
    expect(second.client.history).not.toHaveBeenCalled();
  });

  it.each([false, true])('quarantines unresolved timed-out work without freeing its slot or closing the instance (ack lost: %s)', async (ackLost) => {
    const { service, submit, store, db, client, platform } = fixture();
    if (ackLost) {
      client.submit.mockRejectedValueOnce(new ComfyError('SUBMISSION_UNKNOWN', 'Ack lost', true));
      client.history.mockResolvedValue({ state: 'missing', outputs: [] });
    }
    const job = submit('timeout');
    await service.tick();
    if (ackLost) {
      await service.tick();
      await service.tick();
      expect(client.findAttempt).toHaveBeenCalledTimes(2);
      expect(service.get(job.id).stage).toBe('submitting');
    }
    db.prepare('UPDATE comfy_jobs SET deadline=? WHERE id=?').run(Date.now() - 1, job.id);
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'quarantined', job_id: job.id });
    expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED' });
    expect(() => service.control('1', 'close')).toThrow();
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('protects pending collection from instance close even after the generation slot is released', async () => {
    const { service, submit, store, client, results, platform } = fixture();
    const job = submit('collect');
    await service.tick();
    client.history.mockResolvedValue({ state: 'succeeded', outputs: [{ nodeId: '1', filename: 'video.mp4', subfolder: job.id, type: 'output' }] });
    const saving = deferred<Awaited<ReturnType<ComfyServiceOptions['results']['save']>>>();
    results.save.mockReturnValueOnce(saving.promise);
    await service.tick();
    expect(store.instance('1')?.job_id).toBeNull();
    expect(store.get(job.id)).toMatchObject({ stage: 'collecting', result_pending: 1 });
    expect(() => service.control('1', 'close')).toThrow();
    await vi.waitFor(() => expect(results.save).toHaveBeenCalledTimes(1));
    expect(() => service.control('1', 'close')).toThrow();
    saving.resolve({ hash: 'b'.repeat(64), size: 2, mime: 'video/mp4' });
    await vi.waitFor(() => expect(service.get(job.id).stage).toBe('succeeded'));
    expect(store.get(job.id)?.result_pending).toBe(0);
    expect(() => service.control('1', 'close')).not.toThrow();
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });
});
