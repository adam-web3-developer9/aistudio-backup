import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import { assertVideoGatewayRequest } from '../system-channels/video-gateway.js';
import { SystemError } from '../system/types.js';
import { registerAsrRoutes } from './routes.js';
import { AsrService, asrJobSchema, asrOptionsFromEnv } from './service.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const source = {
  requestKey: 'alice-episode-1', clips: [{ id: 'shot-04', filename: 'shot-04.flac', contentType: 'audio/flac',
    durationMs: 14_048, size: 100_000, sha256: 'f'.repeat(64) }],
};
const options = { workers: ['https://east1.example', 'https://east2.example'], key: 'worker-key' };

it('uses one slot per worker and resumes the same submission after an uncertain start', async () => {
  const db = new Database(':memory:');
  dbs.push(db);
  const creates: string[] = [];
  const starts: string[] = [];
  let missing = true;
  let loseStart = true;
  const fetch = (async (raw, init) => {
    const url = new URL(String(raw));
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer worker-key');
    switch (url.pathname) {
      case '/health': return Response.json({ ready: true });
      case '/v1/jobs': {
        const input = JSON.parse(String(init?.body));
        creates.push(input.id);
        expect(input.inputs).toEqual([{ id: 'shot-04', durationMs: 14_048, size: 100_000, sha256: 'f'.repeat(64) }]);
        return Response.json({ id: input.id, status: 'awaiting_upload', uploadToken: 'upload-token' });
      }
      default: {
        const id = url.pathname.split('/')[3]!;
        if (url.pathname.endsWith('/start')) {
          starts.push(id);
          if (missing) return Response.json({ error: { code: 'ASR_INPUTS_MISSING' } }, { status: 409 });
          if (loseStart) { loseStart = false; throw new Error('response lost'); }
          return Response.json({ id, status: 'running' });
        }
        return Response.json({ id, status: 'succeeded', results: [{ id: 'shot-04', text: '那我花九千请你俩做什么', durationMs: 14_048 }] });
      }
    }
  }) as typeof globalThis.fetch;
  const errors: unknown[] = [];
  let service = new AsrService(db, { ...options, fetch }, 'gateway-key', e => errors.push(e));
  const input = asrJobSchema.parse(source);
  const first = service.create(input).job;
  expect(service.create(input)).toMatchObject({ created: false, job: { id: first.id } });
  expect(() => service.create({ ...input, language: 'Auto' })).toThrowError('different manifest');
  const second = service.create({ ...input, requestKey: 'alice-episode-2' }).job;
  const third = service.create({ ...input, requestKey: 'alice-episode-3' }).job;
  await service.step();
  expect(service.find(first.id)).toMatchObject({ stage: 'awaiting_upload', upload: {
    token: 'upload-token', files: [{ url: `https://east1.example/v1/jobs/${first.id}/audio/shot-04` }],
  } });
  expect(service.find(second.id).stage).toBe('awaiting_upload');
  expect(service.find(third.id).stage).toBe('queued');
  service.confirm(first.id);
  await service.step();
  expect(service.find(first.id)).toMatchObject({ stage: 'awaiting_upload', error: { code: 'ASR_INPUTS_MISSING', providerTerminal: false } });
  missing = false;
  service.confirm(first.id);
  await service.step();
  expect(errors).toHaveLength(1);
  expect(service.find(first.id).stage).toBe('submitting');
  service = new AsrService(db, { ...options, fetch }, 'gateway-key', e => errors.push(e));
  await service.step();
  expect(service.find(first.id).stage).toBe('running');
  // Warm worker pipelines third into awaiting_upload while first is running.
  expect(service.find(third.id).stage).toBe('awaiting_upload');
  await service.step();
  expect(service.findRequest(input.requestKey)).toMatchObject({
    id: first.id, stage: 'succeeded', billing: { unit: 'second', requestedSeconds: 15 },
    result: { transcripts: [{ id: 'shot-04', text: '那我花九千请你俩做什么' }] },
  });
  expect(service.find(first.id).upload).toBeUndefined();
  expect(creates).toEqual([first.id, second.id, third.id]);
  expect(starts).toEqual([first.id, first.id, first.id]);
});

it('keeps warm during idle grace for consecutive jobs, skips redundant probes, and releases after grace expires', async () => {
  const db = new Database(':memory:');
  dbs.push(db);
  let now = 1_000_000;
  let status = '2';
  let getInstanceCalls = 0;
  let healthCalls = 0;
  const closeInstance = vi.fn(async () => { status = '22'; });
  const releaseInstance = vi.fn(async () => { status = '4'; });
  const setGpuIdleShutdown = vi.fn(async () => {});
  const platform = {
    getInstance: async (id: string) => {
      getInstanceCalls++;
      return { id, status,
        services: [{ host: 'asr.waas.aigate.cc', port: 18080, httpType: '1', protocol: 'HTTPS' }] };
    },
    openInstance: vi.fn(),
    closeInstance,
    releaseInstance,
    getSshConnection: vi.fn(),
    setGpuIdleShutdown,
    createInstance: vi.fn(),
    findInstancesByName: vi.fn(),
  };
  const entry = { id: 'shot-04', text: '许师傅' };
  const fetch: typeof globalThis.fetch = async (raw, init) => {
    const path = new URL(String(raw)).pathname;
    if (path === '/health') {
      healthCalls++;
      return Response.json({ ready: true });
    }
    if (path === '/v1/jobs') return Response.json({
      id: JSON.parse(String(init?.body)).id, status: 'awaiting_upload', uploadToken: 'upload-token',
    });
    return Response.json({ id: path.split('/')[3], status: 'succeeded', results: [entry] });
  };
  const errors: unknown[] = [];
  const service = new AsrService(db, { workers: [], key: 'worker-key', fetch, clock: () => now, aigate: {
    ids: [], platform, idleGraceMs: 30_000, elastic: { rental: platform, templates: [
      { id: 'east2', areaName: '华东二区', imageId: '100', skuName: 'A10G-24GB', instanceId: '101' },
    ] },
  } }, 'gateway-key', error => errors.push(error));
  const job = service.create(asrJobSchema.parse({ ...source, clips: [
    { ...source.clips[0], size: 11_939_688 },
  ] })).job;
  await service.step();
  expect(service.find(job.id).stage).toBe('awaiting_upload');
  expect(db.prepare('SELECT upload_deadline - updated_at AS budget FROM aigate_asr_jobs WHERE id=?').get(job.id))
    .toEqual({ budget: 39_000 });
  expect(setGpuIdleShutdown).toHaveBeenCalledExactlyOnceWith('101');
  // While awaiting_upload, ticks must not poll AIGate or worker /health.
  const getsBeforeUploadWait = getInstanceCalls;
  const healthBeforeUploadWait = healthCalls;
  now += 5_000;
  await service.step();
  expect(getInstanceCalls).toBe(getsBeforeUploadWait);
  expect(healthCalls).toBe(healthBeforeUploadWait);
  expect(closeInstance).not.toHaveBeenCalled();
  // Confirming goes straight to the persisted endpoint without extra /health.
  service.confirm(job.id);
  await service.step();
  expect(service.find(job.id)).toMatchObject({ stage: 'succeeded', result: { transcripts: [entry] } });
  expect(healthCalls).toBe(healthBeforeUploadWait);
  expect(closeInstance).not.toHaveBeenCalled();
  // A follow-up job arriving 4 seconds later reuses the warm GPU with zero shutdowns.
  now += 4_000;
  const job2 = service.create(asrJobSchema.parse({ ...source, requestKey: 'alice-episode-2' })).job;
  await service.step();
  expect(service.find(job2.id).stage).toBe('awaiting_upload');
  expect(closeInstance).not.toHaveBeenCalled();
  service.confirm(job2.id);
  await service.step();
  expect(service.find(job2.id).stage).toBe('succeeded');
  expect(closeInstance).not.toHaveBeenCalled();
  // After 30s of true idleness, close then release.
  now += 30_000;
  await service.step();
  expect(closeInstance).toHaveBeenCalledExactlyOnceWith('101');
  expect(releaseInstance).not.toHaveBeenCalled();
  await service.step();
  expect(releaseInstance).toHaveBeenCalledExactlyOnceWith('101');
  await service.step();
  expect(db.prepare('SELECT instance_id FROM aigate_asr_templates WHERE id=?').get('east2')).toEqual({ instance_id: null });
  expect(service.find(job.id)).toMatchObject({ stage: 'succeeded', result: { transcripts: [entry] } });
  expect(errors).toEqual([]);
});

it('registers the ASR routes behind the existing gateway key', async () => {
  const db = new Database(':memory:');
  dbs.push(db);
  const app = Fastify();
  const apiKey = 'a'.repeat(32);
  app.addHook('onRequest', async (request, reply) => {
    try { assertVideoGatewayRequest(request, true, apiKey, true); }
    catch (error) {
      if (error instanceof SystemError) return reply.code(error.statusCode).send();
      throw error;
    }
  });
  registerAsrRoutes(app, new AsrService(db, options, apiKey, () => {}));
  try {
    const url = '/v1/asr/jobs';
    const denied = await app.inject({ method: 'POST', url, payload: source });
    expect(denied.statusCode).toBe(401);
    const headers = { 'x-api-key': apiKey };
    const accepted = await app.inject({ method: 'POST', url, payload: source, headers });
    expect(accepted.statusCode).toBe(202);
    const found = await app.inject({ method: 'GET', url: `${url}/by-request-key/${source.requestKey}`, headers });
    expect(found.json().id).toBe(accepted.json().id);
    const early = await app.inject({ method: 'POST', url: `${url}/${found.json().id}/inputs`, payload: {}, headers });
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('ASR_UPLOAD_NOT_READY');
  } finally { await app.close(); }
});

it('moves only unsubmitted reservations from retired instances to the replacement template', async () => {
  const db = new Database(':memory:');
  dbs.push(db);
  const fetch = (async (raw, init) => {
    const url = new URL(String(raw));
    if (url.pathname === '/health') return Response.json({ ready: true });
    const body = JSON.parse(String(init?.body));
    return Response.json({ id: body.id, status: 'awaiting_upload', uploadToken: 'upload-token' });
  }) as typeof globalThis.fetch;
  let rentals = 0;
  const platform = {
    getInstance: async (id: string) => ({ id, status: id === '13' ? '2' : '4',
      services: [{ host: 'asr.waas.aigate.cc', port: 18080, httpType: '1', protocol: 'HTTPS' }] }),
    openInstance: async () => {}, closeInstance: async () => {}, releaseInstance: async () => {},
    getSshConnection: async () => ({ host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' }),
    createInstance: async () => { rentals++; return '13'; },
    findInstancesByName: async () => ({ records: [], complete: true, pagesScanned: 1 }),
  };
  const input = asrJobSchema.parse(source);
  let service = new AsrService(db, { workers: [], key: 'worker-key', fetch, aigate: { ids: ['11', '12'], platform, scaleOutQueueDepth: 1 } },
    'gateway-key', () => {});
  const old = service.create(input).job;
  const dispatched = service.create({ ...input, requestKey: 'already-dispatched' }).job;
  await service.step();
  db.prepare('UPDATE aigate_asr_jobs SET endpoint=? WHERE id=?').run('https://old.waas.aigate.cc', dispatched.id);
  service = new AsrService(db, { workers: [], key: 'worker-key', fetch, aigate: {
    ids: [], platform, elastic: { templates: [{ id: 'east2', areaName: '华东二区', imageId: '123', skuName: '5090', instanceId: '13' }],
      rental: platform },
  } }, 'gateway-key', () => {});
  await service.step();
  expect(service.find(old.id)).toMatchObject({ stage: 'awaiting_upload', upload: {
    token: 'upload-token', files: [{ url: `https://asr.waas.aigate.cc/v1/jobs/${old.id}/audio/shot-04` }],
  } });
  expect(service.find(dispatched.id).stage).toBe('preparing');
  expect(rentals).toBe(0);
});

it.each(['open', 'rent'])('preserves the job and deadline and selects another slot after capacity rejects %s', async (rejected) => {
  const db = new Database(':memory:');
  dbs.push(db);
  const capacity = Object.assign(new Error('AIGate capacity is unavailable'), { code: 'CAPACITY_UNAVAILABLE', uncertain: false });
  const errors: unknown[] = [];
  const attempted: string[] = [];
  let reassignedDeadline: number | undefined;
  const fetch = (async (raw, init) => {
    const url = new URL(String(raw));
    expect(url.hostname).toBe('east1.waas.aigate.cc');
    if (url.pathname === '/health') return Response.json({ ready: true });
    const id = JSON.parse(String(init?.body)).id;
    reassignedDeadline = (db.prepare('SELECT upload_deadline FROM aigate_asr_jobs WHERE id=?').get(id) as { upload_deadline: number }).upload_deadline;
    return Response.json({ id, status: 'awaiting_upload', uploadToken: 'upload-token' });
  }) as typeof globalThis.fetch;
  const platform = {
    getInstance: async (id: string) => ({ id, status: id === '22' ? '2' : '22',
      services: [{ host: 'east1.waas.aigate.cc', port: 18080, httpType: '1', protocol: 'HTTPS' }] }),
    openInstance: async () => { attempted.push('open'); throw capacity; },
    closeInstance: async () => {}, releaseInstance: async () => {},
    getSshConnection: async () => ({ host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' }),
    createInstance: async () => { attempted.push('rent'); throw capacity; },
    findInstancesByName: async () => ({ records: [], complete: true, pagesScanned: 1 }),
  };
  const config = { workers: [], key: 'worker-key', fetch, aigate: {
    ids: [], platform, elastic: { rental: platform, templates: [
      { id: 'east2', areaName: '华东二区' as const, imageId: '101', skuName: '5090', ...(rejected === 'open' ? { instanceId: '21' } : {}) },
      { id: 'east1', areaName: '华东一区' as const, imageId: '102', skuName: '5090', instanceId: '22' },
    ] },
  } };
  let service = new AsrService(db, config, 'gateway-key', error => errors.push(error));
  const before = Date.now();
  const job = service.create(asrJobSchema.parse(source)).job;
  await service.step();
  expect(service.find(job.id)).toMatchObject({ stage: 'queued', error: { code: 'ASR_CAPACITY_UNAVAILABLE', providerTerminal: false } });
  const reservation = db.prepare('SELECT upload_deadline FROM aigate_asr_jobs WHERE id=?').get(job.id) as { upload_deadline: number };
  expect(reservation.upload_deadline).toBeGreaterThanOrEqual(before + 600_000);
  const second = service.create(asrJobSchema.parse({ ...source, requestKey: 'second' })).job;
  service = new AsrService(db, config, 'gateway-key', error => errors.push(error));
  await service.step();
  expect(service.find(job.id)).toMatchObject({ stage: 'awaiting_upload', upload: {
    files: [{ url: `https://east1.waas.aigate.cc/v1/jobs/${job.id}/audio/shot-04` }],
  } });
  expect(service.find(job.id).error).toBeUndefined();
  expect(reassignedDeadline).toBe(reservation.upload_deadline);
  expect(service.find(second.id).stage).toBe('queued');
  expect(attempted).toEqual([rejected]);
  expect(errors).toEqual([]);
});

it('recognizes AIGate 6001 rental rejection from the live ASR capacity contract', async () => {
  vi.stubGlobal('fetch', async () => Response.json({ code: 1, errCode: '6001', msg: '无可用资源节点,请稍后再试' }));
  try {
    const config = asrOptionsFromEnv({ AIGATE_ACCESS_TOKEN: 'token', SYSTEM_ASR_WORKER_KEY: 'worker-key',
      SYSTEM_ASR_AIGATE_TEMPLATES: JSON.stringify([{ id: 'east1', areaName: '华东一区', imageId: '123', skuName: '5090' }]) })!;
    await expect(config.aigate!.elastic!.rental.createInstance({
      areaName: '华东一区', imageId: '123', imageType: '3', skuName: '5090', count: 1,
    })).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE', uncertain: false });
  } finally { vi.unstubAllGlobals(); }
});

it('avoids cold-booting a second GPU for small bursts, pipelines on the warm GPU, and scales out on large bursts', async () => {
  const db = new Database(':memory:');
  dbs.push(db);
  let now = 2_000_000;
  const rentedAreas: string[] = [];
  let nextId = 300;
  const instances = new Map<string, string>();
  const platform = {
    getInstance: async (id: string) => ({ id, status: '2',
      services: [{ host: `${instances.get(id)}.waas.aigate.cc`, port: 18080, httpType: '1', protocol: 'HTTPS' }] }),
    openInstance: async () => {}, closeInstance: async () => {}, releaseInstance: async () => {},
    getSshConnection: async () => ({ host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' }),
    createInstance: async (req: { areaName: string }) => {
      rentedAreas.push(req.areaName);
      const id = String(++nextId);
      instances.set(id, req.areaName === '华东二区' ? 'east2' : 'east1');
      return id;
    },
    findInstancesByName: async () => ({ records: [], complete: true, pagesScanned: 1 }),
  };
  const runningJobs = new Set<string>();
  const fetch: typeof globalThis.fetch = async (raw, init) => {
    const path = new URL(String(raw)).pathname;
    if (path === '/health') return Response.json({ ready: true });
    if (path === '/v1/jobs') {
      const id = JSON.parse(String(init?.body)).id;
      return Response.json({ id, status: 'awaiting_upload', uploadToken: 'upload-token' });
    }
    const id = path.split('/')[3]!;
    if (path.endsWith('/start')) {
      runningJobs.add(id);
      return Response.json({ id, status: 'running' });
    }
    return Response.json({ id, status: runningJobs.has(id) ? 'running' : 'succeeded',
      results: [{ id: 'shot-04', text: 'ok' }] });
  };
  const errors: unknown[] = [];
  const service = new AsrService(db, { workers: [], key: 'worker-key', fetch, clock: () => now, aigate: {
    ids: [], platform, scaleOutQueueDepth: 3, elastic: { rental: platform, templates: [
      { id: 'east2', areaName: '华东二区', imageId: '101', skuNames: ['A10G-24GB'] },
      { id: 'east1', areaName: '华东一区', imageId: '102', skuNames: ['A10G-24GB'] },
    ] },
  } }, 'gateway-key', error => errors.push(error));
  const j1 = service.create(asrJobSchema.parse({ ...source, requestKey: 'ep-1' })).job;
  const j2 = service.create(asrJobSchema.parse({ ...source, requestKey: 'ep-2' })).job;
  await service.step();
  // Small burst (2 jobs): only east2 rents a GPU; east1 stays cold.
  expect(rentedAreas).toEqual(['华东二区']);
  expect(service.find(j1.id).stage).toBe('awaiting_upload');
  expect(service.find(j2.id).stage).toBe('queued');
  // Once j1 starts running on east2, j2 immediately pipelines onto warm east2 for upload!
  service.confirm(j1.id);
  await service.step();
  expect(service.find(j1.id).stage).toBe('running');
  expect(service.find(j2.id)).toMatchObject({ stage: 'awaiting_upload', upload: {
    files: [{ url: `https://east2.waas.aigate.cc/v1/jobs/${j2.id}/audio/shot-04` }],
  } });
  expect(rentedAreas).toEqual(['华东二区']);
  // Large burst: 3 more jobs queued (queuedCount=3 >= 1 * scaleOutQueueDepth) triggers east1 scale-out!
  const j3 = service.create(asrJobSchema.parse({ ...source, requestKey: 'ep-3' })).job;
  service.create(asrJobSchema.parse({ ...source, requestKey: 'ep-4' }));
  service.create(asrJobSchema.parse({ ...source, requestKey: 'ep-5' }));
  await service.step();
  expect(rentedAreas).toEqual(['华东二区', '华东一区']);
  expect(service.find(j3.id)).toMatchObject({ stage: 'awaiting_upload', upload: {
    files: [{ url: `https://east1.waas.aigate.cc/v1/jobs/${j3.id}/audio/shot-04` }],
  } });
  expect(errors).toEqual([]);
});
