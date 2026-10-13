import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import type { SystemRuntime } from '../system/runtime.js';
import { SystemError, type SystemPrincipal } from '../system/types.js';
import { registerPackageShareRoutes } from './routes.js';
import { PackageShareStore } from './store.js';
import type { PackageStorage } from './types.js';

async function fixture(enabled = true, configured = true) {
  const db = new Database(':memory:');
  let now = Date.now();
  const users = new Map(['owner', 'editor', 'other'].map(id => [id, { id, sessionId: id, email: `${id}@example.invalid`, emailVerified: true, disabled: false, cloudEligible: true, sharingEligible: false } as SystemPrincipal]));
  const audit: unknown[] = [];
  const objects = new Map<string, { size: number; metadata: { sha256: string } }>();
  const sessions = new Map<string, { objectKey: string; size: number; sha256: string }>();
  let completeCalls = 0; let beginCalls = 0; let badParts = false; let badHash = false;
  let beforeSign: (() => void) | undefined;
  const provider: PackageStorage = {
    kind: 'fake-private', multipartLimits: { minPartBytes: 8, maxPartBytes: 1024, maxParts: 10000 },
    begin: async input => { const existing = [...sessions].find(([, session]) => session.objectKey === input.objectKey); if (existing) return { uploadId: existing[0] }; beginCalls++; const uploadId = randomUUID(); sessions.set(uploadId, input); return { uploadId }; },
    signPart: async input => { beforeSign?.(); return { url: `https://private.invalid/part-${input.partNumber}`, headers: { 'content-length': String(input.size), 'content-md5': input.md5Base64 }, expiresAt: new Date(Date.now() + 60000).toISOString() }; },
    listParts: async input => {
      const source = sessions.get(input.uploadId)!;
      return Array.from({ length: Math.ceil(source.size / 8) }, (_, index) => ({ partNumber: index + 1, etag: `etag-${index + 1}`, size: badParts ? 1 : Math.min(8, source.size - index * 8) }));
    },
    complete: async input => { completeCalls++; const source = sessions.get(input.uploadId)!; objects.set(input.objectKey, { size: source.size, metadata: { sha256: badHash ? '0'.repeat(64) : source.sha256 } }); },
    abort: async input => { sessions.delete(input.uploadId); },
    head: async key => objects.get(key) ?? null,
    signDownload: async () => ({ url: 'https://private.invalid/download', expiresAt: new Date(Date.now() + 60000).toISOString() })
  };
  const current = (principal: { id: string }) => {
    const user = users.get(principal.id); if (!user || user.disabled) throw new SystemError(401, 'SESSION_REVOKED', 'Session revoked'); return user;
  };
  const runtime = { db, authenticate: async (request: { headers: Record<string, string> }) => current({ id: request.headers['x-user']! }), assertPrincipalCurrent: current,
    assertRequestOrigin: (request: { headers: Record<string, string> }) => { if (request.headers.origin !== 'https://desktop.invalid') throw new SystemError(403, 'UNTRUSTED_ORIGIN', 'Origin denied'); },
    store: { getIdentity: (id: string) => users.get(id), getIdentityByEmail: (email: string) => [...users.values()].find(user => user.email.toLowerCase() === email.toLowerCase()), audit: (value: unknown) => audit.push(value) }
  } as unknown as SystemRuntime;
  const app = Fastify({ bodyLimit: 16384 });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof SystemError ? error.statusCode : 500).send({ code: error instanceof SystemError ? error.code : 'ERROR' }));
  const store = registerPackageShareRoutes(app, { runtime, enabled, storage: configured ? provider : null, clock: () => now });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'DELETE', route: string, user = 'owner', payload?: object) => app.inject({ method, url: '/api/system/package-shares' + route, headers: { 'x-user': user, origin: 'https://desktop.invalid' }, ...(payload ? { payload } : {}) });
  return { app, db, users, store, objects, call, audit, provider, runtime, clock: () => now, advance: (milliseconds: number) => { now += milliseconds; }, setBadParts: (value: boolean) => { badParts = value; }, setBadHash: (value: boolean) => { badHash = value; }, setBeforeSign: (value: () => void) => { beforeSign = value; }, counts: () => ({ completeCalls, beginCalls }), close: async () => { await app.close(); db.close(); } };
}
const uploadInput = (requestId: string) => ({ requestId, draftId: 'draft-local', title: 'draft title', size: 9, sha256: 'a'.repeat(64), scope: { kind: 'selected-episodes', episodeIds: ['episode-stable-2'], sourceEpisodeCount: 3, assetOrigins: [{ assetId: 'asset-stable', episodeId: 'episode-stable-1' }] } });
const completeInput = { parts: [{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' }] };

test('package members publish concurrent immutable versions with idempotent upload and live ACL, download leases and recoverable soft delete', async () => {
  const f = await fixture();
  try {
    const created = await f.call('POST', '', 'owner', { requestId: 'create-one', draftId: 'draft-local', title: 'shared draft' });
    expect(created.statusCode).toBe(200); const { shareId } = created.json();
    expect((await f.call('POST', '', 'owner', { requestId: 'create-one', draftId: 'draft-local', title: 'shared draft' })).json().shareId).toBe(shareId);
    expect((await f.call('POST', `/${shareId}/members`, 'owner', { email: 'EDITOR@example.invalid' })).statusCode).toBe(200);
    expect((await f.call('POST', `/${shareId}/members`, 'editor', { email: 'other@example.invalid' })).statusCode).toBe(403);
    expect((await f.call('GET', `/${shareId}`, 'other')).statusCode).toBe(404);
    for (const user of ['owner', 'editor']) {
      const mismatched = await f.call('POST', `/${shareId}/uploads`, user, { ...uploadInput(`wrong-source-${user}`), draftId: 'another-draft' });
      expect(mismatched.statusCode).toBe(409); expect(mismatched.json().code).toBe('PACKAGE_SHARE_SOURCE_MISMATCH');
    }
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_uploads').get()).toEqual({ n: 0 });
    expect(f.counts().beginCalls).toBe(0);
    const uploadA = (await f.call('POST', `/${shareId}/uploads`, 'owner', uploadInput('upload-owner'))).json();
    const uploadB = (await f.call('POST', `/${shareId}/uploads`, 'editor', uploadInput('upload-editor'))).json();
    expect(uploadA.status).toBe('uploading'); expect(uploadB.status).toBe('uploading');
    expect((await f.call('POST', `/${shareId}/uploads`, 'editor', uploadInput('upload-editor'))).json().uploadId).toBe(uploadB.uploadId);
    expect(f.counts().beginCalls).toBe(2);
    expect(uploadA).not.toHaveProperty('objectKey'); expect(uploadA).not.toHaveProperty('storageUploadId');
    const signed = await f.call('POST', `/${shareId}/uploads/${uploadB.uploadId}/parts`, 'editor', { parts: [{ partNumber: 2, md5Base64: 'AAAAAAAAAAAAAAAAAAAAAA==' }] });
    expect(signed.statusCode).toBe(200); expect(signed.json().parts[0].headers['content-length']).toBe('1');
    const published = await Promise.all([f.call('POST', `/${shareId}/uploads/${uploadA.uploadId}/complete`, 'owner', completeInput), f.call('POST', `/${shareId}/uploads/${uploadB.uploadId}/complete`, 'editor', completeInput)]);
    expect(published.map(response => response.statusCode)).toEqual([200, 200]);
    expect(published[0]!.json().version.scope).toEqual(uploadInput('scope').scope);
    expect(published.map(response => response.json().version.sequence).sort()).toEqual([1, 2]);
    const version = published[1]!.json().version;
    expect((await f.call('POST', `/${shareId}/uploads/${uploadB.uploadId}/complete`, 'editor', completeInput)).json().version.versionId).toBe(version.versionId);
    expect(f.counts().completeCalls).toBe(2);
    expect((await f.call('POST', `/${shareId}/versions/${version.versionId}/download`, 'editor')).statusCode).toBe(200);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_download_leases').get()).toEqual({ n: 1 });
    await f.call('DELETE', `/${shareId}/members/editor`);
    expect((await f.call('POST', `/${shareId}/versions/${version.versionId}/download`, 'editor')).statusCode).toBe(404);
    expect((await f.call('DELETE', `/${shareId}`)).statusCode).toBe(200);
    expect((await f.call('POST', `/${shareId}/versions/${version.versionId}/download`)).statusCode).toBe(409);
    expect(f.objects.size).toBe(2);
    expect((await f.call('POST', `/${shareId}/restore`)).statusCode).toBe(200);
    expect((await f.call('GET', `/${shareId}`)).json().versions).toHaveLength(2);
    expect(JSON.stringify(f.audit)).not.toContain('https://private');
  } finally { await f.close(); }
});

test('disabled storage and ineligible accounts fail explicitly; bad parts/hash and mid-sign revocation cannot publish or return access', async () => {
  for (const [enabled, configured, code] of [[false, false, 'PACKAGE_SHARES_DISABLED'], [true, false, 'PACKAGE_STORAGE_UNAVAILABLE']] as const) {
    const f = await fixture(enabled, configured);
    try { expect((await f.call('GET', '/capability')).json()).toMatchObject({ enabled, storageConfigured: configured }); expect((await f.call('GET', '')).json().code).toBe(code); } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    const { shareId } = (await f.call('POST', '', 'owner', { requestId: 'create-two', draftId: 'draft-local', title: 'shared draft' })).json();
    await f.call('POST', `/${shareId}/members`, 'owner', { email: 'editor@example.invalid' });
    const upload = (await f.call('POST', `/${shareId}/uploads`, 'editor', uploadInput('guarded-upload'))).json();
    f.setBadParts(true);
    expect((await f.call('POST', `/${shareId}/uploads/${upload.uploadId}/complete`, 'editor', completeInput)).json().code).toBe('PACKAGE_PARTS_INCOMPLETE');
    expect(f.counts().completeCalls).toBe(0);
    f.setBadParts(false); f.setBadHash(true);
    expect((await f.call('POST', `/${shareId}/uploads/${upload.uploadId}/complete`, 'editor', completeInput)).json().code).toBe('PACKAGE_OBJECT_MISMATCH');
    expect(f.store.versions(shareId)).toHaveLength(0);
    f.objects.clear(); f.setBadHash(false);
    expect((await f.call('POST', `/${shareId}/uploads/${upload.uploadId}/complete`, 'editor', completeInput)).statusCode).toBe(200);
    const active = (await f.call('POST', `/${shareId}/uploads`, 'editor', uploadInput('cancel-upload'))).json();
    f.setBeforeSign(() => { f.users.get('editor')!.cloudEligible = false; });
    expect((await f.call('POST', `/${shareId}/uploads/${active.uploadId}/parts`, 'editor', { parts: [{ partNumber: 1, md5Base64: 'AAAAAAAAAAAAAAAAAAAAAA==' }] })).statusCode).toBe(403);
    expect((await f.call('GET', '')).statusCode).toBe(200);
    expect((await f.call('POST', `/${shareId}/uploads/${active.uploadId}/cancel`)).statusCode).toBe(200);
    expect(f.store.upload(shareId, active.uploadId).status).toBe('cancelled');
  } finally { await f.close(); }
});

test('restart recovers storage begin before its receipt persisted with one durable initialization lease and the same multipart session', async () => {
  const f = await fixture(); let restarted: ReturnType<typeof Fastify> | undefined;
  try {
    const { shareId } = (await f.call('POST', '', 'owner', { requestId: 'crash-share', draftId: 'draft-local', title: 'draft' })).json();
    const input = { ...uploadInput('crash-upload'), partSize: 8, partCount: 2, baseVersionId: null };
    const upload = f.store.reserveUpload(shareId, f.users.get('owner')!, input as Parameters<PackageShareStore['reserveUpload']>[2]);
    const oldToken = f.store.claimInitialization(upload.uploadId)!;
    expect(oldToken).toBeTruthy();
    const accepted = await f.provider.begin({ objectKey: upload.objectKey, size: upload.size, sha256: upload.sha256, contentType: 'application/zip' });
    // Simulate death before initialized(): close the old router, keep durable DB and private storage.
    await f.app.close();
    restarted = Fastify();
    const restored = registerPackageShareRoutes(restarted, { runtime: f.runtime, enabled: true, storage: f.provider, clock: f.clock });
    await restarted.ready();
    expect(restored.claimInitialization(upload.uploadId)).toBeNull();
    f.advance(120001);
    const response = await restarted.inject({ method: 'GET', url: `/api/system/package-shares/${shareId}/uploads/${upload.uploadId}`, headers: { 'x-user': 'owner', origin: 'https://desktop.invalid' } });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ uploadId: upload.uploadId, status: 'uploading' });
    expect(restored.upload(shareId, upload.uploadId).storageUploadId).toBe(accepted.uploadId);
    f.advance(24 * 60 * 60 * 1000);
    expect(restored.uploadAccess(shareId, upload.uploadId, f.users.get('owner')!, true).storageUploadId).toBe(accepted.uploadId);
    expect(f.counts().beginCalls).toBe(1);
    expect(restored.initialized(upload.uploadId, 'stale-receipt', oldToken)).toBe(false);
    expect(restored.upload(shareId, upload.uploadId).storageUploadId).toBe(accepted.uploadId);
  } finally { await restarted?.close(); await f.close(); }
});
