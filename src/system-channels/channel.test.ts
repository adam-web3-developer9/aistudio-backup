import { afterEach, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ChannelStore } from './store.js';
import { ManagedSessionStore } from './session-store.js';
import { registerChannelRoutes } from './routes.js';
import { ChannelJobBridge } from './bridge.js';
import { ProjectStore } from '../projects/store.js';
import { SystemJobStore } from '../system-jobs/store.js';
import { LocalPrivateBlobStore } from '../system-media/routes.js';
import { AdapterRegistry } from '../adapters/adapter.js';
import { AccountPool } from '../jobs/account-pool.js';
import { JobRunner } from '../jobs/job-runner.js';
import { JobStore } from '../stores/job-store.js';
import { AssetStore } from '../stores/asset-store.js';
import { BrowserPool } from '../browser/browser-pool.js';
import { SystemError } from '../system/types.js';
import { assertSystemRequestOrigin } from '../system/security.js';
import type { SystemRuntime } from '../system/index.js';
import { readMioraTokens } from '../adapters/miora-api.js';
const key=Buffer.alloc(32,17).toString('base64');const jwt='eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({sub:'fake-channel-user',exp:4102444800})).toString('base64url')+'.fake';
const owner={id:'owner',sessionId:'session',emailVerified:true,cloudEligible:true,sharingEligible:true,adminRole:'superadmin' as const};
const cleanup:Array<()=>Promise<void>|void>=[];afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
test('vault fails closed, credentials encrypted and safe output remains remotely unknown',()=>{const db=new Database(':memory:');cleanup.push(()=>{db.close();});const unavailable=new ChannelStore(db);expect(()=>unavailable.import(jwt)).toThrow('not configured');const vault=new ChannelStore(db,key);const added=vault.import(jwt,'Fake');expect(added.enabled).toBe(true);expect(added.validationStatus).toBe('unknown');expect(JSON.stringify(vault.list())).not.toContain(jwt);expect(vault.row(added.id)!.encrypted).not.toContain(jwt);expect(readMioraTokens(vault.session(added.id)!.cookies)!.authToken).toBe(jwt);const wrong=new ChannelStore(db,Buffer.alloc(32,18).toString('base64'));expect(()=>wrong.session(added.id)).toThrow('unavailable');});
test('existing worker session store consumes only enabled vault accounts and renews without plaintext files',async()=>{const dir=await mkdtemp(path.join(tmpdir(),'vault-worker-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));const db=new Database(':memory:');cleanup.push(()=>{db.close();});const vault=new ChannelStore(db,key);const account=vault.import(jwt);const sessions=new ManagedSessionStore(dir,vault);await sessions.initialize();expect((await sessions.list()).map(x=>x.id)).toEqual([account.id]);vault.update(account.id,{enabled:false});expect(await sessions.list()).toEqual([]);vault.update(account.id,{enabled:true});expect((await sessions.list()).map(x=>x.id)).toEqual([account.id]);await sessions.put(account.id,'miora-v1',vault.session(account.id)!.cookies);expect(await readdir(path.join(dir,'sessions'))).toEqual([]);vault.update(account.id,{archived:true});expect(await sessions.list()).toEqual([]);expect(await sessions.get(account.id)).toBeDefined();});
test('credential updates preserve an explicit disable or archive',()=>{
  const db=new Database(':memory:');cleanup.push(()=>{db.close();});const vault=new ChannelStore(db,key);
  const account=vault.import(jwt);expect(account.enabled).toBe(true);
  vault.update(account.id,{enabled:false});expect(vault.import(jwt).enabled).toBe(false);
  vault.update(account.id,{archived:true});const updated=vault.import(jwt);
  expect(updated.enabled).toBe(false);expect(updated.archivedAt).not.toBeNull();
});
test('channel routes require superadmin mutation and trusted origin; local check is not remote validity',async()=>{const db=new Database(':memory:');cleanup.push(()=>{db.close();});const vault=new ChannelStore(db,key);let role='superadmin';const audits:unknown[]=[];const runtime={db,assertRequestOrigin:(req:Parameters<typeof assertSystemRequestOrigin>[0])=>assertSystemRequestOrigin(req,['http://localhost']),requireAdmin:async(_req:unknown,permission?:string)=>{if(permission==='authorize'&&role!=='superadmin')throw new SystemError(403,'SUPERADMIN_REQUIRED','Superadmin required');return owner;},store:{audit:(value:unknown)=>audits.push(value)}} as unknown as SystemRuntime;const app=Fastify();cleanup.push(()=>app.close());registerChannelRoutes(app,{runtime,store:vault});await app.ready();const headers={origin:'http://localhost',cookie:'fake=test','content-type':'application/json'};const result=await app.inject({method:'POST',url:'/api/admin/channels/accounts/miora/import',headers,payload:{credentials:jwt}});expect(result.statusCode).toBe(200);const id=result.json().id;expect((await app.inject({method:'POST',url:`/api/admin/channels/accounts/${id}/validate`,headers,payload:{}})).json()).toMatchObject({validationStatus:'unknown',remoteValidationPerformed:false,localCredentialStatus:'format-and-decryption-passed'});role='operator';expect((await app.inject({method:'PATCH',url:`/api/admin/channels/accounts/${id}`,headers,payload:{enabled:true}})).statusCode).toBe(403);expect((await app.inject({method:'GET',url:'/api/admin/channels/accounts',headers:{origin:'https://evil.invalid'}})).statusCode).toBe(403);expect(JSON.stringify(audits)).not.toContain(jwt);});
test('credential imports support more than twenty files while keeping superadmin, origin and audit protections', async () => {
  const db = new Database(':memory:');
  cleanup.push(() => { db.close(); });
  const vault = new ChannelStore(db, key);
  const audits: unknown[] = [];
  let role = 'superadmin';
  const runtime = {
    db,
    assertRequestOrigin: (req: Parameters<typeof assertSystemRequestOrigin>[0]) => assertSystemRequestOrigin(req, ['http://localhost']),
    requireAdmin: async (_req: unknown, permission?: string) => {
      if (permission === 'authorize' && role !== 'superadmin') throw new SystemError(403, 'SUPERADMIN_REQUIRED', 'Superadmin required');
      return owner;
    },
    store: { audit: (value: unknown) => audits.push(value) },
  } as unknown as SystemRuntime;
  const app = Fastify();
  cleanup.push(() => app.close());
  const changed = vi.fn(async () => {});
  registerChannelRoutes(app, { runtime, store: vault, changed });
  await app.ready();
  const headers = { origin: 'http://localhost', cookie: 'fake=test', 'content-type': 'application/json' };
  const url = '/api/admin/channels/accounts/miora/import';
  const tokens: string[] = [];
  const results: unknown[] = [];
  for (let index = 0; index < 25; index++) {
    const token = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ sub: 'batch-user-' + index, exp: 4102444800 })).toString('base64url') + '.fake';
    tokens.push(token);
    const response = await app.inject({ method: 'POST', url, headers, payload: { credentials: token, label: 'Account ' + index } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ label: 'Account ' + index, enabled: true, validationStatus: 'unknown' });
    results.push(response.json());
  }
  expect(vault.list().total).toBe(25);
  expect(changed).toHaveBeenCalledTimes(25);
  expect(audits).toHaveLength(25);
  for (const entry of audits) expect(entry).toMatchObject({ actorId: owner.id, action: 'channel.credentials.import', targetType: 'channelAccount' });
  const safeOutput = JSON.stringify({ audits, results, accounts: vault.list() });
  for (const token of tokens) expect(safeOutput).not.toContain(token);
  role = 'operator';
  expect((await app.inject({ method: 'POST', url, headers, payload: { credentials: jwt } })).statusCode).toBe(403);
  role = 'superadmin';
  expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://evil.invalid' }, payload: { credentials: jwt } })).statusCode).toBe(403);
  expect(audits).toHaveLength(25);
  expect(vault.list().total).toBe(25);
});
test('system claim delegates once to original worker using encrypted managed cookies and appends private hashed result',async()=>{
const dir=await mkdtemp(path.join(tmpdir(),'channel-bridge-'));cleanup.push(()=>rm(dir,{recursive:true,force:true}));const db=new Database(':memory:');cleanup.push(()=>{db.close();});const vault=new ChannelStore(db,key);const managed=vault.import(jwt);vault.update(managed.id,{enabled:true});const projects=new ProjectStore(db);const shared=projects.share('project',owner,{entities:[{type:'draft',id:'draft',fields:{name:'fake'}},{type:'shot',id:'shot',fields:{prompt:'fake'}}],collections:{}},[]);const jobs=new SystemJobStore(db,projects);db.exec('CREATE TABLE shared_project_media(project_id TEXT,generation INTEGER,entity_type TEXT,entity_id TEXT,hash TEXT,size INTEGER,mime TEXT,PRIMARY KEY(project_id,generation,entity_type,entity_id,hash))');const blobs=new LocalPrivateBlobStore(path.join(dir,'private'));const png=Buffer.from([137,80,78,71,13,10,26,10]);const hash=(await import('node:crypto')).createHash('sha256').update(png).digest('hex');await blobs.put(hash,png);db.prepare('INSERT INTO shared_project_media VALUES(?,?,?,?,?,?,?)').run('project',shared.generation,'shot','shot',hash,png.length,'image/png');const sessions=new ManagedSessionStore(dir,vault);const assets=new AssetStore(dir);const channelJobs=new JobStore({dataDir:dir});await Promise.all([sessions.initialize(),assets.initialize(),channelJobs.initialize()]);let calls=0;let resumed=0;const registry=new AdapterRegistry();registry.register({id:'miora-v1',allowedCookieDomains:['miora.design'],getCreditsFromCookies:async()=>({totalCredits:1000,breakdown:[]}),estimateJobCost:()=>1,runWithoutBrowser:async(cookies)=>{expect(readMioraTokens(cookies)!.authToken).toBe(jwt);calls++;return {videoUrl:'https://result.miora.design/fake.mp4',cookie:jwt};},resumeWithoutBrowser:async(_cookies,progress,input)=>{expect(progress.providerJobId).toBe('recorded-upstream');await expect(input.beforeSubmit!()).rejects.toThrow('reconciliation');resumed++;return {videoUrl:'https://result.miora.design/fake.mp4'};},run:async()=>{throw new Error('browser forbidden');}});const accountPool=new AccountPool(sessions,registry,{maxJobsPerAccount:1});const runner=new JobRunner(channelJobs,assets,sessions,registry,new BrowserPool(1,true),accountPool,{timeoutMs:1000,directTimeoutMs:1000});const runtime={db} as SystemRuntime;const bridge=new ChannelJobBridge({runtime,channels:vault,jobs,blobs,legacy:{jobs:channelJobs,assets,sessions,accountPool,runner},pollIntervalMs:5,fetchResult:async()=>new Response(Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]))});cleanup.push(()=>bridge.close());const created=jobs.create('project',owner,{requestId:'fake-request',generation:shared.generation,target:{type:'shot',id:'shot'},inputVersion:shared.revision,executor:'server',kind:'miora.video',parameters:{text:'fake',mediaHashes:[hash]}});await bridge.submit(created.job.id,owner);await vi.waitFor(()=>expect(jobs.row(created.job.id)!.status).toBe('succeeded'));expect(calls).toBe(1);expect(()=>jobs.claimServer(created.job.id,owner)).toThrow();expect(jobs.row(created.job.id)!.result).not.toContain(jwt);expect(await readdir(path.join(dir,'sessions'))).toEqual([]);
const recovery=jobs.create('project',owner,{requestId:'recovery-request',generation:shared.generation,target:{type:'shot',id:'shot'},inputVersion:projects.row('project')!.revision,executor:'server',kind:'miora.video',parameters:{text:'fake',mediaHashes:[hash]}});
const oldLease=jobs.claimServer(recovery.job.id,owner);jobs.markUncertain('project',recovery.job.id,owner,oldLease,'EXECUTION_OUTCOME_UNCERTAIN',true);
const legacyId='job_system_'+recovery.job.id.replace(/-/g,'');
channelJobs.create({adapterId:'miora-v1',sessionId:managed.id,text:'fake',assetId:channelJobs.list()[0]!.assetId},legacyId);
channelJobs.update(legacyId,{status:'failed',error:{code:'JOB_TIMEOUT',message:'fake timeout'},progress:{providerJobId:'recorded-upstream',updatedAt:new Date().toISOString()}});
await channelJobs.flushOrThrow(legacyId);db.prepare('INSERT INTO system_channel_jobs VALUES(?,?,?,?)').run(recovery.job.id,legacyId,managed.id,new Date().toISOString());
expect(await bridge.reconcile(recovery.job.id,owner)).toMatchObject({reconciliationPending:true});
await vi.waitFor(()=>expect(channelJobs.get(legacyId)!.status).toBe('succeeded'));
await bridge.reconcile(recovery.job.id,owner);expect(jobs.row(recovery.job.id)!.status).toBe('succeeded');
expect(calls).toBe(1);expect(resumed).toBe(1);expect(jobs.row(recovery.job.id)!.result).not.toContain(jwt);
for(const providerId of [undefined,'known-failed-render']) {
  const retryable=jobs.create('project',owner,{requestId:'failed-'+String(providerId),generation:shared.generation,target:{type:'shot',id:'shot'},inputVersion:projects.row('project')!.revision,executor:'server',kind:'miora.video',parameters:{text:'fake',mediaHashes:[hash]}});
  const lease=jobs.claimServer(retryable.job.id,owner);jobs.markUncertain('project',retryable.job.id,owner,lease,'RECONCILIATION_REQUIRED',true);
  const id='job_system_'+retryable.job.id.replace(/-/g,'');channelJobs.create({adapterId:'miora-v1',sessionId:managed.id,text:'fake',assetId:channelJobs.list()[0]!.assetId},id);
  channelJobs.update(id,{status:'failed',error:{code:providerId?'PROVIDER_RENDER_FAILED':'PROVIDER_NETWORK_ERROR',message:'isolated failure'},...(providerId?{progress:{providerJobId:providerId,updatedAt:new Date().toISOString()}}:{})});
  await channelJobs.flushOrThrow(id);db.prepare('INSERT INTO system_channel_jobs VALUES(?,?,?,?)').run(retryable.job.id,id,managed.id,new Date().toISOString());
  expect(await bridge.reconcile(retryable.job.id,owner)).toMatchObject({job:{status:'failed'},retryAllowed:true,billingUnknown:!providerId});
  expect(calls).toBe(1);expect(resumed).toBe(1);
}
});
