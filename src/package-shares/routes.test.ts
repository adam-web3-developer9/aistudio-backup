import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import type { SystemRuntime } from '../system/runtime.js';
import { SystemError, type SystemPrincipal } from '../system/types.js';
import { registerPackageShareRoutes } from './routes.js';
import { PackageShareStore } from './store.js';

afterEach(() => vi.unstubAllGlobals());
async function fixture(enabled?: boolean) {
  const db = new Database(':memory:');
  const users = new Map(['owner', 'editor', 'other'].map(id => [id, { id, sessionId: id, email: `${id}@example.invalid`, emailVerified: true, disabled: false, cloudEligible: true, sharingEligible: false } as SystemPrincipal]));
  const audit: unknown[] = []; let loseReceipt = false;
  const network = vi.fn(async () => { throw new Error('Backend network calls are forbidden'); });
  vi.stubGlobal('fetch', network);
  const current = (principal: { id: string }) => {
    const user = users.get(principal.id); if (!user || user.disabled) throw new SystemError(401, 'SESSION_REVOKED', 'Session revoked'); return user;
  };
  const runtime = { db, authenticate: async (request: { headers: Record<string, string> }) => current({ id: request.headers['x-user']! }), assertPrincipalCurrent: current,
    assertRequestOrigin: (request: { headers: Record<string, string> }) => { if (request.headers.origin !== 'https://desktop.invalid') throw new SystemError(403, 'UNTRUSTED_ORIGIN', 'Origin denied'); },
    store: { getIdentity: (id: string) => users.get(id), getIdentityByEmail: (email: string) => [...users.values()].find(user => user.email.toLowerCase() === email.toLowerCase()),
      audit: (value: { action: string }) => { audit.push(value); if (loseReceipt && value.action === 'package.version.publish') { loseReceipt = false; throw new Error('Simulated response loss after DB commit'); } } }
  } as unknown as SystemRuntime;
  const app = Fastify({ bodyLimit: 16384 });
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof SystemError ? error.statusCode : 500).send({ code: error instanceof SystemError ? error.code : 'ERROR' }));
  const store = registerPackageShareRoutes(app, { runtime, enabled });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'DELETE', route: string, user = 'owner', payload?: object) => app.inject({ method, url: '/api/system/package-shares' + route, headers: { 'x-user': user, origin: 'https://desktop.invalid' }, ...(payload ? { payload } : {}) });
  return { app, db, users, store, call, audit, network, loseNextReceipt: () => { loseReceipt = true; }, close: async () => { await app.close(); db.close(); } };
}
const input = (requestId: string, url = 'https://independent-storage.example/large.zip?public=1') => ({ requestId, draftId: 'stable-draft', title: 'draft title',
  size: 128 * 1024 * 1024, sha256: 'a'.repeat(64), url,
  scope: { kind: 'selected-episodes', episodeIds: ['episode-stable-2'], sourceEpisodeCount: 3, assetOrigins: [{ assetId: 'asset-stable', episodeId: 'episode-stable-1' }] } });
const createInput = { requestId: 'share-create', draftId: 'stable-draft', title: 'shared draft' };

test('public metadata sharing accepts independent storage, recovers a lost receipt, isolates URLs and keeps concurrent members and lifecycle ACL', async () => {
  const f = await fixture();
  try {
    expect((await f.call('GET', '/capability')).json()).toEqual({ enabled: true, eligible: true });
    const { shareId } = (await f.call('POST', '', 'owner', createInput)).json();
    expect((await f.call('POST', '', 'owner', createInput)).json().shareId).toBe(shareId);
    await f.call('POST', `/${shareId}/members`, 'owner', { email: 'EDITOR@example.invalid' });
    expect((await f.call('POST', `/${shareId}/members`, 'editor', { email: 'other@example.invalid' })).statusCode).toBe(403);
    for (const user of ['owner', 'editor']) expect((await f.call('POST', `/${shareId}/versions`, user, { ...input('wrong-source'), draftId: 'wrong' })).json().code).toBe('PACKAGE_SHARE_SOURCE_MISMATCH');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_public_versions').get()).toEqual({ n: 0 });
    f.loseNextReceipt();
    expect((await f.call('POST', `/${shareId}/versions`, 'editor', input('lost-receipt'))).statusCode).toBe(500);
    const lostVersion = f.store.versions(shareId)[0]!;
    const retried = await f.call('POST', `/${shareId}/versions`, 'editor', input('lost-receipt'));
    expect(retried.statusCode).toBe(200); expect(retried.json().version.versionId).toBe(lostVersion.versionId);
    expect(retried.json().version).not.toHaveProperty('url');
    expect(new PackageShareStore(f.db).versions(shareId)).toHaveLength(1);
    const concurrent = await Promise.all([f.call('POST', `/${shareId}/versions`, 'owner', input('owner-next', 'http://other-vendor.example/package.zip')),
      f.call('POST', `/${shareId}/versions`, 'editor', { ...input('editor-next'), baseVersionId: lostVersion.versionId })]);
    expect(concurrent.map(response => response.statusCode)).toEqual([200, 200]);
    expect(concurrent.map(response => response.json().version.sequence).sort()).toEqual([2, 3]);
    expect((await f.call('POST', `/${shareId}/versions`, 'editor', { ...input('lost-receipt'), title: 'different' })).statusCode).toBe(409);
    const detail = (await f.call('GET', `/${shareId}`, 'editor')).json();
    expect(detail.versions).toHaveLength(3); expect(detail.versions[0].scope).toEqual(input('scope').scope);
    for (const metadata of [detail, (await f.call('GET', '')).json(), retried.json(), f.audit]) expect(JSON.stringify(metadata)).not.toContain('independent-storage');
    expect((await f.call('POST', `/${shareId}/versions/${lostVersion.versionId}/download`, 'editor')).json().url).toBe(input('same').url);
    expect((await f.call('POST', `/${shareId}/versions/${lostVersion.versionId}/download`, 'other')).statusCode).toBe(404);
    await f.call('DELETE', `/${shareId}/members/editor`);
    expect((await f.call('POST', `/${shareId}/versions/${lostVersion.versionId}/download`, 'editor')).statusCode).toBe(404);
    await f.call('DELETE', `/${shareId}`);
    expect((await f.call('POST', `/${shareId}/versions/${lostVersion.versionId}/download`)).statusCode).toBe(409);
    await f.call('POST', `/${shareId}/restore`);
    expect((await f.call('GET', `/${shareId}`)).json().versions).toHaveLength(3);
    expect(f.network).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('public URL validation and current account checks reject unsafe inputs without a fetch or bucket dependency', async () => {
  const disabled = await fixture(false);
  try { expect((await disabled.call('GET', '/capability')).json()).toEqual({ enabled: false, eligible: true }); expect((await disabled.call('GET', '')).json().code).toBe('PACKAGE_SHARES_DISABLED'); } finally { await disabled.close(); }
  const f = await fixture();
  try {
    const { shareId } = (await f.call('POST', '', 'owner', createInput)).json();
    for (const url of ['file:///tmp/private.zip', 'https://user:password@example.invalid/a.zip', 'https://example.invalid/a\r\nheader', 'https://example.invalid/a%0d%0aheader', 'https:\\example.invalid\\a', 'https://']) {
      expect((await f.call('POST', `/${shareId}/versions`, 'owner', input('invalid-url', url))).statusCode).toBe(400);
    }
    expect((await f.call('POST', `/${shareId}/versions`, 'owner', { ...input('invalid-scope'), scope: { kind: 'all', episodeIds: ['ep', 'ep'], sourceEpisodeCount: 2 } })).statusCode).toBe(400);
    f.users.get('owner')!.cloudEligible = false;
    expect((await f.call('GET', '')).statusCode).toBe(403);
    f.users.get('owner')!.cloudEligible = true; f.users.get('owner')!.disabled = true;
    expect((await f.call('POST', `/${shareId}/versions`, 'owner', input('disabled-user'))).statusCode).toBe(401);
    expect(f.store.versions(shareId)).toHaveLength(0); expect(f.network).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='package_share_uploads'").get()).toBeUndefined();
  } finally { await f.close(); }
});

test('legacy private versions and ACL survive the additive public model with continuing sequence and explicit republish requirement', async () => {
  const f = await fixture();
  try {
    const { shareId } = (await f.call('POST', '', 'owner', createInput)).json();
    await f.call('POST', `/${shareId}/members`, 'owner', { email: 'editor@example.invalid' });
    f.db.exec(`CREATE TABLE package_share_versions(versionId TEXT PRIMARY KEY,shareId TEXT,sequence INTEGER,draftId TEXT,title TEXT,size INTEGER,
      sha256 TEXT,publishedBy TEXT,createdAt TEXT,uploadId TEXT,objectKey TEXT,scopeJson TEXT,baseVersionId TEXT);
      CREATE TABLE package_share_uploads(uploadId TEXT PRIMARY KEY,status TEXT);
      CREATE TABLE package_share_download_leases(leaseId TEXT PRIMARY KEY);`);
    f.db.prepare('INSERT INTO package_share_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run('pv_old', shareId, 7, 'stable-draft', 'old draft', 12, 'b'.repeat(64), 'owner', '2026-10-13T00:00:00Z', 'pu_historical', 'private/historical.zip', JSON.stringify(input('scope').scope), null);
    f.db.prepare('INSERT INTO package_share_uploads VALUES(?,?)').run('pu_historical', 'completed');
    new PackageShareStore(f.db);
    const detail = (await f.call('GET', `/${shareId}`, 'editor')).json();
    expect(detail.versions[0]).toMatchObject({ versionId: 'pv_old', sequence: 7, downloadAvailable: false });
    expect(JSON.stringify(detail)).not.toContain('private/historical.zip');
    expect((await f.call('POST', `/${shareId}/versions/pv_old/download`, 'editor')).json().code).toBe('PACKAGE_VERSION_REPUBLISH_REQUIRED');
    const next = await f.call('POST', `/${shareId}/versions`, 'editor', { ...input('new-public'), baseVersionId: 'pv_old' });
    expect(next.statusCode).toBe(200); expect(next.json().version).toMatchObject({ sequence: 8, baseVersionId: 'pv_old', downloadAvailable: true });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_versions').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT * FROM package_share_uploads').get()).toEqual({ uploadId: 'pu_historical', status: 'completed' });
    expect(f.store.members(shareId)).toHaveLength(2); expect(f.network).not.toHaveBeenCalled();
  } finally { await f.close(); }
});
