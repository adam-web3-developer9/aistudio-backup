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
  let now = Date.now();
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
  const store = registerPackageShareRoutes(app, { runtime, enabled, clock: () => now });
  await app.ready();
  const call = (method: 'GET' | 'POST' | 'DELETE', route: string, user = 'owner', payload?: object) => app.inject({ method, url: '/api/system/package-shares' + route, headers: { 'x-user': user, origin: 'https://desktop.invalid' }, ...(payload ? { payload } : {}) });
  return { app, db, users, store, call, audit, network, advance: (milliseconds: number) => { now += milliseconds; }, loseNextReceipt: () => { loseReceipt = true; }, close: async () => { await app.close(); db.close(); } };
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


test('manifest publish requires every shared media receipt atomically and resolves repairs without changing immutable hashes or legacy ZIP access', async () => {
  const f = await fixture();
  try {
    const { shareId } = (await f.call('POST', '', 'owner', createInput)).json();
    await f.call('POST', `/${shareId}/members`, 'owner', { email: 'editor@example.invalid' });
    const media = { sha256: 'c'.repeat(64), size: 18, mime: 'video/mp4', kind: 'video' };
    const empty = { sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', size: 0, mime: 'application/octet-stream', kind: 'file' };
    const snapshot = { sha256: 'd'.repeat(64), size: 44, url: 'https://snapshot-vendor.example/full.json' };
    const manifest = { kind: 'manifest', requestId: 'manifest-one', draftId: createInput.draftId, title: 'full snapshot', snapshot, media: [media, empty], scope: input('scope').scope };
    expect((await f.call('GET', `/${shareId}/latest`)).json()).toEqual({ version: null });
    const missing = await f.call('POST', `/${shareId}/versions`, 'owner', manifest);
    expect(missing.statusCode).toBe(409); expect(missing.json().code).toBe('PACKAGE_MEDIA_NOT_READY');
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_manifest_versions').get()).toEqual({ n: 0 });
    const claim = (await f.call('POST', `/${shareId}/media/claims`, 'editor', { requestId: 'media-first', sha256: media.sha256, size: media.size })).json();
    expect(claim.status).toBe('claimed');
    expect((await f.call('POST', `/${shareId}/media/claims/${claim.claimId}/complete`, 'editor', { url: 'https://media-vendor.example/original.mp4', mime: media.mime, kind: media.kind })).json().status).toBe('ready');
    const emptyClaim = (await f.call('POST', `/${shareId}/media/claims`, 'editor', { requestId: 'empty-media', sha256: empty.sha256, size: 0 })).json();
    expect(emptyClaim.status).toBe('claimed');
    expect((await f.call('POST', `/${shareId}/media/claims/${emptyClaim.claimId}/complete`, 'editor', { url: 'https://media-vendor.example/empty', mime: empty.mime, kind: empty.kind })).json().status).toBe('ready');
    expect((await f.call('POST', `/${shareId}/versions`, 'owner', { ...manifest, snapshot: { ...snapshot, size: 0 } })).statusCode).toBe(400);
    const published = await f.call('POST', `/${shareId}/versions`, 'owner', manifest);
    expect(published.statusCode).toBe(200); const version = published.json().version;
    expect(version).toMatchObject({ kind: 'manifest', sequence: 1, snapshot: { sha256: snapshot.sha256, size: snapshot.size }, media: [media, empty] });
    expect((await f.call('POST', `/${shareId}/versions`, 'owner', manifest)).json().version.versionId).toBe(version.versionId);
    const before = f.db.prepare('SELECT mediaJson,sha256 FROM package_share_manifest_versions WHERE versionId=?').get(version.versionId);
    const repaired = (await f.call('POST', `/${shareId}/media/claims`, 'owner', { requestId: 'repair-address', sha256: media.sha256, size: media.size, repair: true })).json();
    await f.call('POST', `/${shareId}/media/claims/${repaired.claimId}/complete`, 'owner', { url: 'http://replacement.example/same-bytes.mp4', mime: media.mime, kind: media.kind });
    const download = await f.call('POST', `/${shareId}/versions/${version.versionId}/download`, 'editor');
    expect(download.statusCode).toBe(200); expect(download.json()).toMatchObject({ snapshot, media: [{ ...media, url: 'http://replacement.example/same-bytes.mp4' }, { ...empty, url: 'https://media-vendor.example/empty' }] });
    expect(f.db.prepare('SELECT mediaJson,sha256 FROM package_share_manifest_versions WHERE versionId=?').get(version.versionId)).toEqual(before);
    const latest = (await f.call('GET', `/${shareId}/latest`, 'editor')).json();
    expect(latest.version.versionId).toBe(version.versionId); expect(JSON.stringify(latest)).not.toContain('snapshot-vendor'); expect(JSON.stringify(latest)).not.toContain('replacement.example');
    const nonmember = await f.call('POST', `/${shareId}/media/lookup`, 'other', { items: [{ sha256: media.sha256, size: media.size }] });
    expect(nonmember.statusCode).toBe(404); expect(nonmember.body).not.toContain('replacement.example');
    const { shareId: anotherShare } = (await f.call('POST', '', 'other', { ...createInput, requestId: 'unrelated-share' })).json();
    expect((await f.call('POST', `/${anotherShare}/media/lookup`, 'other', { items: [{ sha256: media.sha256, size: media.size }] })).json().items[0].status).toBe('missing');
    const zip = (await f.call('POST', `/${shareId}/versions`, 'editor', input('zip-after-manifest'))).json().version;
    expect(zip).toMatchObject({ kind: 'zip', sequence: 2 });
    expect((await f.call('POST', `/${shareId}/versions/${zip.versionId}/download`, 'editor')).json().url).toBe(input('zip').url);
    const parallel = await Promise.all([f.call('POST', `/${shareId}/versions`, 'owner', { ...manifest, requestId: 'parallel-owner', baseVersionId: version.versionId }),
      f.call('POST', `/${shareId}/versions`, 'editor', { ...manifest, requestId: 'parallel-editor', baseVersionId: version.versionId })]);
    expect(parallel.map(response => response.statusCode)).toEqual([200, 200]);
    expect(parallel.map(response => response.json().version.sequence).sort()).toEqual([3, 4]);
    expect((await f.call('GET', `/${shareId}/latest`, 'editor')).json().version).toMatchObject({ kind: 'manifest', sequence: 4 });
    expect(f.network).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('two members coordinate one hash through recoverable claims with renewal, cancellation, expiry takeover and fenced stale receipts', async () => {
  const f = await fixture();
  try {
    const { shareId } = (await f.call('POST', '', 'owner', createInput)).json();
    await f.call('POST', `/${shareId}/members`, 'owner', { email: 'editor@example.invalid' });
    const object = { sha256: 'e'.repeat(64), size: 6 };
    const claim = (actor: string, requestId: string) => f.call('POST', `/${shareId}/media/claims`, actor, { ...object, requestId });
    const competing = await Promise.all([claim('owner', 'claim-owner'), claim('editor', 'claim-editor')]);
    expect(competing.map(response => response.json().status).sort()).toEqual(['busy', 'claimed']);
    const first = competing[0]!.json();
    expect((await claim('owner', 'claim-owner')).json().claimId).toBe(first.claimId);
    f.advance(60000);
    const renewed = (await f.call('POST', `/${shareId}/media/claims/${first.claimId}/renew`)).json();
    expect(Date.parse(renewed.leaseUntil)).toBeGreaterThan(Date.parse(first.leaseUntil));
    expect((await f.call('POST', `/${shareId}/media/claims/${first.claimId}/cancel`)).json()).toEqual({ cancelled: true });
    const editor = (await claim('editor', 'claim-editor')).json(); expect(editor.status).toBe('claimed');
    f.advance(120001);
    const secondOwner = (await claim('owner', 'claim-owner')).json(); expect(secondOwner.status).toBe('claimed'); expect(secondOwner.claimId).not.toBe(first.claimId);
    const stale = await f.call('POST', `/${shareId}/media/claims/${editor.claimId}/complete`, 'editor', { url: 'https://old-result.example/a', mime: 'image/png', kind: 'image' });
    expect(stale.statusCode).toBe(409);
    const complete = { url: 'https://current.example/a', mime: 'image/png', kind: 'image' };
    expect((await f.call('POST', `/${shareId}/media/claims/${secondOwner.claimId}/complete`, 'owner', complete)).json().status).toBe('ready');
    expect((await claim('editor', 'after-ready')).json()).toMatchObject({ status: 'ready', url: complete.url });
    expect((await f.call('POST', `/${shareId}/media/claims/${secondOwner.claimId}/complete`, 'owner', complete)).json().url).toBe(complete.url);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM package_share_media_claims WHERE status='active'").get()).toEqual({ n: 0 });
    expect(f.network).not.toHaveBeenCalled();
  } finally { await f.close(); }
});


test('lost manifest publish receipts recover by actor before snapshot repair while frozen facts and old request replay stay unchanged', async () => {
  const f = await fixture();
  try {
    const { shareId } = (await f.call('POST', '', 'owner', createInput)).json();
    await f.call('POST', `/${shareId}/members`, 'owner', { email: 'editor@example.invalid' });
    const snapshot = { url: 'https://expired-snapshot.example/original.json', sha256: 'f'.repeat(64), size: 11 };
    const manifest = { kind: 'manifest', requestId: 'publish-response-lost', draftId: createInput.draftId, title: 'frozen text draft',
      snapshot, media: [], scope: { kind: 'all', episodeIds: [], sourceEpisodeCount: 0 } };
    f.loseNextReceipt();
    expect((await f.call('POST', `/${shareId}/versions`, 'owner', manifest)).statusCode).toBe(500);
    const receipt = await f.call('POST', `/${shareId}/versions/receipt`, 'owner', { requestId: manifest.requestId });
    expect(receipt.statusCode).toBe(200); const version = receipt.json().version;
    expect(version).toMatchObject({ kind: 'manifest', sequence: 1, snapshot: { sha256: snapshot.sha256, size: snapshot.size } });
    expect(JSON.stringify(version)).not.toContain('expired-snapshot');
    expect((await f.call('POST', `/${shareId}/versions/receipt`, 'editor', { requestId: manifest.requestId })).json()).toEqual({ version: null });
    expect((await f.call('POST', `/${shareId}/versions/receipt`, 'other', { requestId: manifest.requestId })).statusCode).toBe(404);
    const frozen = f.db.prepare('SELECT snapshotUrl,sha256,size,mediaJson,sequence FROM package_share_manifest_versions WHERE versionId=?').get(version.versionId);
    const repair = { ...snapshot, url: 'http://replacement-snapshot.example/same-bytes.json' };
    expect((await f.call('POST', `/${shareId}/versions/${version.versionId}/snapshot/repair`, 'other', repair)).statusCode).toBe(404);
    expect((await f.call('POST', `/${shareId}/versions/${version.versionId}/snapshot/repair`, 'editor', { ...repair, sha256: '0'.repeat(64) })).json().code).toBe('PACKAGE_SNAPSHOT_IDENTITY_MISMATCH');
    expect((await f.call('POST', `/${shareId}/versions/${version.versionId}/snapshot/repair`, 'editor', { ...repair, size: 12 })).statusCode).toBe(409);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_snapshot_urls').get()).toEqual({ n: 0 });
    const repaired = await f.call('POST', `/${shareId}/versions/${version.versionId}/snapshot/repair`, 'editor', repair);
    expect(repaired.statusCode).toBe(200); expect(repaired.json().version.versionId).toBe(version.versionId);
    expect(JSON.stringify(repaired.json())).not.toContain('replacement-snapshot');
    expect(f.db.prepare('SELECT snapshotUrl,sha256,size,mediaJson,sequence FROM package_share_manifest_versions WHERE versionId=?').get(version.versionId)).toEqual(frozen);
    expect((await f.call('POST', `/${shareId}/versions`, 'owner', manifest)).json().version.versionId).toBe(version.versionId);
    expect((await f.call('POST', `/${shareId}/versions/${version.versionId}/download`, 'owner')).json().snapshot).toEqual(repair);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_manifest_versions').get()).toEqual({ n: 1 });
    expect(f.network).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('twenty-thousand media facts register through bounded idempotent windows and commit once', async () => {
  const f = await fixture();
  try {
    const { shareId } = (await f.call('POST', '', 'owner', createInput)).json();
    const media = Array.from({ length: 20_000 }, (_, index) => ({ sha256: index.toString(16).padStart(64, '0'), size: index, mime: 'image/png', kind: 'image' }));
    const insert = f.db.prepare('INSERT INTO package_share_media VALUES(?,?,?,?,?,?,?,?)');
    f.db.transaction(() => media.forEach(item => insert.run(shareId, item.sha256, item.size, item.mime, item.kind, `https://media.invalid/${item.sha256}`, 'owner', new Date().toISOString())))();
    const staged = await f.call('POST', `/${shareId}/versions/stages`, 'owner', { kind: 'manifest', requestId: 'large-windowed', draftId: createInput.draftId,
      title: 'large manifest', scope: { kind: 'all', episodeIds: [], sourceEpisodeCount: 0 }, baseVersionId: null,
      snapshot: { sha256: 'f'.repeat(64), size: 123, url: 'https://snapshot.invalid/large.json' }, mediaCount: media.length });
    expect(staged.statusCode).toBe(200); const stageId = staged.json().stageId;
    for (let offset = 0; offset < media.length; offset += 50) {
      const payload = { offset, items: media.slice(offset, offset + 50) };
      const registered = await f.call('POST', `/${shareId}/versions/stages/${stageId}/media`, 'owner', payload);
      expect(registered.statusCode).toBe(200);
      if (offset === 0) expect((await f.call('POST', `/${shareId}/versions/stages/${stageId}/media`, 'owner', payload)).json().received).toBe(50);
    }
    const committed = await f.call('POST', `/${shareId}/versions/stages/${stageId}/commit`, 'owner', {});
    expect(committed.statusCode).toBe(200); expect(committed.json().version).toMatchObject({ kind: 'manifest', sequence: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_manifest_versions').get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_manifest_stages').get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});
