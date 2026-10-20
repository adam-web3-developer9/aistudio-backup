import * as crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComfyError } from './comfy-client.js';
import { ComfyService, type ComfyServiceOptions } from './service.js';
import { ComfyStore, type ComfyInput, type FrozenComfyInput } from './store.js';

vi.mock('node:crypto', async (importOriginal) => ({ ...await importOriginal<typeof import('node:crypto')>() }));

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

function fixture(count = 1, filename = ':memory:', workflowId = 'example') {
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
      instances: clients.map((_client, index) => ({ id: String(index + 1), baseUrl: `https://instance-${index + 1}.invalid`, workflowIds: [workflowId] })),
      workflows: [{ id: workflowId, version: '1', graph: { '1': { class_type: 'Example', inputs: { text: '', filename_prefix: 'example' } }, '2': { class_type: 'RandomNoise', inputs: { noise_seed: 42 } }, '3': { class_type: 'OtherNoise', inputs: { noise_seed: 99 } } }, bindings: { text: { nodeId: '1', input: 'text', kind: 'value', required: true }, outputPrefix: { nodeId: '1', input: 'filename_prefix', kind: 'output-prefix', required: true } }, outputNodeIds: ['1'] }]
    }
  });
  services.push(service);
  const submit = (key: string) => service.submit({ adapterId: 'comfyui-v1', requestKey: key, workflowId, values: { text: key }, media: {} } satisfies ComfyInput).job;
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
  it('freezes a fresh crypto-safe RandomNoise seed per H3 job without mutating the shared graph', async () => {
    const randomInt = vi.spyOn(crypto, 'randomInt').mockImplementationOnce(() => 0).mockImplementationOnce(() => 123_456);
    const { service, submit, client, store } = fixture(1, ':memory:', 'minimax-h3-9plus3');
    const configuration = structuredClone(service.options.configuration);
    const first = submit('seed-first');
    const second = submit('seed-second');
    const profiles = [first, second].map(job => (JSON.parse(store.get(job.id)!.input) as FrozenComfyInput).profile);
    const seeds = profiles.map(profile => (profile.graph['2'] as { inputs: { noise_seed: number } }).inputs.noise_seed);
    expect(first.id).not.toBe(second.id);
    expect(seeds).toEqual([0, 123_456]);
    for (const seed of seeds) {
      expect(Number.isSafeInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
    }
    expect(randomInt).toHaveBeenCalledTimes(2);
    for (const [minimum, maximum] of randomInt.mock.calls) {
      expect(minimum).toBe(0);
      expect(Number.isSafeInteger(maximum)).toBe(true);
      expect(maximum).toBeGreaterThan(123_456);
      expect(maximum).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
    for (const profile of profiles) {
      expect({ ...profile.graph, '2': configuration.workflows[0]!.graph['2'] }).toEqual(configuration.workflows[0]!.graph);
    }
    expect(service.options.configuration).toEqual(configuration);
    await service.tick();
    expect(client.submit.mock.calls[0]?.[0].graph['2']).toEqual(profiles[0]!.graph['2']);
    expect((JSON.parse(store.get(first.id)!.input) as FrozenComfyInput).profile).toEqual(profiles[0]);
    expect(service.options.configuration).toEqual(configuration);
  });

  it('preserves the original H3 profile and seed for the same request key across SQLite restart', async () => {
    const randomInt = vi.spyOn(crypto, 'randomInt').mockImplementation(() => 123_456);
    const filename = diskDatabase();
    const first = fixture(1, filename, 'minimax-h3-9plus3');
    const job = first.submit('seed-restart');
    expect(first.submit('seed-restart')).toEqual(job);
    await first.service.close();
    first.db.close();
    const restarted = fixture(1, filename, 'minimax-h3-9plus3');
    const currentProfile = restarted.service.options.configuration.workflows[0]!;
    currentProfile.version = '2';
    currentProfile.graph['2'] = { class_type: 'RandomNoise', inputs: { noise_seed: 999 } };
    currentProfile.graph['3'] = { class_type: 'OtherNoise', inputs: { noise_seed: 888 } };
    const configuration = structuredClone(restarted.service.options.configuration);
    expect(restarted.service.get(job.id)).toEqual(job);
    const duplicate = restarted.submit('seed-restart');
    expect(duplicate).toEqual(job);
    expect(duplicate.input).toBe(job.input);
    expect(randomInt).toHaveBeenCalledTimes(1);
    await restarted.service.tick();
    const frozen = JSON.parse(job.input) as FrozenComfyInput;
    expect(restarted.client.submit.mock.calls[0]?.[0].graph['2']).toEqual(frozen.profile.graph['2']);
    expect(restarted.client.submit.mock.calls[0]?.[0].graph['3']).toEqual(frozen.profile.graph['3']);
    expect(restarted.store.get(job.id)?.input).toBe(job.input);
    expect(restarted.service.options.configuration).toEqual(configuration);
  });

  it('does not randomize RandomNoise seeds for other workflows', async () => {
    const randomInt = vi.spyOn(crypto, 'randomInt');
    const { service, submit, client } = fixture(1, ':memory:', 'minimax-h3-9plus3-other');
    const configuration = structuredClone(service.options.configuration);
    const first = submit('other-seed-first');
    const second = submit('other-seed-second');
    for (const job of [first, second]) {
      expect((JSON.parse(job.input) as FrozenComfyInput).profile).toEqual(configuration.workflows[0]);
    }
    await service.tick();
    expect(client.submit.mock.calls[0]?.[0].graph['2']).toEqual(configuration.workflows[0]!.graph['2']);
    expect(randomInt).not.toHaveBeenCalled();
    expect(service.options.configuration).toEqual(configuration);
  });

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

  it.each([false, true])('defers unresolved timed-out work without freeing its slot or closing the instance (ack lost: %s)', async (ackLost) => {
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
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
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id,
      error_code: 'COMFY_REMOTE_UNCONFIRMED', next_action_at: Date.now() + 30_000 });
    expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED' });
    expect(() => service.control('1', 'close')).toThrow();
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it.each([false, true])('observes only the original timed-out task until its late success (ack lost: %s)', async ackLost => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { service, submit, store, db, client, platform, results } = fixture();
    if (ackLost) client.submit.mockRejectedValueOnce(new ComfyError('SUBMISSION_UNKNOWN', 'Ack lost', true));
    const job = submit('late-unknown-success');
    await service.tick();
    client.history.mockResolvedValue({ state: 'missing', outputs: [] });
    db.prepare('UPDATE comfy_jobs SET deadline=? WHERE id=?').run(Date.now() - 1, job.id);
    await service.tick();
    const waiting = submit('waiting-for-unknown');
    expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED', prompt_id: job.prompt_id });
    const observations = client.history.mock.calls.length;
    now.mockReturnValue(1_800_000_029_999);
    await service.tick();
    expect(client.history).toHaveBeenCalledTimes(observations);
    now.mockReturnValue(1_800_000_030_000);
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id, next_action_at: Date.now() + 30_000 });
    expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED' });
    expect(service.get(waiting.id).stage).toBe('queued');
    client.history.mockResolvedValue({ state: 'running', outputs: [] });
    now.mockReturnValue(1_800_000_060_000);
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED' });
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id, next_action_at: Date.now() + 30_000 });
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(client.history.mock.calls.every(([promptId]) => promptId === job.prompt_id)).toBe(true);
    expect(platform.openInstance).not.toHaveBeenCalled();
    expect(platform.closeInstance).not.toHaveBeenCalled();
    client.history.mockResolvedValue({ state: 'succeeded', outputs: [{ nodeId: '1', filename: 'late.mp4', subfolder: job.id, type: 'output' }] });
    now.mockReturnValue(1_800_000_090_000);
    await service.tick();
    await vi.waitFor(() => expect(service.get(job.id)).toMatchObject({ stage: 'succeeded', error_code: null, result_pending: 0 }));
    expect(results.save).toHaveBeenCalledTimes(1);
    expect(results.save.mock.calls[0]?.[0]).toBe(job.id);
    expect(client.submit.mock.calls.filter(([request]) => request.promptId === job.prompt_id)).toHaveLength(1);
    expect(store.instance('1')?.job_id).not.toBe(job.id);
    expect(platform.closeInstance).not.toHaveBeenCalled();
  });

  it('migrates a legacy unknown-task quarantine across restart and collects its late result without resubmission', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const filename = diskDatabase();
    const first = fixture(1, filename);
    first.client.submit.mockRejectedValueOnce(new ComfyError('SUBMISSION_UNKNOWN', 'Ack lost', true));
    const job = first.submit('legacy-unknown');
    await first.service.tick();
    first.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED', deadline: Date.now() - 1 });
    first.store.updateInstance('1', { state: 'quarantined', error_code: 'COMFY_REMOTE_UNCONFIRMED', next_action_at: null });
    await first.service.close();
    first.db.close();
    const restarted = fixture(1, filename);
    restarted.client.history.mockResolvedValue({ state: 'succeeded', outputs: [{ nodeId: '1', filename: 'late.mp4', subfolder: job.id, type: 'output' }] });
    await restarted.service.tick();
    expect(restarted.store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id, next_action_at: Date.now() + 30_000 });
    expect(restarted.client.history).not.toHaveBeenCalled();
    now.mockReturnValue(1_800_000_030_000);
    await restarted.service.tick();
    await vi.waitFor(() => expect(restarted.service.get(job.id).stage).toBe('succeeded'));
    expect(restarted.client.history).toHaveBeenCalledWith(job.prompt_id);
    expect(restarted.client.submit).not.toHaveBeenCalled();
    expect(restarted.results.save).toHaveBeenCalledTimes(1);
    expect(restarted.store.instance('1')?.job_id).toBeNull();
    expect(restarted.platform.openInstance).not.toHaveBeenCalled();
    expect(restarted.platform.closeInstance).not.toHaveBeenCalled();
  });

  it('releases the original unknown-task slot only after its remote failure is confirmed', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    const { service, submit, store, db, client, platform } = fixture();
    client.submit.mockRejectedValueOnce(new ComfyError('SUBMISSION_UNKNOWN', 'Ack lost', true));
    client.history.mockResolvedValue({ state: 'missing', outputs: [] });
    const job = submit('late-unknown-failure');
    await service.tick();
    db.prepare('UPDATE comfy_jobs SET deadline=? WHERE id=?').run(Date.now() - 1, job.id);
    await service.tick();
    expect(store.instance('1')).toMatchObject({ state: 'offline', job_id: job.id, next_action_at: Date.now() + 30_000 });
    client.history.mockResolvedValue({ state: 'failed', outputs: [] });
    now.mockReturnValue(1_800_000_030_000);
    await service.tick();
    expect(service.get(job.id)).toMatchObject({ stage: 'failed', error_code: 'COMFY_RENDER_FAILED' });
    expect(store.instance('1')?.job_id).toBeNull();
    expect(client.history).toHaveBeenLastCalledWith(job.prompt_id);
    expect(client.submit).toHaveBeenCalledTimes(1);
    expect(platform.openInstance).not.toHaveBeenCalled();
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
