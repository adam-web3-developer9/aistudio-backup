import { afterEach, expect, test } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyRequest } from 'fastify';
import type { JobRecord } from '../types.js';
import { ChannelStore } from './store.js';
import { assertVideoGatewayConfiguration, assertVideoGatewayProxyConfiguration, assertVideoGatewayRequest, gatewayJobIdPrefix, ManagedVideoGatewayRecords, projectGatewayJob } from './video-gateway.js';

const key = 'isolated-operator-gateway-key-at-least-32-characters';
const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const request = (method: string, url: string, supplied: unknown = key) => ({ method, url, headers: { 'x-api-key': supplied } }) as unknown as FastifyRequest;
const job = (patch: Partial<JobRecord> = {}): JobRecord => ({ id: `${gatewayJobIdPrefix}test`, adapterId: 'miora-v1', text: 'private prompt', assetId: 'asset-private', sessionId: 'managed-miora-test', status: 'queued', createdAt: '2026-10-12T00:00:00Z', ...patch });

test('gateway stays disabled by default and rejects unsafe configuration without echoing secrets', () => {
  expect(() => assertVideoGatewayConfiguration(false)).not.toThrow();
  for (const invalid of [undefined, 'too-short', ' '.repeat(40), key + '\n']) expect(() => assertVideoGatewayConfiguration(true, invalid)).toThrow('at least 32');
  expect(() => assertVideoGatewayConfiguration(true, key)).not.toThrow();
  expect(() => assertVideoGatewayRequest(request('POST', '/v1/jobs'), false, key)).toThrow(expect.objectContaining({ statusCode: 404 }));
});

test('enabled gateway requires a valid proxy while keeping proxy credentials out of errors', () => {
  expect(() => assertVideoGatewayProxyConfiguration(false)).not.toThrow();
  for (const proxy of ['http://user:secret@proxy.example.invalid:8000', 'https://proxy.example.invalid/', 'http://127.0.0.1:7890', 'http://localhost:7890', 'http://[::1]:7890']) {
    expect(() => assertVideoGatewayProxyConfiguration(true, proxy)).not.toThrow();
  }
  for (const proxy of [undefined, '', 'socks5://user:secret@proxy.example.invalid:8000', 'http:proxy.example.invalid', 'http:///proxy.example.invalid', 'http://proxy.example.invalid\\', 'http://user:secret@proxy.example.invalid:8000/path', 'http://user:secret@proxy.example.invalid:8000?private=secret', 'http://user:secret@proxy.example.invalid:8000#secret', 'http://proxy.example.invalid:99999', ' http://proxy.example.invalid:8000', 'http://']) {
    expect(() => assertVideoGatewayProxyConfiguration(true, proxy)).toThrow(expect.objectContaining({ code: 'VIDEO_GATEWAY_PROXY_CONFIGURATION_INVALID' }));
    try { assertVideoGatewayProxyConfiguration(true, proxy); } catch (error) {
      expect((error as Error).message).not.toContain('secret');
      expect((error as Error).message).not.toContain('proxy.example.invalid');
    }
  }
});

test('only the video gateway routes accept the key without needing a cookie', () => {
  for (const [method, url] of [['POST', '/v1/assets'], ['POST', '/v1/jobs'], ['GET', '/v1/jobs?status=running'], ['GET', '/v1/jobs/job_gateway_test']]) {
    expect(() => assertVideoGatewayRequest(request(method!, url!), true, key)).not.toThrow();
  }
  for (const [method, url] of [['GET', '/v1/assets'], ['GET', '/v1/accounts'], ['PUT', '/v1/sessions/a/cookies'], ['DELETE', '/v1/jobs/job_gateway_test'], ['GET', '/v1/jobs/job_system_private'], ['GET', '/v1/jobs/job_gateway_a/extra'], ['GET', '/v1/jobs/%6aob_gateway_test'], ['GET', '/v1/jobs/job_gateway_']]) {
    expect(() => assertVideoGatewayRequest(request(method!, url!), true, key)).toThrow(expect.objectContaining({ statusCode: 404 }));
  }
  for (const invalid of [undefined, '', 'wrong-key', [key], key + 'x']) {
    const value = request('GET', '/v1/jobs');
    value.headers['x-api-key'] = invalid as string | string[] | undefined;
    expect(() => assertVideoGatewayRequest(value, true, key)).toThrow(expect.objectContaining({ statusCode: 401 }));
  }
});

test('persistent resource ownership isolates system jobs and keys, with a live account guard', () => {
  const db = new Database(':memory:'); cleanup.push(() => db.close());
  const channels = new ChannelStore(db);
  db.prepare('INSERT INTO managed_channel_accounts VALUES(?,?,?,?,?,?,?,?)').run('managed-miora-test', 'test', null, 1, null, '', null, 'private-encrypted');
  const records = new ManagedVideoGatewayRecords(channels, key);
  records.ownAsset('asset-private'); records.ownJob(job().id);
  expect(records.hasAsset('asset-private')).toBe(true);
  expect(records.hasAsset('system-private')).toBe(false);
  expect(records.hasJob('job_system_private')).toBe(false);
  expect(() => records.assertExecution(job())).not.toThrow();
  const restored = new ManagedVideoGatewayRecords(channels, key);
  expect(restored.hasJob(job().id)).toBe(true);
  const rotated = new ManagedVideoGatewayRecords(channels, key + '-rotated');
  expect(rotated.hasJob(job().id)).toBe(false);
  expect(() => rotated.ownJob(job().id)).toThrow('unavailable');
  expect(() => rotated.ownAsset('asset-private')).toThrow('unavailable');
  expect(() => rotated.assertExecution(job())).toThrow('owner');
  expect(() => records.assertExecution(job({ id: 'job_system_private' }))).not.toThrow();
  expect(() => records.assertExecution(job({ sessionId: 'missing' }))).toThrow('account');
  channels.update('managed-miora-test', { enabled: false });
  expect(() => records.assertExecution(job())).toThrow('account');
  channels.update('managed-miora-test', { enabled: true, archived: true });
  expect(() => records.assertExecution(job())).toThrow('account');
  expect(JSON.stringify(db.prepare('SELECT * FROM video_gateway_jobs').all())).not.toContain(key);
});

test('job projection returns only video result and safe progress and error fields', () => {
  const videoUrl = 'https://video.miora.design/result.mp4?signature=preserved';
  const projected = projectGatewayJob(job({ status: 'failed', options: { modelId: 'private-option' }, result: { videoUrl, authToken: key, path: 'C:\\private\\asset', output: { cookie: key } },
    progress: { percent: 45, providerJobId: 'provider-123', message: key, referenceImages: [{ fileId: key, url: key }], uploadedFiles: [key], updatedAt: '' },
    error: { code: 'CONTENT_REJECTED', message: key, retryable: false, accounts: { token: key }, providerMessage: key } }));
  expect(projected).toMatchObject({ id: job().id, status: 'failed', result: { videoUrl }, progress: { percent: 45, providerJobId: 'provider-123' }, error: { code: 'CONTENT_REJECTED', retryable: false } });
  const encoded = JSON.stringify(projected);
  for (const privateValue of [key, 'private prompt', 'private-option', 'asset-private', 'managed-miora-test', 'C:\\private']) expect(encoded).not.toContain(privateValue);
  expect(projected.result).toEqual({ videoUrl });
  expect(projectGatewayJob(job({ error: { code: 'PRIVATE_CREDENTIAL_VALUE', message: key } })).error).toEqual({ code: 'VIDEO_GENERATION_FAILED', message: 'Video generation failed' });
  expect(projectGatewayJob(job({ error: { code: 'ACCOUNT_INSUFFICIENT_CREDITS', message: 'private' } })).error)
    .toMatchObject({ code:'ACCOUNT_INSUFFICIENT_CREDITS', scope:'account' });
  expect(projectGatewayJob(job({ error: { code: 'INSUFFICIENT_CREDITS', message: 'private' } })).error)
    .toMatchObject({ code:'INSUFFICIENT_CREDITS', scope:'pool' });
  expect(() => projectGatewayJob(job({ id: 'job_system_private' }))).toThrow('unavailable');
  for (const videoUrl of ['C:\\private\\video.mp4', '/api/system/private', 'file:///video.mp4', 'https://user:secret@video.miora.design/result.mp4']) expect(projectGatewayJob(job({ result: { videoUrl } }))).not.toHaveProperty('result');
});
