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
import { fetch as providerFetch } from 'undici';
vi.mock('undici', async importOriginal => ({
  ...await importOriginal<typeof import('undici')>(), fetch:vi.fn(async () => { throw new Error('External provider network is forbidden'); })
}));

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
    // Aggregate declaration is >2MiB, while every independently checked frame is small.
    const many = Array.from({ length:10000 }, (_, index) => ({ ...assets[0],
      sha256:(index + 100).toString(16).padStart(64, '0'), fileName:'r'.repeat(245) + '.mp4' }));
    expect(Buffer.byteLength(JSON.stringify(many))).toBeGreaterThan(2 * 1024 * 1024);
    const stagedBody = { idempotencyKey:'isolated-staged-intent-key', assetCount:many.length };
    const staged = await app.inject({ method:'POST', url:'/v1/upload-intents/staged', headers, payload:stagedBody });
    expect(staged.statusCode).toBe(201);
    const stagedId = staged.json<{id:string}>().id;
    const url = `/v1/upload-intents/${stagedId}`;
    expect(staged.json()).toMatchObject({ protocol:'staged', status:'declaring', declaredCount:0 });
    expect((await app.inject({ method:'GET', url:`${url}/items?limit=3`, headers })).statusCode).toBe(409);
    expect((await app.inject({ method:'POST', url:`${url}/finalize`, headers, payload:{} })).statusCode).toBe(409);
    expect((await app.inject({ method:'POST', url:'/v1/upload-intents/staged', headers,
      payload:{...stagedBody,assetCount:many.length + 1} })).statusCode).toBe(409);
    for (let offset = 0; offset < many.length; offset += 250) {
      const window = { offset, assets:many.slice(offset, offset + 250) };
      const appended = await app.inject({ method:'PUT', url:`${url}/manifest`, headers, payload:window });
      expect(appended.statusCode).toBe(200);
      expect(appended.json()).toMatchObject({ declaredCount:offset + window.assets.length, status:'declaring' });
      if (offset === 0) {
        expect((await app.inject({ method:'PUT', url:`${url}/manifest`, headers, payload:window })).statusCode).toBe(200);
        expect((await app.inject({ method:'PUT', url:`${url}/manifest`, headers,
          payload:{offset:0,assets:[{...many[0],size:1}]} })).statusCode).toBe(409);
      }
    }
    const finalized = await app.inject({ method:'POST', url:`${url}/finalize`, headers, payload:{} });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json()).toMatchObject({ status:'preparing', total:10000, manifestFinalized:true });
    expect(finalized.body.length).toBeLessThan(1024);
    const page = await app.inject({ method:'GET', url:`${url}/items?offset=9997&limit=3`, headers });
    expect(page.statusCode).toBe(200);
    expect(page.json().items.map((item:{index:number}) => item.index)).toEqual([9997,9998,9999]);
    expect(page.json().items.every((item:{upload?:unknown}) => !!item.upload)).toBe(true);
    expect(grant).toHaveBeenCalledTimes(19);
    const donePage = await app.inject({ method:'POST', url:`${url}/complete?summary=true`, headers,
      payload:{indexes:[9997,9998,9999]} });
    expect(donePage.statusCode).toBe(200);
    expect(donePage.json()).toMatchObject({ total:10000, readyCount:3 });
    expect(donePage.body.length).toBeLessThan(1024);
    const status = await app.inject({ method:'GET', url:`${url}/status`, headers });
    expect(status.statusCode).toBe(200); expect(status.body.length).toBeLessThan(1024);
    // A failed public item is not restarted by the dedicated evidence endpoint.
    const evidenceStore = new MioraUploadIntentStore(db, key);
    const evidenceId = evidenceStore.create('isolated-readonly-evidence-key', evidenceStore.plan(intent.id).accountId, [
      { ...assets[0]!, kind:'video', index:0, cosKey:'SECRET-object', publicUrl:'https://SECRET.invalid/private?signature=SECRET', status:'importing' },
      { ...assets[1]!, kind:'video', index:1, cosKey:'SECRET-object-2', publicUrl:'https://SECRET.invalid/private-2?signature=SECRET', status:'importing' }
    ]);
    evidenceStore.importFailed(evidenceId, 1, {code:'COS_PUT_HTTP',stage:'cos_put',retryable:true,httpStatus:503,
      cosCode:'InternalError',cosRequestId:'safe-cos-id'});
    const beforeEvidence = { grants:grant.mock.calls.length, network:network.mock.calls.length,
      expiresAt:evidenceStore.summary(evidenceId).expiresAt };
    const evidence = await app.inject({ method:'GET', url:`/v1/upload-intents/${evidenceId}/diagnostics`, headers });
    expect(evidence.statusCode).toBe(200);
    expect(evidence.json()).toMatchObject({ status:'failed', createdAt:expect.any(String), observedAt:expect.any(String),
      requestId:expect.any(String), items:[{index:0,status:'importing'}, {index:1,status:'failed',error:{reason:'COS_PUT_HTTP',stage:'cos_put',cosRequestId:'safe-cos-id'}}] });
    expect(evidence.body).not.toContain('SECRET');
    expect(grant).toHaveBeenCalledTimes(beforeEvidence.grants);
    expect(network).toHaveBeenCalledTimes(beforeEvidence.network);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(evidenceStore.summary(evidenceId).expiresAt).toBe(beforeEvidence.expiresAt);
    expect(evidenceStore.summary(evidenceId).status).toBe('failed');
    const longUrl = 'https://source.invalid/reference.mp4?signature=' + 's'.repeat(3 * 1024 * 1024);
    const longDeclaration = await app.inject({method:'POST',url:'/v1/upload-intents/staged',headers,
      payload:{idempotencyKey:'isolated-long-signed-url-key',assetCount:1}});
    expect(longDeclaration.statusCode).toBe(201);
    const longId = longDeclaration.json().id;
    expect((await app.inject({method:'PUT',url:`/v1/upload-intents/${longId}/manifest-stream`,headers,
      payload:{offset:0,assets:[{...many[0],publicUrl:longUrl}]}})).statusCode).toBe(200);
    // It remains unfinalized: no real source probe or transfer runs in this fixture.
    expect(providerFetch).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS count FROM video_gateway_jobs').get()).toEqual({ count: 0 });
    expect(generation).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  } finally {
    await app?.close();
    vi.restoreAllMocks(); vi.unstubAllGlobals(); Object.assign(config, originalConfig);
    db.close(); await rm(directory, { recursive: true, force: true });
  }
});
