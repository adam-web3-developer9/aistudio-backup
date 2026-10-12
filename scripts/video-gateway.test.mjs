import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSystemWebApp } from '../dist/system/web-app.js';
import { config } from '../dist/config.js';
import { MioraAdapter } from '../dist/adapters/miora-adapter.js';
import { BrowserPool } from '../dist/browser/browser-pool.js';
import { useMioraProxy } from '../dist/adapters/miora-api.js';

test('managed Miora gateway matches desktop upload/submit/query with no provider calls', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'managed-video-gateway-test-'));
  const originalConfig = { ...config };
  const originalFetch = globalThis.fetch;
  const originalCredits = MioraAdapter.prototype.getCreditsFromCookies;
  const originalRun = MioraAdapter.prototype.runWithoutBrowser;
  const originalWarmup = BrowserPool.prototype.initialize;
  const key = 'isolated-video-gateway-api-key-at-least-32-characters';
  let current, providerCalls = 0;
  const origin = 'http://127.0.0.1:3001';
  const options = {
    databasePath: path.join(directory, 'system.sqlite'),
    secret: 'isolated-gateway-system-secret-more-than-32-characters', baseUrl: origin,
    mailer: { sendVerification: async () => {}, sendPasswordReset: async () => {} },
    testMode: true, credentialKey: Buffer.alloc(32, 91).toString('base64'),
    channelsEnabled: true, videoGatewayEnabled: true, mediaDirectory: path.join(directory, 'private'),
  };
  try {
    Object.assign(config, {
      apiKey: key, dataDir: path.join(directory, 'gateway'),
      hailuoTokenFile: path.join(directory, 'tokens.txt'), dreamMakerAccountFile: path.join(directory, 'dreammaker.txt'),
      higgsfieldAccountFile: path.join(directory, 'higgsfield.txt'), mioraAccountFile: path.join(directory, 'miora.txt'),
      mioraImportDir: path.join(directory, 'imports'), hailuoProxyUrl: undefined, mioraProxyUrl: 'http://127.0.0.1:1', mioraProxyAddress: undefined,
    });
    await mkdir(config.mioraImportDir);
    await Promise.all([config.hailuoTokenFile, config.dreamMakerAccountFile, config.higgsfieldAccountFile, config.mioraAccountFile].map(file => writeFile(file, '')));
    globalThis.fetch = async () => { throw new Error('External requests are forbidden in this isolated test'); };
    BrowserPool.prototype.initialize = async () => { throw new Error('Browser warmup is unnecessary for managed Miora'); };
    MioraAdapter.prototype.getCreditsFromCookies = async () => ({ totalCredits: 1000, breakdown: [] });
    MioraAdapter.prototype.runWithoutBrowser = async (_cookies, input) => {
      assert.equal(input.allowPaidRetries, false);
      await input.beforeSubmit();
      providerCalls++;
      return { videoUrl: 'https://isolated.miora.design/fake-result.mp4', privateCredential: 'must-not-appear' };
    };
    current = await buildSystemWebApp(options);
    const headers = { 'x-api-key': key };
    assert.equal((await current.app.inject({ url: '/health' })).json().videoGatewayEnabled, true);
    assert.equal((await current.app.inject({ url: '/v1/jobs' })).statusCode, 401);
    assert.equal((await current.app.inject({ url: '/v1/jobs', headers: { 'x-api-key': 'wrong-key' } })).statusCode, 401);
    for (const url of ['/v1/accounts', '/v1/credits', '/v1/sessions', '/v1/jobs/job_system_private']) {
      assert.equal((await current.app.inject({ url, headers })).statusCode, 404);
    }
    const multipart = Buffer.concat([
      Buffer.from('--isolated-boundary\r\nContent-Disposition: form-data; name="file"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n'),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('\r\n--isolated-boundary--\r\n'),
    ]);
    const uploaded = await current.app.inject({ method: 'POST', url: '/v1/assets', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=isolated-boundary' }, payload: multipart });
    assert.equal(uploaded.statusCode, 201, uploaded.body);
    assert.ok(uploaded.json().id);
    assert.equal(uploaded.json().path, undefined);
    const payload = { adapterId: 'miora-v1', assetId: uploaded.json().id, text: 'isolated prompt', options: { modelId: 'minimax-h3', resolution: '768P', durationSeconds: 5 } };
    assert.equal((await current.app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { ...payload, assetId: '' } })).json().error.code, 'ASSET_NOT_FOUND');
    const noAccount = await current.app.inject({ method: 'POST', url: '/v1/jobs', headers, payload });
    assert.equal(noAccount.json().error.code, 'NO_ACCOUNTS_AVAILABLE');
    const token = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ sub: 'isolated-gateway-account', exp: 4102444800 })).toString('base64url') + '.fake';
    const managed = current.channels.import(token, 'Isolated account');
    current.channels.update(managed.id, { enabled: true });
    const legacy = current.app.channelRuntime;
    const privateAsset = await legacy.assets.save({ originalName: 'private.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
    assert.equal((await current.app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { ...payload, assetId: privateAsset.id } })).json().error.code, 'ASSET_NOT_FOUND');
    assert.equal((await current.app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { ...payload, sessionId: managed.id } })).statusCode, 400);
    assert.equal((await current.app.inject({ method: 'POST', url: '/v1/jobs', headers, payload: { ...payload, adapterId: 'demo' } })).statusCode, 400);
    const created = await current.app.inject({ method: 'POST', url: '/v1/jobs', headers, payload });
    assert.equal(created.statusCode, 202, created.body);
    const id = created.json().jobId;
    let result;
    for (let attempt = 0; attempt < 100; attempt++) {
      result = await current.app.inject({ url: `/v1/jobs/${id}`, headers });
      if (result.json().status === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(result.json().status, 'succeeded', result.body);
    assert.equal(result.json().result.videoUrl, 'https://isolated.miora.design/fake-result.mp4');
    for (const value of ['must-not-appear', token, 'isolated prompt', managed.id]) assert.equal(result.body.includes(value), false);
    assert.equal(providerCalls, 1);
    assert.equal((await current.app.inject({ url: '/v1/jobs', headers })).json().total, 1);
    await legacy.jobs.flush();
    assert.equal(JSON.parse(await readFile(path.join(config.dataDir, 'jobs', `${id}.json`), 'utf8')).status, 'succeeded');
    await current.app.close(); current = undefined;
    current = await buildSystemWebApp(options);
    assert.equal((await current.app.inject({ url: `/v1/jobs/${id}`, headers })).json().result.videoUrl, 'https://isolated.miora.design/fake-result.mp4');
    assert.equal(providerCalls, 1, 'Restart must retain the original result without another generation');
    current.channels.update(managed.id, { enabled: false });
    const disabled = await current.app.inject({ method: 'POST', url: '/v1/jobs', headers, payload });
    assert.equal(disabled.json().error.code, 'NO_ACCOUNTS_AVAILABLE');
    await current.app.close(); current = undefined;
    current = await buildSystemWebApp({ ...options, videoGatewayEnabled: false });
    assert.equal((await current.app.inject({ url: '/v1/jobs', headers })).statusCode, 404);
    await current.app.close(); current = undefined;
    config.apiKey = undefined;
    await assert.rejects(buildSystemWebApp(options), /API key/i);
  } finally {
    await current?.app.close();
    globalThis.fetch = originalFetch;
    MioraAdapter.prototype.getCreditsFromCookies = originalCredits;
    MioraAdapter.prototype.runWithoutBrowser = originalRun;
    BrowserPool.prototype.initialize = originalWarmup;
    Object.assign(config, originalConfig);
    useMioraProxy();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith('managed-video-gateway-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});
