import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { MioraAdapter } from '../adapters/miora-adapter.js';
import { MioraClient } from '../adapters/miora-client.js';
import { ChannelStore } from './store.js';
import { MioraUploadIntentStore } from './miora-upload-intents.js';

test('Miora intent routes accept large declarations and more than fifteen references while retaining validation and ownership', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'miora-intent-route-'));
  const originalConfig = { ...config };
  const db = new Database(':memory:');
  let app: FastifyInstance | undefined;
  const key = 'isolated-intent-api-key-at-least-32-characters';
  try {
    Object.assign(config, {
      dataDir: path.join(directory, 'data'), apiKey: key, mioraProxyUrl: 'http://127.0.0.1:1',
      hailuoTokenFile: path.join(directory, 'tokens.txt'), dreamMakerAccountFile: path.join(directory, 'dreammaker.txt'),
      higgsfieldAccountFile: path.join(directory, 'higgsfield.txt'), mioraAccountFile: path.join(directory, 'miora.txt'),
      mioraImportDir: path.join(directory, 'imports'),
    });
    await mkdir(config.mioraImportDir);
    await Promise.all([config.hailuoTokenFile, config.dreamMakerAccountFile, config.higgsfieldAccountFile, config.mioraAccountFile].map(file => writeFile(file, '')));
    const jwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ sub: 'isolated-intent-user', exp: 4102444800 })).toString('base64url') + '.fake';
    const channels = new ChannelStore(db, Buffer.alloc(32, 23).toString('base64'));
    channels.import(jwt);
    const credits = { totalCredits: 1000, breakdown: [] };
    vi.spyOn(MioraAdapter.prototype, 'getCreditsFromCookies').mockResolvedValue(credits);
    const generation = vi.spyOn(MioraAdapter.prototype, 'runWithoutBrowser').mockRejectedValue(new Error('Generation is forbidden'));
    const grant = vi.spyOn(MioraClient.prototype, 'getCosGrant').mockResolvedValue({
      prefix: 'isolated-prefix', bucket: 'isolated-bucket', region: 'ap-test', token: 'isolated-sts-token', secret_id: 'isolated-id', secret_key: 'isolated-secret'
    });
    const network = vi.fn(async () => { throw new Error('External network is forbidden'); });
    vi.stubGlobal('fetch', network);
    app = await buildApp({ managedChannels: channels, managedGateway: true, warmup: false,
      managedAccountCreditReader: async () => credits });
    await app.ready();
    const headers = { 'x-api-key': key };
    const assets = Array.from({ length: 16 }, (_, index) => ({
      sha256: (index + 1).toString(16).padStart(64, '0'), size: 128 * 1024 * 1024,
      mimeType: 'video/mp4', kind: 'video', fileName: `reference-${index}.mp4`
    }));
    const payload = { idempotencyKey: 'isolated-large-intent-key', assets };
    const created = await app.inject({ method: 'POST', url: '/v1/upload-intents', headers, payload });
    expect(created.statusCode).toBe(201);
    const intent = created.json<{ id: string; items: Array<{ upload: { headers: Record<string, string> } }> }>();
    expect(intent.items).toHaveLength(16);
    expect(intent.items[0]?.upload.headers['content-length']).toBe(String(128 * 1024 * 1024));
    expect(grant).toHaveBeenCalledTimes(16);
    const complete = await app.inject({ method: 'POST', url: `/v1/upload-intents/${intent.id}/complete`, headers,
      payload: { indexes: Array.from({ length: 16 }, (_, index) => index) } });
    expect(complete.statusCode).toBe(200);
    expect(complete.json()).toMatchObject({ status: 'ready' });
    for (const size of [-1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await app.inject({ method: 'POST', url: '/v1/upload-intents', headers,
        payload: { ...payload, assets: [{ ...assets[0], size }] } });
      expect(invalid.statusCode, `invalid size ${size}`).toBe(400);
    }
    for (const index of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await app.inject({ method: 'POST', url: `/v1/upload-intents/${intent.id}/complete`, headers,
        payload: { indexes: [index] } })).statusCode).toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/v1/upload-intents', headers: { 'x-api-key': 'wrong-key' }, payload })).statusCode).toBe(401);
    expect(() => new MioraUploadIntentStore(db, key + '-rotated').describe(intent.id)).toThrow('unavailable');
    expect(db.prepare('SELECT COUNT(*) AS count FROM video_gateway_jobs').get()).toEqual({ count: 0 });
    expect(generation).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  } finally {
    await app?.close();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); Object.assign(config, originalConfig);
    db.close(); await rm(directory, { recursive: true, force: true });
  }
});
