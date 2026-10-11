import {afterEach,expect,test,vi} from 'vitest';
import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ProjectStore} from '../projects/store.js';
import {SystemJobStore,type SystemJobRow} from '../system-jobs/store.js';
import {LocalPrivateBlobStore} from '../system-media/routes.js';
import {ChannelStore} from './store.js';
import {ChannelJobBridge} from './bridge.js';
import type {SystemRuntime} from '../system/index.js';
const cleanup:Array<()=>Promise<void>|void>=[];afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0).reverse())await close();});
const owner={id:'owner',sessionId:'isolated',emailVerified:true,cloudEligible:true,sharingEligible:true};
async function fixture(maxFileBytes=32*1024*1024){
  const directory=await mkdtemp(path.join(tmpdir(),'result-stream-test-'));cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const db=new Database(':memory:');cleanup.push(()=>{db.close();});const projects=new ProjectStore(db);projects.share('project',owner,{entities:[{type:'shot',id:'shot',fields:{}}],collections:{}},[]);
  db.exec('CREATE TABLE shared_project_media(project_id TEXT,generation INTEGER,entity_type TEXT,entity_id TEXT,hash TEXT,size INTEGER,mime TEXT,PRIMARY KEY(project_id,generation,entity_type,entity_id,hash))');
  const jobs=new SystemJobStore(db,projects);const created=jobs.create('project',owner,{requestId:'result',generation:1,target:{type:'shot',id:'shot'},inputVersion:0,executor:'server',kind:'miora.video',parameters:{}});
  const blobs=new LocalPrivateBlobStore(directory);const bridge=new ChannelJobBridge({runtime:{db} as SystemRuntime,channels:new ChannelStore(db),jobs,blobs,mediaPolicy:{maxFileBytes},fetchResult:async()=>{
    let count=0;return new Response(new ReadableStream({pull(controller){if(count++===384){controller.close();return;}const chunk=Buffer.alloc(64*1024,3);if(count===1)Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109]).copy(chunk);controller.enqueue(chunk);}}),{headers:{'content-length':String(384*64*1024)}});
  }});cleanup.push(()=>bridge.close());return {bridge,blobs,row:jobs.row(created.job.id)!};
}
const materialize=(bridge:ChannelJobBridge,row:SystemJobRow)=>(bridge as unknown as {materialize:(row:SystemJobRow,principal:typeof owner,raw:unknown)=>Promise<{media:{hash:string,size:number}}>}).materialize(row,owner,{videoUrl:'https://result.miora.design/video.mp4'});
test('server video results over 20 MiB stream to private storage without the buffer path',async()=>{
  const {bridge,blobs,row}=await fixture();const bufferPath=vi.spyOn(blobs,'put').mockRejectedValue(new Error('whole-file buffer path forbidden'));const streamPath=vi.spyOn(blobs,'putStream');
  const result=await materialize(bridge,row);expect(result.media.size).toBe(24*1024*1024);expect(bufferPath).not.toHaveBeenCalled();expect(streamPath).toHaveBeenCalledTimes(1);
  const stream=await blobs.verifiedRead(result.media.hash,result.media.size);expect(stream).toBeTruthy();const hash=createHash('sha256');for await(const chunk of stream!)hash.update(chunk);expect(hash.digest('hex')).toBe(result.media.hash);
});
test('configured result bound fails explicitly and releases its transfer slot',async()=>{
  const {bridge,row}=await fixture(21*1024*1024);await expect(materialize(bridge,row)).rejects.toMatchObject({code:'MEDIA_TOO_LARGE'});await expect(materialize(bridge,row)).rejects.toMatchObject({code:'MEDIA_TOO_LARGE'});
});
