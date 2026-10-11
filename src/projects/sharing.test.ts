import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectStore } from './store.js';
import { ProjectError, commandSchema, type ProjectPrincipal, type ProjectRuntime } from './protocol.js';
import { registerProjectRoutes } from './routes.js';
import { registerSystemMediaRoutes, LocalPrivateBlobStore, checkMediaQuota } from '../system-media/routes.js';
import { registerSystemJobRoutes } from '../system-jobs/routes.js';
import { SystemJobStore, createSystemJobSchema } from '../system-jobs/store.js';

const principal = (id: string, sessionId = `${id}-session`): ProjectPrincipal => ({ id,sessionId,emailVerified:true,cloudEligible:true,sharingEligible:true });
const owner = principal('owner'); const editor = principal('editor'); const viewer = principal('viewer');
const initial = { entities: [{ type:'draft' as const,id:'draft-1',fields:{ title:'Original', description:'Text', appearance:{ color:'red',size:1 } } },{ type:'asset' as const,id:'asset-1',fields:{} }],collections:{ drafts:['draft-1'] } };
const members = [{ userId: 'editor',role:'editor' as const },{ userId:'viewer',role:'viewer' as const }];
const resources: { directory:string;db:Database.Database;app?:ReturnType<typeof Fastify> }[] = [];
it('unqueryable local outcome releases only the designated attempt and keeps billing unknown for bounded retry',()=>{
  const {db,projects}=setup();projects.share('retry-project',owner,initial,[]);let clock=1000;const jobs=new SystemJobStore(db,projects,()=>clock);
  const body={requestId:'unknown-first',generation:1,target:{type:'draft' as const,id:'draft-1'},inputVersion:0,executor:'local' as const,kind:'desktop.video',parameters:{}};
  const first=jobs.create('retry-project',owner,body);const lease=jobs.claim('retry-project',first.job.id,owner,1000);clock=3000;
  expect(()=>jobs.outcomeFailed('retry-project',first.job.id,principal('owner','different-device'),lease)).toThrow('Designated executor');
  expect(()=>jobs.outcomeFailed('retry-project',first.job.id,owner,{...lease,fence:lease.fence+1})).toThrow('fenced');
  expect(jobs.outcomeFailed('retry-project',first.job.id,owner,lease).job).toMatchObject({status:'failed',errorCode:'SUBMISSION_OUTCOME_UNKNOWN'});
  const next=jobs.create('retry-project',owner,{...body,requestId:'explicit-next-attempt'});expect(next.job.attempt).toBe(2);
  expect(()=>jobs.complete('retry-project',first.job.id,owner,lease,{localCompleted:true})).toThrow('fenced');
  expect(()=>jobs.create('retry-project',owner,{...body,requestId:'concurrent-next'})).toThrow('active attempt');
});
function setup() { const directory = mkdtempSync(path.join(os.tmpdir(),'sharing-test-')); const db = new Database(path.join(directory,'db.sqlite')); db.pragma('journal_mode = WAL'); const projects = new ProjectStore(db); resources.push({ directory,db }); return { directory,db,projects }; }
afterEach(async () => { for (const resource of resources.splice(0)) { await resource.app?.close(); if (resource.db.open) resource.db.close(); rmSync(resource.directory,{ recursive:true,force:true }); } });
function update(commandId:string, field:string, value:unknown, expected=0) { return commandSchema.parse({ commandId,generation:1,operations:[{ kind:'update',type:'draft',id:'draft-1',set:{[field]:value},expected:{[field]:expected} }] }); }
function jobBody(requestId='request-1', executor:'local'|'server'='local') { return createSystemJobSchema.parse({ requestId,generation:1,target:{type:'asset',id:'asset-1'},inputVersion:0,executor,...(executor==='local'?{executorSessionId:owner.sessionId}:{}),kind:'export',parameters:{} }); }
async function routes() {
  const state = setup(); const app = Fastify(); resources.at(-1)!.app = app;
  const identities:Record<string,ProjectPrincipal> = { owner,editor,viewer,operator:{...principal('operator'),adminRole:'operator'},inactive:{...principal('inactive'),cloudEligible:false},ineligible:{...principal('ineligible'),sharingEligible:false} };
  const runtime:ProjectRuntime = { db:state.db,authenticate:async request => identities[String(request.headers['x-user'])]??null,assertRequestOrigin:request=>{ if(request.headers.origin!=='https://studio.test') throw new ProjectError(403,'INVALID_ORIGIN','Invalid origin'); },store:{ getIdentity:id=>identities[id]??null,getIdentityByEmail:email=>identities[email.split('@')[0]!]??null,audit:()=>{} } };
  registerProjectRoutes(app,{runtime,store:state.projects}); registerSystemMediaRoutes(app,{runtime,projects:state.projects,blobs:new LocalPrivateBlobStore(path.join(state.directory,'blobs'))}); const jobs = registerSystemJobRoutes(app,{runtime,projects:state.projects});
  await app.ready(); const headers = (id:string)=>({'x-user':id,origin:'https://studio.test'}); return { ...state,app,jobs,headers };
}

describe('shared project durable commands and ACL',()=>{
  it('merges disjoint fields and preserves conflicting confirmed state and receipts across reopen',()=>{
    const {db,directory,projects}=setup(); projects.share('project-1',owner,initial,members,'share-1');
    const first=projects.apply('project-1',owner,update('command-1','title','Edited'));
    expect(first.status).toBe(200); expect(projects.apply('project-1',editor,update('command-2','description','Other')).status).toBe(200);
    const conflict=projects.apply('project-1',editor,update('command-3','title','Conflict'));
    expect(conflict.status).toBe(409); expect((conflict.body.snapshot as {revision:number}).revision).toBe(2);
    expect(projects.snapshot('project-1',owner).entities[0]!.fields.title).toBe('Edited');
    db.close(); const reopened=new Database(path.join(directory,'db.sqlite')); resources.at(-1)!.db=reopened; const durable=new ProjectStore(reopened);
    expect(durable.apply('project-1',owner,update('command-1','title','Edited'))).toEqual(first);
    expect(()=>durable.apply('project-1',owner,update('command-1','title','Different'))).toThrow('Command ID');
    expect(durable.apply('project-1',editor,update('command-3','title','Conflict'))).toEqual(conflict);
  });
  it('merges nested sibling fields but conflicts with parent replacement and rejects array index edits',()=>{
    const {projects}=setup();projects.share('project-1',owner,initial,members);
    expect(projects.apply('project-1',owner,update('color','/appearance/color','blue')).status).toBe(200);
    expect(projects.apply('project-1',editor,update('size','/appearance/size',3)).status).toBe(200);
    expect(projects.apply('project-1',editor,update('parent','appearance',{color:'pink',size:9})).status).toBe(409);
    expect(projects.snapshot('project-1',owner).entities[0]!.fields.appearance).toEqual({color:'blue',size:3});
    expect(projects.apply('project-1',owner,commandSchema.parse({commandId:'unset-path',generation:1,operations:[{kind:'update',type:'draft',id:'draft-1',unset:['/appearance/color'],expected:{'/appearance/color':1}}]})).status).toBe(200);
    expect(projects.snapshot('project-1',owner).entities[0]!.fields.appearance).toEqual({size:3});
    expect(()=>projects.apply('project-1',owner,update('path','/description/a','x'))).toThrow('scalar');
  });
  it('checks atomic structure operations against one base collection version and preserves tombstones',()=>{
    const {projects}=setup();projects.share('project-1',owner,initial,members);
    const command=commandSchema.parse({commandId:'structure',generation:1,operations:[{kind:'insert',type:'draft',id:'draft-2',fields:{title:'New'},collection:'drafts',expectedCollectionVersion:0},{kind:'reorder',collection:'drafts',ids:['draft-2','draft-1'],expectedCollectionVersion:0}]});
    expect(projects.apply('project-1',owner,command).status).toBe(200);
    expect(projects.apply('project-1',editor,commandSchema.parse({commandId:'stale-structure',generation:1,operations:[{kind:'reorder',collection:'drafts',ids:['draft-1','draft-2'],expectedCollectionVersion:0}]})).status).toBe(409);
    expect(projects.apply('project-1',owner,commandSchema.parse({commandId:'remove',generation:1,operations:[{kind:'delete',type:'draft',id:'draft-2',collection:'drafts',expectedCollectionVersion:1,expectedVersions:{title:1}}]})).status).toBe(200);
    expect(projects.apply('project-1',owner,commandSchema.parse({commandId:'revive',generation:1,operations:[{kind:'insert',type:'draft',id:'draft-2',fields:{}}]}))).toMatchObject({status:409,body:{error:{code:'ENTITY_ID_REUSED'}}});
    expect(projects.apply('project-1',owner,commandSchema.parse({commandId:'explicit-restore',generation:1,operations:[{kind:'restore',type:'draft',id:'draft-2',fields:{title:'Restored'},expectedDeletedRevision:2,collection:'drafts',expectedCollectionVersion:2}]})).status).toBe(200);
    expect(projects.snapshot('project-1',owner).entities.find(entity=>entity.id==='draft-2')!.deleted).toBe(false);
  });
  it('appends candidates from two editors without replacing prior media or relying on array indexes',()=>{
    const {projects}=setup();projects.share('project-1',owner,{entities:[{type:'shot',id:'shot-1',fields:{storyboardBoards:[{boardId:1,imagePrompt:'hello',imageVariants:[]}]}}],collections:{}},members);
    const append=(commandId:string,candidateId:string)=>commandSchema.parse({commandId,generation:1,operations:[{kind:'appendCandidate',type:'shot',id:'shot-1',field:'/storyboardBoards/@boardId=1/imageVariants',candidateId,value:{id:candidateId,hash:candidateId}}]});
    expect(projects.apply('project-1',owner,append('first','candidate-a')).status).toBe(200);expect(projects.apply('project-1',editor,append('second','candidate-b')).status).toBe(200);
    const boards=projects.snapshot('project-1',owner).entities[0]!.fields.storyboardBoards as {boardId:number;imageVariants:unknown[]}[];expect(boards[0]!.imageVariants).toHaveLength(2);
    expect(()=>projects.apply('project-1',owner,commandSchema.parse({commandId:'index',generation:1,operations:[{kind:'update',type:'shot',id:'shot-1',set:{'/storyboardBoards/0/imagePrompt':'wrong'},expected:{'/storyboardBoards/0/imagePrompt':0}}]}))).toThrow('stable ID');
    expect(projects.apply('project-1',owner,commandSchema.parse({commandId:'stable',generation:1,operations:[{kind:'update',type:'shot',id:'shot-1',set:{'/storyboardBoards/@boardId=1/imagePrompt':'edit'},expected:{'/storyboardBoards/@boardId=1/imagePrompt':0}}]})).status).toBe(200);
  });
  it('rejects viewer/admin private reads, revocation, inactive accounts and stale generations',async()=>{
    const {app,headers,projects}=await routes();projects.share('project-1',owner,initial,members,'share-1');
    expect((await app.inject({method:'POST',url:'/api/system/projects/project-1/commands',headers:headers('viewer'),payload:update('c','title','x')})).statusCode).toBe(403);
    for(const user of ['operator','inactive','ineligible']) expect((await app.inject({url:'/api/system/projects/project-1/snapshot',headers:headers(user)})).statusCode).toBe(403);
    const admin=(await app.inject({url:'/api/admin/projects',headers:headers('operator')})).json();expect(admin.data[0]).not.toHaveProperty('entities'); expect(JSON.stringify(admin)).not.toContain('Original');
    projects.setMembers('project-1',owner,[{userId:'viewer',role:'viewer'}]);expect(()=>projects.snapshot('project-1',editor)).toThrow('permission');
    projects.disable('project-1',owner);expect(()=>projects.snapshot('project-1',viewer)).toThrow('unavailable');expect(()=>projects.share('project-1',owner,initial,members,'share-1')).toThrow('superseded');
    expect(projects.share('project-1',owner,initial,members,'share-2').generation).toBe(2); expect(()=>projects.apply('project-1',owner,update('old','title','x'))).toThrow('generation');
  });
  it.each(['cardKey','secret_key','access-key','authToken','password','checkpoint','inputSnapshot','outputSnapshot','driverCheckpoint','batchRun','imageBase64','videoBase64'])('rejects private %s in initial snapshots, nested updates and pointer paths before persistence',key=>{
    const {projects,db}=setup();const secret='fake-sensitive-test-value';expect(()=>projects.share('private',owner,{entities:[{type:'draft',id:'draft-private',fields:{settings:{[key]:secret}}}],collections:{}},[])).toThrow('cannot be uploaded');expect(projects.row('private')).toBeUndefined();projects.share('project-1',owner,initial,members);expect(()=>projects.apply('project-1',owner,update('private-nested','settings',{[key]:secret}))).toThrow();expect(()=>projects.apply('project-1',owner,update('private-pointer',`/settings/${key}`,secret))).toThrow();expect(JSON.stringify(db.prepare('SELECT snapshot FROM shared_projects').all())).not.toContain(secret);expect(db.prepare('SELECT * FROM shared_project_receipts').all()).toHaveLength(0);
  });
  it('allows administrators only to revoke/downgrade and never manufacture private draft access',async()=>{
    const {app,headers,projects}=await routes();projects.share('project-1',owner,initial,members);
    const mutation=(userId:string,role:string)=>app.inject({method:'PUT',url:`/api/admin/projects/project-1/members/${userId}`,headers:headers('operator'),payload:{role}});
    expect((await mutation('operator','viewer')).statusCode).toBe(403);expect((await mutation('viewer','editor')).statusCode).toBe(403);expect((await mutation('editor','viewer')).statusCode).toBe(200);expect(projects.members('project-1').find(member=>member.userId==='editor')!.role).toBe('viewer');expect((await app.inject({url:'/api/system/projects/project-1/snapshot',headers:headers('operator')})).statusCode).toBe(403);
  });
  it('revalidates held principals for revoked sessions, account validity and sharing qualification',()=>{
    const {db}=setup();let fresh:ProjectPrincipal=owner;let revoked=false;const projects=new ProjectStore(db,()=>{if(revoked)throw new ProjectError(401,'SESSION_REVOKED','Session revoked');return fresh;});projects.share('project-1',owner,initial,members);const jobs=new SystemJobStore(db,projects);const created=jobs.create('project-1',owner,jobBody());const lease=jobs.claim('project-1',created.job.id,owner);fresh={...owner,cloudEligible:false};expect(()=>jobs.heartbeat('project-1',created.job.id,owner,lease)).toThrow('active account');fresh={...owner,sharingEligible:false};expect(()=>projects.snapshot('project-1',owner)).toThrow('sharing eligibility');fresh=owner;revoked=true;expect(()=>jobs.complete('project-1',created.job.id,owner,lease,{localCompleted:true})).toThrow('Session revoked');expect(jobs.row(created.job.id)!.status).toBe('running');
  });
  it('offers bounded project-scope snapshot recovery on cursor gap and rejects secrets/origin',async()=>{
    const {app,headers,projects,db}=await routes();projects.share('project-1',owner,initial,members);
    projects.apply('project-1',owner,update('one','title','A'));projects.apply('project-1',owner,update('two','description','B'));
    db.prepare('DELETE FROM shared_project_changes WHERE revision=1').run();expect(projects.changes('project-1',owner,1,0)).toMatchObject({snapshotRequired:true,revision:2});
    expect(projects.changes('project-1',owner,1,20)).toMatchObject({snapshotRequired:true});
    expect(()=>projects.apply('project-1',owner,update('secret','apiKey','secret'))).toThrow('cannot be uploaded');
    expect(()=>projects.apply('project-1',owner,update('origin','origin','task'))).toThrow('cannot be uploaded');
    expect((await app.inject({method:'POST',url:'/api/system/projects/project-1/commands',headers:{'x-user':'owner'},payload:update('crosssite','title','x')})).statusCode).toBe(403);
  });
});

describe('private media',()=>{
  it('bounds retained project/owner metadata by unique hashes without double charging reused media',async()=>{
    const {db,projects}=setup();const app=Fastify();resources.at(-1)!.app=app;const blobs=new Map<string,Buffer>();let puts=0;const runtime:ProjectRuntime={db,authenticate:async()=>owner};projects.share('project-1',owner,initial,members);registerSystemMediaRoutes(app,{runtime,projects,blobs:{put:async(hash,bytes)=>{puts++;blobs.set(hash,bytes);},get:async hash=>blobs.get(hash)??null},quota:{projectBytes:20,ownerBytes:25}});const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2]);const hash=createHash('sha256').update(bytes).digest('hex');const upload=(content:Buffer,entityId='asset-1')=>app.inject({method:'POST',url:'/api/system/projects/project-1/media',payload:{generation:1,assetId:entityId,hash:createHash('sha256').update(content).digest('hex'),size:content.length,mime:'image/png',data:content.toString('base64')}});expect((await upload(bytes)).statusCode).toBe(200);expect((await upload(bytes)).statusCode).toBe(200);expect(()=>checkMediaQuota(db,'project-1',hash,10,{projectBytes:10,ownerBytes:10})).not.toThrow();const second=Buffer.from(bytes);second[9]=3;expect((await upload(second)).statusCode).toBe(200);const third=Buffer.from(bytes);third[9]=4;expect((await upload(third)).statusCode).toBe(413);expect(puts).toBe(3);projects.share('project-2',owner,initial,[]);expect(()=>checkMediaQuota(db,'project-2','a'.repeat(64),10,{projectBytes:100,ownerBytes:25})).toThrow('quota');projects.disable('project-1',owner);expect(()=>checkMediaQuota(db,'project-2','b'.repeat(64),10,{ownerBytes:25})).toThrow('quota');
  });
  it('rechecks quotas after asynchronous blob writing before acknowledging metadata',async()=>{
    const {db,projects}=setup();const app=Fastify();resources.at(-1)!.app=app;projects.share('project-1',owner,initial,[]);const runtime:ProjectRuntime={db,authenticate:async()=>owner};const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2]);const hash=createHash('sha256').update(bytes).digest('hex');registerSystemMediaRoutes(app,{runtime,projects,quota:{projectBytes:10,ownerBytes:10},blobs:{put:async()=>{db.prepare('INSERT INTO shared_project_media VALUES(?,?,?,?,?,?,?)').run('project-1',1,'asset','asset-1','a'.repeat(64),10,'image/png');},get:async()=>null}});const response=await app.inject({method:'POST',url:'/api/system/projects/project-1/media',payload:{generation:1,assetId:'asset-1',hash,size:10,mime:'image/png',data:bytes.toString('base64')}});expect(response.statusCode).toBe(413);expect(db.prepare('SELECT hash FROM shared_project_media WHERE hash=?').get(hash)).toBeUndefined();
  });
  it('verifies hash/type, bounds uploads to explicit sharing, and rechecks revoked reads',async()=>{
    const {app,headers,projects}=await routes();const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0]);const hash=createHash('sha256').update(bytes).digest('hex');const body={generation:1,assetId:'asset-1',hash,size:bytes.length,mime:'image/png',data:bytes.toString('base64')};const upload='/api/system/projects/project-1/media';
    expect((await app.inject({method:'POST',url:upload,headers:headers('owner'),payload:body})).statusCode).toBe(404);
    projects.share('project-1',owner,initial,members);
    expect((await app.inject({method:'POST',url:upload,headers:headers('viewer'),payload:body})).statusCode).toBe(403);
    expect((await app.inject({method:'POST',url:upload,headers:headers('owner'),payload:{...body,hash:'0'.repeat(64)}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:upload,headers:headers('owner'),payload:{...body,mime:'image/jpeg'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:upload,headers:headers('owner'),payload:body})).statusCode).toBe(200);
    expect((await app.inject({url:`${upload}/${hash}`,headers:headers('viewer')})).rawPayload).toEqual(bytes);
    expect((await app.inject({url:`${upload}/${hash}`,headers:headers('operator')})).statusCode).toBe(403);
    projects.setMembers('project-1',owner,[]);expect((await app.inject({url:`${upload}/${hash}`,headers:headers('viewer')})).statusCode).toBe(403);
    projects.disable('project-1',owner);expect((await app.inject({url:`${upload}/${hash}`,headers:headers('owner')})).statusCode).toBe(404);
  });
});

describe('system task arbitration',()=>{
  it('deduplicates requests, permits only one active target and binds local execution to session',()=>{
    const {projects,db}=setup();projects.share('project-1',owner,initial,members);const jobs=new SystemJobStore(db,projects);const created=jobs.create('project-1',owner,jobBody());
    expect(jobs.create('project-1',owner,jobBody())).toMatchObject({created:false,job:{id:created.job.id}});
    expect(()=>jobs.create('project-1',owner,{...jobBody(),kind:'other'})).toThrow('another payload');
    expect(()=>jobs.create('project-1',principal('owner','second-device'),{...jobBody('request-2'),executorSessionId:'second-device'})).toThrow('active attempt');
    expect(()=>jobs.claim('project-1',created.job.id,principal('owner','second-device'))).toThrow('designated');
    const lease=jobs.claim('project-1',created.job.id,owner);expect(()=>jobs.claim('project-1',created.job.id,owner)).toThrow('held');
    jobs.cancel('project-1',created.job.id,owner);expect(()=>jobs.complete('project-1',created.job.id,owner,lease,{hash:'x'})).toThrow('fenced');expect(jobs.row(created.job.id)!.status).toBe('canceled');
    expect(jobs.create('project-1',owner,jobBody('retry')).job.attempt).toBe(2);
  });
  it('binds omitted local executor to the authenticated session and completes metadata durably',()=>{
    const {projects,db}=setup();projects.share('project-1',owner,initial,members);const jobs=new SystemJobStore(db,projects);const body=jobBody();delete body.executorSessionId;const created=jobs.create('project-1',owner,body);expect(jobs.row(created.job.id)!.executor_session).toBe(owner.sessionId);expect(jobs.create('project-1',principal('owner','second-device'),body).job.id).toBe(created.job.id);expect(()=>jobs.claim('project-1',created.job.id,principal('owner','second-device'))).toThrow('designated');const lease=jobs.claim('project-1',created.job.id,owner);const complete=jobs.complete('project-1',created.job.id,owner,lease,{localCompleted:true});expect(complete.revision).toBe(0);expect(projects.snapshot('project-1',owner).entities[1]!.fields).not.toHaveProperty('candidates');expect(jobs.complete('project-1',created.job.id,owner,lease,{localCompleted:true})).toEqual(complete);
  });
  it('keeps unknown execution active and fenced after expiry without permitting automatic repeat',()=>{
    const {projects,db}=setup();projects.share('project-1',owner,initial,members);let now=10000;const jobs=new SystemJobStore(db,projects,()=>now);const created=jobs.create('project-1',owner,jobBody()).job;const lease=jobs.claim('project-1',created.id,owner,1000);now+=2000;expect(jobs.fail('project-1',created.id,owner,lease,'SHARED_EXECUTION_UNCERTAIN').job.status).toBe('uncertain');expect(()=>jobs.claim('project-1',created.id,owner)).toThrow('cannot be claimed');expect(()=>jobs.create('project-1',owner,jobBody('next'))).toThrow('active attempt');expect(()=>jobs.complete('project-1',created.id,owner,lease,{localCompleted:true})).toThrow('fenced');jobs.cancel('project-1',created.id,owner);expect(()=>jobs.markUncertain('project-1',created.id,owner,lease)).toThrow('fenced');expect(jobs.row(created.id)!.status).toBe('canceled');
  });
  it('fences stale local leases and refuses automatic server takeover',()=>{
    const {projects,db}=setup();projects.share('project-1',owner,initial,members);let now=10000;const jobs=new SystemJobStore(db,projects,()=>now);const local=jobs.create('project-1',owner,jobBody());const first=jobs.claim('project-1',local.job.id,owner,1000);now+=1001;const second=jobs.claim('project-1',local.job.id,owner,1000);
    expect(second.fence).toBe(first.fence+1);expect(()=>jobs.complete('project-1',local.job.id,owner,first,{})).toThrow('fenced');expect(jobs.complete('project-1',local.job.id,owner,second,{hash:'safe'}).job.status).toBe('succeeded');
    const server=jobs.create('project-1',owner,{...jobBody('server','server'),inputVersion:1});expect(()=>jobs.claim('project-1',server.job.id,owner)).toThrow('trusted runner');jobs.claimServer(server.job.id,owner,1000);now+=1001;expect(()=>jobs.claimServer(server.job.id,owner)).toThrow('reconcile');
  });
  it('cancels active jobs on whitelist revocation and sharing disable without resurrecting leases',()=>{
    const {projects,db}=setup();projects.share('project-1',owner,initial,members);const jobs=new SystemJobStore(db,projects);const editorJob=jobs.create('project-1',editor,{...jobBody(),executorSessionId:editor.sessionId});const lease=jobs.claim('project-1',editorJob.job.id,editor);projects.setMembers('project-1',owner,[]);expect(jobs.row(editorJob.job.id)!.status).toBe('canceled');projects.setMembers('project-1',owner,members);expect(()=>jobs.complete('project-1',editorJob.job.id,editor,lease,{hash:'late'})).toThrow('fenced');const ownerJob=jobs.create('project-1',owner,jobBody());projects.disable('project-1',owner);expect(jobs.row(ownerJob.job.id)!.status).toBe('canceled');projects.share('project-1',owner,initial,members);expect(jobs.create('project-1',owner,{...jobBody('new-generation'),generation:2}).created).toBe(true);
  });
  it('reconciles proven uncertain server success exactly once without submitting another attempt',()=>{
    const {db,projects}=setup();projects.share('project-1',owner,initial,members);const jobs=new SystemJobStore(db,projects);const created=jobs.create('project-1',owner,jobBody('server','server')).job;jobs.claimServer(created.id,owner);db.prepare("UPDATE system_jobs SET status='uncertain',lease_hash=NULL,lease_until=NULL WHERE id=?").run(created.id);expect(()=>jobs.reconcileCompleted(created.id,viewer,{media:{hash:'a'}})).toThrow('permission');const completed=jobs.reconcileCompleted(created.id,owner,{media:{hash:'a'}});expect(completed.job.status).toBe('succeeded');expect(jobs.reconcileCompleted(created.id,owner,{media:{hash:'a'}})).toEqual(completed);expect(()=>jobs.reconcileCompleted(created.id,owner,{media:{hash:'b'}})).toThrow('confirmed receipt');expect(Object.keys(projects.snapshot('project-1',owner).entities[1]!.fields.resultCandidates as Record<string,unknown>)).toHaveLength(1);expect(jobs.row(created.id)!.attempt).toBe(1);
  });
  it('append results preserves prior candidates, protects deleted targets, and redacts admin status',async()=>{
    const {projects,jobs,app,headers}=await routes();projects.share('project-1',owner,initial,members);
    const job=jobs.create('project-1',owner,jobBody()).job;const lease=jobs.claim('project-1',job.id,owner);const resultA=jobs.complete('project-1',job.id,owner,lease,{hash:'result-a'});expect(jobs.complete('project-1',job.id,owner,lease,{hash:'result-a'})).toEqual(resultA);expect(()=>jobs.complete('project-1',job.id,owner,lease,{hash:'different'})).toThrow('original result');
    const second=jobs.create('project-1',owner,{...jobBody('request-2'),inputVersion:1}).job;const secondLease=jobs.claim('project-1',second.id,owner);jobs.complete('project-1',second.id,owner,secondLease,{hash:'result-b'});
    expect(Object.keys(projects.snapshot('project-1',owner).entities[1]!.fields.resultCandidates as Record<string,unknown>).length).toBe(2);
    const admin=(await app.inject({url:'/api/admin/system-jobs',headers:headers('operator')})).json();expect(JSON.stringify(admin)).not.toContain('result-a');expect(JSON.stringify(admin)).not.toContain('owner-session');expect(admin.data[0]).not.toHaveProperty('input');
    const third=jobs.create('project-1',owner,{...jobBody('request-3'),inputVersion:2}).job;const thirdLease=jobs.claim('project-1',third.id,owner);
    projects.apply('project-1',owner,commandSchema.parse({commandId:'delete-target',generation:1,operations:[{kind:'delete',type:'asset',id:'asset-1',expectedVersions:{resultCandidates:2}}]}));
    expect(()=>jobs.complete('project-1',third.id,owner,thirdLease,{hash:'late'})).toThrow('fenced');
  });
});
