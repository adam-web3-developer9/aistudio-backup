import { expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../app.js';
import { config } from '../config.js';
import { JobRunner } from '../jobs/job-runner.js';
import type { JobStore } from '../stores/job-store.js';
import { MioraAdapter } from '../adapters/miora-adapter.js';
import { ChannelStore } from './store.js';
import { MioraUploadIntentStore } from './miora-upload-intents.js';
import { fetch as providerFetch } from 'undici';
import { ManagedSessionStore } from './session-store.js';
vi.mock('undici', async importOriginal => ({...await importOriginal<typeof import('undici')>(),fetch:vi.fn(async()=>{throw new Error('Provider calls forbidden');})}));

test('real HTTP accepts large Miora options, preserves idempotency and active inline leases before a disabled runner', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'miora-options-http-')), original={...config}, db=new Database(':memory:');
  let app:FastifyInstance|undefined;
  const key='isolated-options-api-key-at-least-32-characters';
  try {
    Object.assign(config,{dataDir:path.join(directory,'data'),apiKey:key,mioraProxyUrl:'http://127.0.0.1:1',
      hailuoTokenFile:path.join(directory,'tokens.txt'),dreamMakerAccountFile:path.join(directory,'dreammaker.txt'),higgsfieldAccountFile:path.join(directory,'higgsfield.txt'),
      mioraAccountFile:path.join(directory,'miora.txt'),mioraImportDir:path.join(directory,'imports')});
    await mkdir(config.mioraImportDir);
    await Promise.all([config.hailuoTokenFile,config.dreamMakerAccountFile,config.higgsfieldAccountFile,config.mioraAccountFile].map(file=>writeFile(file,'')));
    const channels=new ChannelStore(db,Buffer.alloc(32,31).toString('base64'));
    channels.import('eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({sub:'options-user',exp:4102444800})).toString('base64url')+'.fake');
    const credits={totalCredits:1000,breakdown:[]};
    vi.spyOn(MioraAdapter.prototype,'getCreditsFromCookies').mockResolvedValue(credits);
    const submit=vi.spyOn(JobRunner.prototype,'submit').mockImplementation(()=>{});
    app=await buildApp({managedChannels:channels,managedGateway:true,warmup:false,managedAccountCreditReader:async()=>credits});
    const base=await app.listen({host:'127.0.0.1',port:0});
    const post=async(url:string,body:unknown,apiKey=key)=>{
      const text=JSON.stringify(body);
      const response=await fetch(base+url,{method:'POST',headers:{'content-type':'application/json','x-api-key':apiKey},
        body:Readable.from((function*(){for(let offset=0;offset<text.length;offset+=32*1024)yield text.slice(offset,offset+32*1024);})()),duplex:'half'} as unknown as RequestInit);
      return {status:response.status,body:await response.json() as Record<string,unknown>};
    };
    const large='options-'.repeat(400_000), options={modelId:'minimax-h3',durationSeconds:4,resolution:large};
    expect(Buffer.byteLength(JSON.stringify(options))).toBeGreaterThan(2*1024*1024);
    const stagedBody={idempotencyKey:'http-staged-options-key',assetCount:1,options};
    const staged=await post('/v1/upload-intents/staged',stagedBody); expect(staged.status).toBe(201);
    const repeated=await post('/v1/upload-intents/staged',stagedBody); expect(repeated.status).toBe(200); expect(repeated.body.id).toBe(staged.body.id);
    const store=new MioraUploadIntentStore(db,key), account=store.page(String(staged.body.id),0,1).accountId;
    const storedOptions=JSON.parse((db.prepare('SELECT options_json FROM video_gateway_upload_intents WHERE id=?').get(staged.body.id) as {options_json:string}).options_json);
    expect(storedOptions).toMatchObject({modelId:'minimax-h3',durationSeconds:4});
    expect(storedOptions.resolution === large).toBe(true);
    // A cache hit exercises the original inline route without COS signing/upload.
    const asset={sha256:'a'.repeat(64),size:8,mimeType:'image/png',kind:'image' as const};
    db.prepare('INSERT INTO video_gateway_miora_cos_cache VALUES(?,?,?,?,?,?,?,?)').run(account,asset.sha256,8,asset.mimeType,asset.kind,'prefix/reference.png',new Date().toISOString(),new Date().toISOString());
    expect((await post('/v1/upload-intents',{idempotencyKey:'http-inline-options-key',options,assets:[asset]})).status).toBe(201);
    const inline=store.create('http-inline-heartbeat-key',account,[{...asset,index:0,cosKey:'prefix/inline.png',status:'upload_required'}]);
    db.prepare('UPDATE video_gateway_upload_intents SET expires_at=?,reservation_until=? WHERE id=?').run('2000-01-01T00:00:00Z','2000-01-01T00:00:00Z',inline);
    const heartbeat=await fetch(`${base}/v1/upload-intents/${inline}/status`,{headers:{'x-api-key':key}}); expect(heartbeat.status).toBe(200); await heartbeat.text();
    expect(Date.parse(store.summary(inline).expiresAt)).toBeGreaterThan(Date.now());
    expect((await post(`/v1/upload-intents/${inline}/complete`,{indexes:[0]})).status).toBe(200);
    const jobBody={adapterId:'miora-v1',uploadIntentId:inline,text:'ordinary prompt',options};
    const job=await post('/v1/jobs',jobBody); expect(job.status).toBe(202);
    const sameJob=await post('/v1/jobs',jobBody); expect(sameJob.status).toBe(202); expect(sameJob.body.jobId).toBe(job.body.jobId);
    const jobs=app.getDecorator<{jobs:JobStore}>('channelRuntime').jobs;
    expect(jobs.get(String(job.body.jobId))?.options?.resolution).toBe(large);
    expect(submit).toHaveBeenCalledTimes(2); // existing queued ID is reclaimed, no new job.
    expect(db.prepare('SELECT COUNT(*) count FROM video_gateway_jobs').get()).toEqual({count:1});
    const consumedExpiry=store.summary(inline).expiresAt;
    const consumedHeartbeat=await fetch(`${base}/v1/upload-intents/${inline}/status`,{headers:{'x-api-key':key}}); await consumedHeartbeat.text();
    expect(store.summary(inline).expiresAt).toBe(consumedExpiry);
    expect((await post('/v1/upload-intents/staged',{...stagedBody,options:{...options,durationSeconds:'invalid'}})).status).toBe(400);
    const denied=await new Promise<number>((resolve,reject)=>{
      const req=httpRequest(base+'/v1/upload-intents/staged',{method:'POST',headers:{'content-type':'application/json','content-length':3*1024*1024,'x-api-key':'wrong'}},res=>{res.resume();res.once('end',()=>{resolve(res.statusCode!);req.destroy();});});
      req.once('error',reject);req.flushHeaders(); // The server answers without reading the absent large body.
    });
    expect(denied).toBe(401);
    const unavailable=store.create('http-missing-credential-key',account,[{...asset,index:0,cosKey:'',publicUrl:'https://source.invalid/reference.png',status:'importing'}]);
    const missing=vi.spyOn(ManagedSessionStore.prototype,'get').mockResolvedValue(undefined);
    const prepare=await fetch(`${base}/v1/upload-intents/${unavailable}/status`,{headers:{'x-api-key':key}}); await prepare.text();
    await vi.waitFor(()=>expect(store.describePage(unavailable,0,1).items[0]).toMatchObject({status:'failed',error:{
      reason:'UPLOAD_INTENT_ACCOUNT_UNAVAILABLE',stage:'cos_grant',retryable:false}}));
    missing.mockRestore();
    expect(providerFetch).not.toHaveBeenCalled();
  } finally {await app?.close();vi.restoreAllMocks();Object.assign(config,original);db.close();await rm(directory,{recursive:true,force:true});}
},15_000);
