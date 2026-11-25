import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { assertVideoGatewayRequest } from '../system-channels/video-gateway.js';
import { SystemError } from '../system/types.js';
import { registerAsrRoutes } from './routes.js';
import { AsrService, asrJobSchema } from './service.js';

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
  await service.step();
  expect(service.findRequest(input.requestKey)).toMatchObject({
    id: first.id, stage: 'succeeded', billing: { unit: 'second', requestedSeconds: 15 },
    result: { transcripts: [{ id: 'shot-04', text: '那我花九千请你俩做什么' }] },
  });
  expect(service.find(first.id).upload).toBeUndefined();
  expect(creates).toEqual([first.id, second.id]);
  expect(starts).toEqual([first.id, first.id, first.id]);
  await service.step();
  expect(service.find(third.id).stage).toBe('awaiting_upload');
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
    openInstance: async () => {}, closeInstance: async () => {},
    getSshConnection: async () => ({ host: 'ssh.waas.aigate.cc', port: 1234, username: 'root', password: 'test' }),
    createInstance: async () => { rentals++; return '13'; },
    findInstancesByName: async () => ({ records: [], complete: true, pagesScanned: 1 }),
  };
  const input = asrJobSchema.parse(source);
  let service = new AsrService(db, { workers: [], key: 'worker-key', fetch, aigate: { ids: ['11', '12'], platform } },
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
