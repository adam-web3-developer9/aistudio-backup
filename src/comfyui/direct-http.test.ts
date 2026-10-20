import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { ChannelStore } from '../system-channels/store.js';
import type { ComfyService } from './service.js';
import type { ComfyPoolConfiguration } from './configuration.js';

vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: vi.fn(async () => { throw new Error('Unexpected provider request'); }) }));

test('authenticated direct HTTP lifecycle keeps uploads and collected video off the gateway with durable idempotent receipts', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'comfy-direct-http-'));
  const original = { ...config };
  const db = new Database(path.join(directory, 'gateway.sqlite'));
  let app: FastifyInstance | undefined;
  const key = 'direct-http-gateway-key-at-least-32-characters';
  const token = 'private-direct-http-platform-token';
  const instanceId = '1096727553686249472';
  let completed = false;
  let submitted = 0;
  const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.host === 'waas.aigate.cc') {
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer ' + token });
      if (url.pathname === '/api/openapi/instance/setTimerStop') {
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe('{"instanceId":' + instanceId + ',"stopType":"2","utilizationRate":10,"leisureTime":30}');
        return Response.json({ code: 0, data: true });
      }
      expect(url.searchParams.get('instanceId')).toBe(instanceId);
      if (url.pathname === '/api/openapi/instance/status') return Response.json({ code: 0, data: '2' });
      if (url.pathname === '/api/openapi/instance/get') return Response.json({ code: 0, data: {
        instanceId, instanceStatus: '2', operationStatus: '2', areaName: '华东二区', instanceUtilList: []
      } });
      throw new Error('Unexpected platform request: ' + url.pathname);
    }
    expect(url.host).toBe('direct-native.example.invalid');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    if (url.pathname === '/system_stats') return Response.json({ system: {}, devices: [{ name: 'NVIDIA GeForce RTX 5090' }] });
    if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] });
    if (url.pathname === '/prompt') {
      submitted++;
      const payload = JSON.parse(String(init?.body));
      expect(payload.prompt['1'].inputs.image).toBe(payload.extra_data.hailuoAttemptId + '/frame.png');
      expect(payload.prompt['2'].inputs).toEqual({ image: ['1', 0], text: 'trusted direct prompt', filename_prefix: payload.extra_data.hailuoAttemptId });
      return Response.json({ prompt_id: payload.prompt_id });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      return Response.json(completed ? { [id]: { status: { completed: true, status_str: 'success' }, outputs: {
        '2': { gifs: [{ filename: 'result final.mp4', subfolder: 'native output', type: 'output' }] }
      } } } : {});
    }
    throw new Error('Unexpected native request: ' + url.pathname);
  });
  const configuration: ComfyPoolConfiguration = {
    autoOpen: false, pollIntervalMs: 60_000, bootTimeoutMs: 60_000, jobTimeoutMs: 120_000,
    instances: [{ id: instanceId, baseUrl: 'https://direct-native.example.invalid', headers: {},
      areaName: '华东二区', gpuModel: '5090', workflowIds: ['direct-http'] }],
    workflows: [{ id: 'direct-http', version: 'fixture-v1', graph: {
      '1': { class_type: 'LoadImage', inputs: { image: '' } },
      '2': { class_type: 'FixtureVideo', inputs: { image: ['1', 0], text: '', filename_prefix: '' } }
    }, bindings: {
      image: { nodeId: '1', input: 'image', kind: 'media', required: true },
      prompt: { nodeId: '2', input: 'text', kind: 'value', required: true },
      output: { nodeId: '2', input: 'filename_prefix', kind: 'output-prefix', required: true }
    }, outputNodeIds: ['2'] }]
  };
  try {
    Object.assign(config, { dataDir: path.join(directory, 'data'), apiKey: key, mioraProxyUrl: 'http://127.0.0.1:1',
      hailuoTokenFile: path.join(directory, 'tokens.txt'), dreamMakerAccountFile: path.join(directory, 'dreammaker.txt'),
      higgsfieldAccountFile: path.join(directory, 'higgsfield.txt'), mioraAccountFile: path.join(directory, 'miora.txt'), mioraImportDir: path.join(directory, 'imports') });
    await mkdir(config.mioraImportDir);
    await Promise.all([config.hailuoTokenFile, config.dreamMakerAccountFile, config.higgsfieldAccountFile, config.mioraAccountFile].map(file => writeFile(file, '')));
    app = await buildApp({ managedChannels: new ChannelStore(db, Buffer.alloc(32, 1).toString('base64')),
      managedGateway: true, warmup: false, comfyui: { configuration, token, fetch: network as typeof fetch } });
    await app.ready();
    const service = (app as unknown as { channelRuntime: { comfy: ComfyService } }).channelRuntime.comfy;
    const assetRead = vi.spyOn(service.options.assets, 'read').mockRejectedValue(new Error('Direct input must not read gateway assets'));
    const resultSave = vi.spyOn(service.options.results, 'save').mockRejectedValue(new Error('Direct result must not be saved by the gateway'));
    const resultRead = vi.spyOn(service.options.results, 'read').mockRejectedValue(new Error('Direct result must not be streamed by the gateway'));
    const headers = { 'x-api-key': key };
    const body = { adapterId: 'comfyui-v1', requestKey: 'direct-http-one', workflowId: 'direct-http', transport: 'direct',
      values: { prompt: 'trusted direct prompt' }, media: {}, directMedia: {
        image: { filename: 'frame.png', contentType: 'image/png', sha256: 'a'.repeat(64) }
      } };
    expect((await app.inject({ method: 'POST', url: '/v1/jobs', payload: body })).statusCode).toBe(401);
    const { sha256: _sha256, ...unsigned } = body.directMedia.image;
    const invalid = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { ...body, directMedia: { image: unsigned } } });
    expect(invalid.statusCode).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS count FROM comfy_jobs').get()).toEqual({ count: 0 });
    expect(submitted).toBe(0);

    const accepted = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: body });
    expect(accepted.statusCode).toBe(202);
    const id = accepted.json().jobId as string;
    expect(service.get(id)).toMatchObject({ stage: 'queued', instance_id: null });
    const replay = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: body });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().jobId).toBe(id);
    await service.tick();
    expect((await app.inject({ method: 'GET', url: '/v1/jobs/' + id })).statusCode).toBe(401);
    const manifest = await app.inject({ method: 'GET', url: '/v1/jobs/' + id, headers });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json()).toMatchObject({ id, stage: 'awaiting_upload', upload: {
      baseUrl: 'https://direct-native.example.invalid', subfolder: id,
      files: [{ binding: 'image', ...body.directMedia.image }]
    } });
    expect(manifest.body).not.toContain(token);
    expect(manifest.body).not.toContain('trusted direct prompt');
    expect(submitted).toBe(0);

    const inputs = { inputs: { image: { name: 'frame.png', subfolder: id, type: 'input' } } };
    for (const unauthorized of [{}, { 'x-api-key': 'incorrect-key' }]) {
      expect((await app.inject({ method: 'POST', url: '/v1/jobs/' + id + '/inputs', headers: unauthorized, payload: inputs })).statusCode).toBe(401);
    }
    expect(service.get(id)).toMatchObject({ stage: 'awaiting_upload', direct_inputs: null });
    const acknowledged = await app.inject({ method: 'POST', url: '/v1/jobs/' + id + '/inputs', headers, payload: inputs });
    expect(acknowledged.statusCode).toBe(200);
    expect(acknowledged.json()).toMatchObject({ id, stage: 'preparing' });
    const receipt = service.get(id).direct_inputs;
    const repeatedInputs = await app.inject({ method: 'POST', url: '/v1/jobs/' + id + '/inputs', headers,
      payload: { inputs: { image: { type: 'input', subfolder: id, name: 'frame.png' } } } });
    expect(repeatedInputs.statusCode).toBe(200);
    expect(repeatedInputs.json()).toMatchObject({ id, stage: 'preparing', progress: { upload: { completed: 1, total: 1 } } });
    expect(service.get(id).direct_inputs).toBe(receipt);
    await service.tick();
    expect(submitted).toBe(1);
    completed = true;
    await service.tick();
    const succeeded = await app.inject({ method: 'GET', url: '/v1/jobs/' + id, headers });
    expect(succeeded.statusCode).toBe(200);
    expect(succeeded.json()).toMatchObject({ id, stage: 'succeeded', status: 'succeeded' });
    expect(succeeded.json().events).toEqual(service.store.events.recent(id, 12));
    expect(succeeded.json().events.length).toBeLessThanOrEqual(12);
    const nativeUrl = new URL(succeeded.json().result.videoUrl);
    expect(nativeUrl.origin + nativeUrl.pathname).toBe('https://direct-native.example.invalid/view');
    expect(Object.fromEntries(nativeUrl.searchParams)).toEqual({ filename: 'result final.mp4', subfolder: 'native output', type: 'output' });
    expect(service.get(id).result_pending).toBe(1);
    expect((await app.inject({ method: 'GET', url: '/v1/jobs/' + id + '/result' })).statusCode).toBe(401);
    const noProxy = await app.inject({ method: 'GET', url: '/v1/jobs/' + id + '/result', headers });
    expect(noProxy.statusCode).toBe(409);
    expect(noProxy.json()).toMatchObject({ error: { code: 'COMFY_DIRECT_RESULT' } });
    expect(noProxy.headers['content-type']).toContain('application/json');

    for (const unauthorized of [{}, { 'x-api-key': 'incorrect-key' }]) {
      expect((await app.inject({ method: 'POST', url: '/v1/jobs/' + id + '/collected', headers: unauthorized })).statusCode).toBe(401);
    }
    expect(service.get(id).result_pending).toBe(1);
    const collected = await app.inject({ method: 'POST', url: '/v1/jobs/' + id + '/collected', headers });
    expect(collected.statusCode).toBe(200);
    expect(collected.json()).toMatchObject({ id, stage: 'succeeded' });
    expect(service.get(id).result_pending).toBe(0);
    const collectedAgain = await app.inject({ method: 'POST', url: '/v1/jobs/' + id + '/collected', headers });
    expect(collectedAgain.statusCode).toBe(200);
    expect(collectedAgain.json()).toMatchObject({ id, stage: 'succeeded', status: 'succeeded',
      result: collected.json().result, progress: { phase: 'succeeded',
        providerJobId: collected.json().progress.providerJobId, upload: { completed: 1, total: 1 } } });
    expect(service.get(id).result_pending).toBe(0);

    const eventsUrl = '/v1/jobs/' + id + '/events';
    for (const unauthorized of [{}, { 'x-api-key': 'incorrect-key' }]) {
      expect((await app.inject({ method: 'GET', url: eventsUrl + '?after=0&limit=2', headers: unauthorized })).statusCode).toBe(401);
    }
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      for (const requestHeaders of [{}, headers]) {
        expect((await app.inject({ method, url: eventsUrl, headers: requestHeaders })).statusCode).toBe(404);
      }
    }
    const expectedEvents = service.store.events.list({ jobId: id, limit: 100 });
    expect(expectedEvents.length).toBeGreaterThan(2);
    const receivedEvents: typeof expectedEvents = [];
    let after = 0;
    for (let offset = 0; offset < expectedEvents.length; offset += 2) {
      const response = await app.inject({ method: 'GET', url: eventsUrl + '?after=' + after + '&limit=2', headers });
      expect(response.statusCode).toBe(200);
      const page = response.json();
      expect(page.events).toEqual(expectedEvents.slice(offset, offset + 2));
      expect(page.nextAfter).toBe(page.events.at(-1).sequence);
      expect(page.nextAfter).toBeGreaterThan(after);
      expect(response.body).not.toContain(token);
      expect(response.body).not.toContain('trusted direct prompt');
      receivedEvents.push(...page.events);
      after = page.nextAfter;
    }
    expect(receivedEvents).toEqual(expectedEvents);
    const exhausted = await app.inject({ method: 'GET', url: eventsUrl + '?after=' + after + '&limit=2', headers });
    expect(exhausted.statusCode).toBe(200);
    expect(exhausted.json()).toEqual({ events: [], nextAfter: after });
    await service.tick();
    expect(submitted).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM comfy_jobs').get()).toEqual({ count: 1 });
    expect(service.store.pendingResults(instanceId)).toEqual([]);
    expect(await readdir(path.join(config.dataDir, 'jobs'))).toEqual([]);
    for (const operation of [assetRead, resultSave, resultRead]) expect(operation).not.toHaveBeenCalled();
    const paths = network.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input.toString()).pathname);
    expect(paths.filter(requestPath => requestPath === '/api/openapi/instance/setTimerStop')).toHaveLength(1);
    expect(paths).toContain('/api/openapi/instance/get');
    expect(paths).toContain('/api/openapi/instance/status');
    expect(paths.some(requestPath => requestPath.startsWith('/upload') || requestPath === '/view')).toBe(false);
  } finally {
    await app?.close();
    db.close();
    Object.assign(config, original);
    vi.restoreAllMocks();
    const target = path.resolve(directory);
    if (!target.startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(target).startsWith('comfy-direct-http-')) throw new Error('Unsafe test cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
