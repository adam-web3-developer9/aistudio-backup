import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { ChannelStore } from '../system-channels/store.js';
import type { ComfyService } from './service.js';
import type { ComfyPoolConfiguration } from './configuration.js';
import { MemorySystemMailer } from '../system/index.js';
import { buildSystemWebApp } from '../system/web-app.js';

vi.mock('undici', async original => ({ ...await original<typeof import('undici')>(), fetch: vi.fn(async () => { throw new Error('Unexpected provider request'); }) }));

test.each([false, true])('system shutdown releases the ComfyUI worker before closing SQLite (startup failure: %s)', async startupFailure => {
  const directory = await mkdtemp(path.join(tmpdir(), 'comfy-system-close-'));
  const original = { ...config };
  let app: FastifyInstance | undefined;
  let db: Database.Database | undefined;
  const order: string[] = [];
  const configuration: ComfyPoolConfiguration = {
    autoOpen: false, pollIntervalMs: 60_000, bootTimeoutMs: 60_000, jobTimeoutMs: 120_000,
    instances: [], workflows: [],
  };
  try {
    Object.assign(config, { dataDir: path.join(directory, 'data'), apiKey: 'system-close-test-key-at-least-32-characters', mioraProxyUrl: 'http://127.0.0.1:1',
      hailuoTokenFile: path.join(directory, 'tokens.txt'), dreamMakerAccountFile: path.join(directory, 'dreammaker.txt'),
      higgsfieldAccountFile: path.join(directory, 'higgsfield.txt'), mioraAccountFile: path.join(directory, 'miora.txt'), mioraImportDir: path.join(directory, 'imports') });
    await mkdir(config.mioraImportDir);
    await Promise.all([config.hailuoTokenFile, config.dreamMakerAccountFile, config.higgsfieldAccountFile, config.mioraAccountFile].map(file => writeFile(file, '')));
    const building = buildSystemWebApp({ databasePath: path.join(directory, 'system.sqlite'), mediaDirectory: path.join(directory, 'media'),
      secret: 'isolated-system-close-test-secret-at-least-32-characters', baseUrl: 'http://127.0.0.1:3001', mailer: new MemorySystemMailer(), testMode: true,
      channelsEnabled: true, videoGatewayEnabled: true, credentialKey: Buffer.alloc(32, 1).toString('base64'),
      comfyui: { configuration, token: 'unused-test-token', fetch: vi.fn(async () => { throw new Error('Unexpected ComfyUI request'); }) },
      beforeReady: async instance => {
        app = instance;
        const service = (instance as unknown as { channelRuntime: { comfy: ComfyService } }).channelRuntime.comfy;
        db = service.store.db;
        await service.tick();
        expect(db.prepare('SELECT COUNT(*) AS count FROM comfy_worker').get()).toEqual({ count: 1 });
        const releaseWorker = service.store.releaseWorker.bind(service.store);
        vi.spyOn(service.store, 'releaseWorker').mockImplementation(owner => {
          expect(db!.open).toBe(true);
          releaseWorker(owner);
          expect(db!.prepare('SELECT COUNT(*) AS count FROM comfy_worker').get()).toEqual({ count: 0 });
          order.push('worker');
        });
        const closeDatabase = db.close.bind(db);
        vi.spyOn(db, 'close').mockImplementation(() => {
          order.push('database');
          return closeDatabase();
        });
        if (startupFailure) throw new Error('Isolated startup failure');
      },
    });
    if (startupFailure) await expect(building).rejects.toThrow('Isolated startup failure');
    else {
      const state = await building;
      await expect(state.app.close()).resolves.toBeUndefined();
      await state.runtime.close();
    }
    expect(order).toEqual(['worker', 'database']);
    expect(db!.open).toBe(false);
  } finally {
    await app?.close().catch(() => {});
    if (db?.open) db.close();
    Object.assign(config, original);
    vi.restoreAllMocks();
    const target = path.resolve(directory);
    if (!target.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});

test('authenticated gateway uses SQL for ComfyUI submission, query, list, cancellation and private result retrieval', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'comfy-app-'));
  const original = { ...config };
  const db = new Database(':memory:');
  let app: FastifyInstance | undefined;
  const key = 'comfy-gateway-test-key-at-least-32-characters';
  const token = 'private-platform-token';
  let completed = false;
  let submitted = 0;
  const network = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    if (url.host === 'waas.aigate.cc') {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      if (url.pathname === '/api/openapi/instance/setTimerStop') return Response.json({ code: 0, ok: true, data: null });
      expect(url.pathname).toBe('/api/openapi/instance/status');
      return Response.json({ code: 0, ok: true, data: '2' });
    }
    expect(url.host).toBe('comfy.example.invalid');
    if (url.pathname === '/system_stats') return Response.json({ system: {}, devices: [{ name: 'NVIDIA GeForce RTX 5090' }] });
    if (url.pathname === '/queue') return Response.json({ queue_running: [], queue_pending: [] });
    if (url.pathname === '/prompt') {
      submitted++;
      const body = JSON.parse(String(init?.body));
      expect(body.prompt['1'].inputs.text).toBe('trusted input prompt');
      return Response.json({ prompt_id: body.prompt_id });
    }
    if (url.pathname.startsWith('/history/')) {
      const id = decodeURIComponent(url.pathname.slice('/history/'.length));
      return Response.json(completed ? { [id]: { status: { completed: true, status_str: 'success' }, outputs: {
        '2': { gifs: [{ filename: 'result.mp4', subfolder: '', type: 'output' }] },
      } } } : {});
    }
    if (url.pathname === '/view') return new Response(Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]));
    throw new Error(`Unexpected test request: ${url.pathname}`);
  });
  const configuration: ComfyPoolConfiguration = {
    autoOpen: false, pollIntervalMs: 60_000, bootTimeoutMs: 60_000, jobTimeoutMs: 120_000,
    instances: [{ id: '1096727553686249472', baseUrl: 'https://comfy.example.invalid', workflowIds: ['tested-workflow'] }],
    workflows: [{ id: 'tested-workflow', version: 'fixture-v1', graph: {
      '1': { class_type: 'FixturePrompt', inputs: { text: '' } },
      '2': { class_type: 'FixtureVideo', inputs: { text: ['1', 0] } },
    }, bindings: { prompt: { nodeId: '1', input: 'text', required: true } }, outputNodeIds: ['2'] }],
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
    const result = { hash: 'a'.repeat(64), size: 12, mime: 'video/mp4' as const };
    vi.spyOn(service.options.results, 'save').mockResolvedValue(result);
    vi.spyOn(service.options.results, 'read').mockImplementation(async () => Readable.from([Buffer.alloc(12)]));
    const headers = { 'x-api-key': key };
    const body = { adapterId: 'comfyui-v1', requestKey: 'attempt-one', workflowId: 'tested-workflow', values: { prompt: 'trusted input prompt' }, media: {} };
    expect((await app.inject({ method: 'POST', url: '/v1/jobs', payload: body })).statusCode).toBe(401);
    const accepted = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: body });
    expect(accepted.statusCode).toBe(202);
    const id = accepted.json().jobId as string;
    const repeated = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: body });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json().jobId).toBe(id);
    expect((await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { ...body, values: { prompt: 'different' } } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${id}/result`, headers })).statusCode).toBe(409);
    await service.tick();
    expect(submitted).toBe(1);
    const registeredProfiles = service.options.configuration.workflows;
    service.options.configuration.workflows = [];
    const oldRequest = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: body });
    expect(oldRequest.statusCode).toBe(200);
    expect(oldRequest.json().jobId).toBe(id);
    service.options.configuration.workflows = registeredProfiles;
    const running = await app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers });
    expect(running.json()).toMatchObject({ status: 'running', adapterId: 'comfyui-v1' });
    expect(running.body).not.toContain('trusted input prompt');
    expect(running.body).not.toContain(token);
    const listed = await app.inject({ method: 'GET', url: '/v1/jobs?status=running', headers });
    expect(listed.json()).toMatchObject({ total: 1, jobs: [{ id }] });
    expect(await readdir(path.join(config.dataDir, 'jobs'))).toEqual([]);
    completed = true;
    await service.tick();
    await vi.waitFor(() => expect(service.get(id).stage).toBe('succeeded'));
    const succeeded = await app.inject({ method: 'GET', url: `/v1/jobs/${id}`, headers });
    expect(succeeded.json().result.videoUrl).toBe(`/v1/jobs/${id}/result`);
    expect((await app.inject({ method: 'GET', url: `/v1/jobs/${id}/result` })).statusCode).toBe(401);
    const download = await app.inject({ method: 'GET', url: `/v1/jobs/${id}/result`, headers });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('video/mp4');
    const next = await app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { ...body, requestKey: 'attempt-two' } });
    const cancelled = await app.inject({ method: 'POST', url: `/v1/jobs/${next.json().jobId}/cancel`, headers });
    expect(cancelled.json()).toMatchObject({ status: 'failed', stage: 'cancelled', remoteStopped: false });
    await service.tick();
    expect(submitted).toBe(1);
  } finally {
    await app?.close();
    db.close();
    Object.assign(config, original);
    vi.restoreAllMocks();
    const target = path.resolve(directory);
    if (!target.startsWith(path.resolve(tmpdir()) + path.sep)) throw new Error('Unsafe test cleanup path');
    await rm(target, { recursive: true, force: true });
  }
});
