import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { expect, test } from 'vitest';
import { registerPackageShareRoutes } from './routes.js';
import { SystemError, type SystemPrincipal } from '../system/types.js';
import type { SystemRuntime } from '../system/runtime.js';
import type { PackageMediaFact } from './types.js';
const digest = (items: PackageMediaFact[]) => { const hash = createHash('sha256'); for (const item of items) hash.update(JSON.stringify(item) + '\n'); return hash.digest('hex'); };
async function fixture() {
  const db = new Database(':memory:'); const users = new Map(['owner','editor','other'].map(id => [id, { id, emailVerified: true, disabled: false, cloudEligible: true } as SystemPrincipal]));
  const runtime = { db, authenticate: async (request: { headers: Record<string,string> }) => users.get(request.headers['x-user']!)!, assertPrincipalCurrent: (principal: SystemPrincipal) => principal,
    assertRequestOrigin: () => {}, store: { audit: () => {}, getIdentity: (id: string) => ({ email: id + '@example.invalid' }) } } as unknown as SystemRuntime;
  const app = Fastify({ bodyLimit: 16384 });
  const store = registerPackageShareRoutes(app, { runtime }); await app.ready();
  const call = (method: 'GET'|'POST', route: string, payload?: object, user='owner', format=true) => app.inject({ method, url: '/api/system/package-shares'+route+(route.includes('?')?'&':'?')+(format?'format=manifest-v2':''), headers: { 'x-user': user }, ...(payload ? { payload } : {}) });
  const share = store.create(users.get('owner')!, { requestId: 'new-share', draftId: 'draft', title: 'shared' });
  const base = { kind: 'manifest', requestId: 'publish', draftId: 'draft', title: 'version', baseVersionId: null,
    snapshot: { sha256: 'f'.repeat(64), size: 123, url: 'https://snapshot.invalid/file' }, scope: { kind: 'all', episodeIds: [], sourceEpisodeCount: 0 } };
  return { db, app, store, shareId: share.shareId, users, base, call, close: async () => { await app.close(); db.close(); } };
}
test('row-backed manifest publishes atomically, paginates closed media indexes and keeps streamed old-client JSON', async () => {
  const f=await fixture(); try {
    const media = Array.from({length:1251},(_,i)=>({sha256:i.toString(16).padStart(64,'0'),size:i,mime:'image/png',kind:'image'}));
    const insert=f.db.prepare('INSERT INTO package_share_media VALUES(?,?,?,?,?,?,?,?)'); f.db.transaction(()=>media.forEach(item=>insert.run(f.shareId,item.sha256,item.size,item.mime,item.kind,'https://media.invalid/'+item.sha256,'owner',new Date().toISOString())))();
    const input={...f.base,mediaCount:media.length,mediaDigest:digest(media)};
    const started=(await f.call('POST',`/${f.shareId}/versions/stages`,input)).json();
    for(let offset=0;offset<media.length;offset+=50) expect((await f.call('POST',`/${f.shareId}/versions/stages/${started.stageId}/media`,{offset,items:media.slice(offset,offset+50)})).statusCode).toBe(200);
    expect(f.store.versions(f.shareId)).toHaveLength(0);
    const committed=await f.call('POST',`/${f.shareId}/versions/stages/${started.stageId}/commit`,{}); expect(committed.statusCode).toBe(200);
    const version=committed.json().version;expect(version).toMatchObject({mediaCount:1251,mediaDigest:digest(media)});expect(version).not.toHaveProperty('media');
    expect((await f.call('POST',`/${f.shareId}/versions/stages/${started.stageId}/commit`,{})).json().version.versionId).toBe(version.versionId);
    expect((await f.call('POST',`/${f.shareId}/versions/stages`,{...input,mediaDigest:'b'.repeat(64)})).statusCode).toBe(409);
    const received: PackageMediaFact[]=[];let after=0;
    do {const page=(await f.call('GET',`/${f.shareId}/versions/${version.versionId}/media?after=${after}&limit=200`)).json();expect(page.mediaDigest).toBe(version.mediaDigest);expect(page.items[0]?.position).toBe(after);for(const {position:_position,url:_url,...item} of page.items)received.push(item);after=page.nextAfter;if(page.complete)break;}while(true);
    expect(after).toBe(media.length);expect(digest(received)).toBe(version.mediaDigest);
    expect((await f.call('GET',`/${f.shareId}/versions/${version.versionId}/media`,undefined,'other')).statusCode).toBe(404);
    const legacy=await f.call('POST',`/${f.shareId}/versions/${version.versionId}/download`,{},'owner',false);expect(legacy.json().media).toHaveLength(media.length);expect(legacy.json().media[0].url).toContain('media.invalid');
    expect(f.db.prepare('SELECT mediaJson FROM package_share_manifest_versions').get()).toEqual({mediaJson:'[]'});
  }finally{await f.close();}
});
test('old inline JSON versions migrate once and retain identities and URLs across v2 and old downloads',async()=>{
  const f=await fixture();try{
    const media=[{sha256:'a'.repeat(64),size:5,mime:'image/png',kind:'image'}];
    f.db.prepare('INSERT INTO package_share_media VALUES(?,?,?,?,?,?,?,?)').run(f.shareId,media[0]!.sha256,5,'image/png','image','https://old.invalid/media','owner',new Date().toISOString());
    f.db.prepare('INSERT INTO package_share_manifest_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('pv_old',f.shareId,7,'draft','old',12,'b'.repeat(64),'owner',new Date().toISOString(),'old-request','https://old.invalid/snapshot',JSON.stringify(f.base.scope),null,JSON.stringify(media));
    const first=(await f.call('GET',`/${f.shareId}/latest`)).json().version;expect(first.mediaCount).toBe(1);expect(first.mediaDigest).toBe(digest(media));expect(first).not.toHaveProperty('media');
    expect((await f.call('POST',`/${f.shareId}/versions/pv_old/download`,{},'owner',false)).json().media[0]).toMatchObject({...media[0],url:'https://old.invalid/media'});
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_version_media').get()).toEqual({n:1});expect(f.db.prepare('SELECT mediaJson FROM package_share_manifest_versions').get()).toEqual({mediaJson:JSON.stringify(media)});
    expect((await f.call('GET',`/${f.shareId}/latest`)).statusCode).toBe(200);expect(f.db.prepare('SELECT COUNT(*) AS n FROM package_share_version_media').get()).toEqual({n:1});
  }finally{await f.close();}
});
test('scope larger than the request budget transfers in windows with hash and structure validation',async()=>{
  const f=await fixture();try{
    const scope={kind:'all',sourceEpisodeCount:30000,episodeIds:Array.from({length:30000},(_,i)=>String(i).padStart(80,'x')),assetOrigins:[{assetId:'人物',sourceEpisodeIds:['scene-one']}]};
    const text=JSON.stringify(scope);expect(Buffer.byteLength(text)).toBeGreaterThan(2*1024*1024);const parts=text.match(/[\s\S]{1,8000}/g)!;
    const {scope:_scope,...base}=f.base;const input={...base,mediaCount:0,mediaDigest:digest([]),scopeTransfer:{bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),chunks:parts.length}};
    const started=(await f.call('POST',`/${f.shareId}/versions/stages`,input)).json();expect(started.scopeReceived).toBe(0);
    for(let offset=0;offset<parts.length;offset++)expect((await f.call('POST',`/${f.shareId}/versions/stages/${started.stageId}/scope`,{offset,items:[parts[offset]]})).statusCode).toBe(200);
    const committed=await f.call('POST',`/${f.shareId}/versions/stages/${started.stageId}/commit`,{});expect(committed.statusCode).toBe(200);
    const version=committed.json().version;expect(version.scope).toBeNull();expect(version.scopeDigest).toBe(input.scopeTransfer.sha256);
    let restored='',after=0;do{const page=(await f.call('GET',`/${f.shareId}/versions/${version.versionId}/scope?after=${after}&limit=2`)).json();expect(page.sha256).toBe(input.scopeTransfer.sha256);restored+=page.items.map((item:{text:string})=>item.text).join('');after=page.nextAfter;if(page.complete)break;}while(true);
    expect(restored).toBe(text);expect((await f.call('POST',`/${f.shareId}/versions/${version.versionId}/download`,{},'owner',false)).json().scope).toEqual(scope);
    const invalid=JSON.stringify({...scope,episodeIds:['same','same'],sourceEpisodeCount:2});const bad=(await f.call('POST',`/${f.shareId}/versions/stages`,{...input,requestId:'bad-scope',scopeTransfer:{bytes:Buffer.byteLength(invalid),sha256:createHash('sha256').update(invalid).digest('hex'),chunks:1}})).json();
    await f.call('POST',`/${f.shareId}/versions/stages/${bad.stageId}/scope`,{offset:0,items:[invalid]});expect((await f.call('POST',`/${f.shareId}/versions/stages/${bad.stageId}/commit`,{})).statusCode).toBe(400);expect(f.store.versions(f.shareId)).toHaveLength(1);
  }finally{await f.close();}
});
test('staging accepts beyond the removed million-media cap but rejects incomplete commits',async()=>{
  const f=await fixture();try{const stage=await f.call('POST',`/${f.shareId}/versions/stages`,{...f.base,mediaCount:1000001,mediaDigest:'a'.repeat(64)});expect(stage.statusCode).toBe(200);expect((await f.call('POST',`/${f.shareId}/versions/stages/${stage.json().stageId}/commit`,{})).statusCode).toBe(409);expect(f.store.versions(f.shareId)).toHaveLength(0);}finally{await f.close();}
});
