import {afterEach,expect,test,vi} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProjectStore} from '../projects/store.js';
import {SystemJobStore,type SystemJobRow} from '../system-jobs/store.js';
import {LocalPrivateBlobStore,type MediaPolicy} from '../system-media/routes.js';
import {ChannelStore} from './store.js';
import {ChannelJobBridge} from './bridge.js';
import type {SystemRuntime} from '../system/index.js';
const cleanup:Array<()=>Promise<void>|void>=[];afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});
const owner={id:'owner',sessionId:'isolated',emailVerified:true,cloudEligible:true,sharingEligible:true};
async function fixture(maxFileBytes=Number.MAX_SAFE_INTEGER, options: {mediaPolicy?:Partial<MediaPolicy>;fetchResult?:typeof fetch}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'result-stream-test-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const db=new Database(':memory:');cleanup.push(()=>{db.close();});const projects=new ProjectStore(db);projects.share('project',owner,{entities:[{type:'shot',id:'shot',fields:{}}],collections:{}},[]);
  db.exec('CREATE TABLE shared_project_media(project_id TEXT,generation INTEGER,entity_type TEXT,entity_id TEXT,hash TEXT,size INTEGER,mime TEXT,PRIMARY KEY(project_id,generation,entity_type,entity_id,hash))');
  const jobs=new SystemJobStore(db,projects);const created=jobs.create('project',owner,{requestId:'result',generation:1,target:{type:'shot',id:'shot'},inputVersion:0,executor:'server',kind:'miora.video',parameters:{}});
  const blobs=new LocalPrivateBlobStore(directory);const bridge=new ChannelJobBridge({runtime:{db} as SystemRuntime,channels:new ChannelStore(db),jobs,blobs,mediaPolicy:{maxFileBytes,...options.mediaPolicy},fetchResult:options.fetchResult??(async()=>{
    let count=0;return new Response(new ReadableStream({pull(controller){if(count++===384){controller.close();return;}const chunk=Buffer.alloc(64*1024,3);if(count===1)Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]).copy(chunk);controller.enqueue(chunk);}}),{headers:{'content-length':String(384*64*1024)}});
  })});cleanup.push(()=>bridge.close());return {bridge,blobs,row:jobs.row(created.job.id)!};
}
const materialize=(bridge:ChannelJobBridge,row:SystemJobRow)=>(bridge as unknown as {materialize:(row:SystemJobRow,principal:typeof owner,raw:unknown)=>Promise<{media:{hash:string,size:number}}>}).materialize(row,owner,{videoUrl:'https://result.miora.design/video.mp4'});
test('server video results over 20 MiB stream to private storage without the buffer path',async()=>{
  const {bridge,blobs,row}=await fixture();const bufferPath=vi.spyOn(blobs,'put').mockRejectedValue(new Error('whole-file buffer path forbidden'));const streamPath=vi.spyOn(blobs,'putStream');
  const result=await materialize(bridge,row);expect(result.media.size).toBe(24*1024*1024);expect(bufferPath).not.toHaveBeenCalled();expect(streamPath).toHaveBeenCalledTimes(1);
  const stream=await blobs.verifiedRead(result.media.hash,result.media.size);expect(stream).toBeTruthy();const hash=createHash('sha256');for await(const chunk of stream!)hash.update(chunk);expect(hash.digest('hex')).toBe(result.media.hash);
});
test('deprecated result size quota does not reject an existing video',async()=>{
  const {bridge,row}=await fixture(21*1024*1024);await expect(materialize(bridge,row)).resolves.toMatchObject({media:{size:24*1024*1024}});
});
test('result transfers queue while busy and preserve existing outcomes without a 429',async()=>{
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const {bridge,row}=await fixture(undefined,{mediaPolicy:{maxConcurrentUploads:1,maxConcurrentPerUser:1,maxReservedBytes:1,maxReservedPerUserBytes:1},fetchResult:async()=>{if(++calls===1){enter();await held;}return new Response(Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]));}});
  const first=materialize(bridge,row);await entered;const second=materialize(bridge,row);await new Promise(setImmediate);expect(calls).toBe(1);release();await expect(first).resolves.toMatchObject({media:{size:12}});await expect(second).resolves.toMatchObject({media:{size:12}});expect(calls).toBe(2);
});
test('closing the bridge cancels a queued result transfer before it fetches bytes',async()=>{
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),held=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  const {bridge,row}=await fixture(undefined,{mediaPolicy:{maxConcurrentUploads:1,maxConcurrentPerUser:1},fetchResult:async()=>{calls++;enter();await held;return new Response(Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]));}});
  const first=materialize(bridge,row);await entered;const second=materialize(bridge,row);bridge.close();await expect(second).rejects.toMatchObject({code:'RESULT_TRANSFER_INTERRUPTED'});release();await expect(first).rejects.toMatchObject({code:'RESULT_TRANSFER_INTERRUPTED'});expect(calls).toBe(1);
});
test('progressing results survive the old total timeout and stalled readers stop safely',async()=>{
  const video=Buffer.alloc(160,3);Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]).copy(video);
  const state=await fixture(undefined,{mediaPolicy:{uploadTimeoutMs:80},fetchResult:async()=>{let offset=0;return new Response(new ReadableStream({async pull(controller){await new Promise(resolve=>setTimeout(resolve,20));if(offset===video.length){controller.close();return;}controller.enqueue(video.subarray(offset,offset+16));offset+=16;}}));}});
  await expect(materialize(state.bridge,state.row)).resolves.toMatchObject({media:{size:160}});
  const stalled=await fixture(undefined,{mediaPolicy:{uploadTimeoutMs:30},fetchResult:async()=>new Response(new ReadableStream({pull(){return new Promise(()=>{});}}))});
  await expect(materialize(stalled.bridge,stalled.row)).rejects.toMatchObject({code:'MEDIA_UPLOAD_TIMEOUT'});
});
