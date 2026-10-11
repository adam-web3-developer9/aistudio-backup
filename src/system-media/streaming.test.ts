import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectError, commandSchema, type ProjectPrincipal, type ProjectRuntime } from '../projects/protocol.js';
import { ProjectStore } from '../projects/store.js';
import { LocalPrivateBlobStore, registerSystemMediaRoutes, resolveMediaPolicy, hardMediaMaxBytes, type MediaPolicy, type PrivateBlobStore } from './routes.js';

const MiB = 1024 * 1024;
const owner: ProjectPrincipal = { id:'owner',sessionId:'owner-session',emailVerified:true,cloudEligible:true,sharingEligible:true };
const editor: ProjectPrincipal = { ...owner,id:'editor',sessionId:'editor-session' };
const viewer: ProjectPrincipal = { ...owner,id:'viewer',sessionId:'viewer-session' };
const initial = { entities:[{type:'asset' as const,id:'asset-1',fields:{}}],collections:{} };
const members = [{userId:'editor',role:'editor' as const},{userId:'viewer',role:'viewer' as const}];
const resources: {directory:string;db:Database.Database;app:ReturnType<typeof Fastify>}[] = [];
afterEach(async()=>{for(const resource of resources.splice(0)){await resource.app.close();resource.db.close();await rm(resource.directory,{recursive:true,force:true});}});
function* video(size:number,seed=1):Generator<Buffer> {
  let offset=0;
  while(offset<size){const chunk=Buffer.alloc(Math.min(64*1024,size-offset),seed);if(offset===0){chunk.writeUInt32BE(24,0);chunk.write('ftypisom',4,'ascii');}offset+=chunk.length;yield chunk;}
}
function hashOf(size:number,seed=1){const digest=createHash('sha256');for(const chunk of video(size,seed))digest.update(chunk);return digest.digest('hex');}
function metadata(size:number,seed=1){return {generation:1,entity:{type:'asset',id:'asset-1'},hash:hashOf(size,seed),size,mime:'video/mp4'};}
function headers(meta:unknown,user='owner'){return {'content-type':'application/octet-stream','x-media-metadata':encodeURIComponent(JSON.stringify(meta)),'x-user':user,origin:'https://studio.test'};}
async function fixture(policy:Partial<MediaPolicy>={},factory?:(directory:string,projects:ProjectStore)=>PrivateBlobStore){
  const directory=await mkdtemp(path.join(os.tmpdir(),'media-stream-test-'));const db=new Database(path.join(directory,'db.sqlite'));const app=Fastify({forceCloseConnections:true});resources.push({directory,db,app});
  const projects=new ProjectStore(db);projects.share('project-1',owner,initial,members);
  const identities:Record<string,ProjectPrincipal>={owner,editor,viewer,operator:{...owner,id:'operator',adminRole:'operator'}};
  const runtime:ProjectRuntime={db,authenticate:async request=>identities[String(request.headers['x-user'])]??null,assertRequestOrigin:request=>{if(request.headers.origin!=='https://studio.test')throw new ProjectError(403,'INVALID_ORIGIN','Invalid origin');}};
  const blobDirectory=path.join(directory,'blobs');const blobs=factory?.(blobDirectory,projects)??new LocalPrivateBlobStore(blobDirectory);
  registerSystemMediaRoutes(app,{runtime,projects,blobs,mediaPolicy:policy});await app.ready();
  const upload=(meta=metadata(32),user='owner',payload:Buffer=Buffer.concat([...video(meta.size)]))=>app.inject({method:'POST',url:'/api/system/projects/project-1/media',headers:headers(meta,user),payload});
  const links=()=>db.prepare('SELECT * FROM shared_project_media').all();
  return {directory,blobDirectory,db,app,projects,blobs,upload,links};
}
async function files(directory:string):Promise<string[]>{try{const entries=await readdir(directory,{withFileTypes:true});return (await Promise.all(entries.map(async entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]))).flat();}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error;}}

describe('bounded private media streaming',()=>{
  it('streams a real 32 MiB raw HTTP video beyond the JSON bodyLimit both ways without invoking Buffer store APIs',async()=>{
    class StreamOnlyStore extends LocalPrivateBlobStore{override async put():Promise<void>{throw new Error('Buffer put must not run');}override async get():Promise<Buffer|null>{throw new Error('Buffer get must not run');}}
    const state=await fixture({},directory=>new StreamOnlyStore(directory));const address=await state.app.listen({host:'127.0.0.1',port:0});const size=32*MiB;const meta=metadata(size);
    const response=await fetch(`${address}/api/system/projects/project-1/media`,{method:'POST',headers:{...headers(meta),'content-length':String(size)},body:Readable.from(video(size)) as unknown as BodyInit,duplex:'half'} as RequestInit);
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({hash:meta.hash,size});expect(state.links()).toHaveLength(1);
    const file=path.join(state.blobDirectory,meta.hash.slice(0,2),meta.hash);expect((await stat(file)).mode&0o777).toBe(0o600);
    const download=await fetch(`${address}/api/system/projects/project-1/media/${meta.hash}`,{headers:{'x-user':'viewer'}});expect(download.status).toBe(200);expect(download.headers.get('content-length')).toBe(String(size));expect(download.headers.get('content-disposition')).toContain('attachment');expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    let received=0;const digest=createHash('sha256');for await(const chunk of download.body!){received+=chunk.length;digest.update(chunk);}expect(received).toBe(size);expect(digest.digest('hex')).toBe(meta.hash);
  });
  it('retains JSON compatibility and rejects oversized declared files before writing',async()=>{
    const state=await fixture({maxFileBytes:64});const bytes=Buffer.concat([...video(32)]);const meta=metadata(32);
    expect((await state.app.inject({method:'POST',url:'/api/system/projects/project-1/media',headers:{'x-user':'owner',origin:'https://studio.test'},payload:{...meta,data:bytes.toString('base64')}})).statusCode).toBe(200);
    const response=await state.upload(metadata(65));expect(response.statusCode).toBe(413);expect(response.json().error).toMatchObject({code:'MEDIA_TOO_LARGE'});expect(response.json().error.message).toContain('64');expect(state.links()).toHaveLength(1);
  });
  it.each(['hash','signature','length'])('rejects %s mismatch without metadata or temporary leftovers',async kind=>{
    const state=await fixture();let meta=metadata(32);let payload=Buffer.concat([...video(32)]);
    if(kind==='hash')meta={...meta,hash:'0'.repeat(64)};if(kind==='signature'){payload=Buffer.alloc(32);meta={...meta,hash:createHash('sha256').update(payload).digest('hex')};}if(kind==='length')payload=payload.subarray(0,31);
    const response=await state.upload(meta,'owner',payload);expect(response.statusCode).toBe(400);expect(state.links()).toHaveLength(0);expect(await files(state.blobDirectory)).toEqual([]);
  });
  it('enforces stream bounds even when the sender exceeds its declared size',async()=>{
    const state=await fixture();const meta=metadata(32);const source=Readable.from(video(33));await expect(state.blobs.putStream!(meta.hash,source,{size:32,mime:'video/mp4',maxBytes:32})).rejects.toMatchObject({code:'MEDIA_TOO_LARGE'});expect(await files(state.blobDirectory)).toEqual([]);
  });
  it('cleans up a source error and an explicitly aborted stream',async()=>{
    const state=await fixture();const meta=metadata(128);async function* broken(){yield Buffer.concat([...video(32)]);throw Object.assign(new Error('peer disconnected'),{code:'ECONNRESET'});}
    await expect(state.blobs.putStream!(meta.hash,broken(),{size:128,mime:'video/mp4'})).rejects.toMatchObject({code:'MEDIA_UPLOAD_INTERRUPTED'});
    const stream=new PassThrough();const abort=new AbortController();const promise=state.blobs.putStream!(meta.hash,stream,{size:128,mime:'video/mp4',signal:abort.signal});stream.write(Buffer.concat([...video(32)]));setTimeout(()=>abort.abort(),20);
    await expect(promise).rejects.toMatchObject({code:'MEDIA_UPLOAD_INTERRUPTED'});expect(await files(state.blobDirectory)).toEqual([]);expect(state.links()).toHaveLength(0);
  });
  it('times out a stalled generic iterator and releases admission slots',async()=>{
    const state=await fixture({uploadTimeoutMs:200,maxConcurrentPerUser:1});const meta=metadata(32);
    const never:AsyncIterable<Uint8Array>={[Symbol.asyncIterator]:()=>({next:()=>new Promise(()=>{})})};
    await expect(state.blobs.putStream!(meta.hash,never,{size:32,mime:'video/mp4',timeoutMs:30})).rejects.toMatchObject({code:'MEDIA_UPLOAD_TIMEOUT'});expect(await files(state.blobDirectory)).toEqual([]);
    const address=await state.app.listen({host:'127.0.0.1',port:0});
    await new Promise<void>((resolve,reject)=>{const request=httpRequest(`${address}/api/system/projects/project-1/media`,{method:'POST',headers:{...headers(meta),'content-length':String(meta.size)}},response=>{response.resume();response.on('end',resolve);});request.on('error',error=>{if((error as NodeJS.ErrnoException).code==='ECONNRESET')resolve();else reject(error);});request.write(Buffer.concat([...video(16)]));});
    expect(state.links()).toHaveLength(0);await expect.poll(async()=> (await state.upload(meta)).statusCode,{timeout:1000,interval:20}).toBe(200);expect((await files(state.blobDirectory)).some(file=>file.endsWith('.tmp'))).toBe(false);
  });
  it('checks disk admission and cleans partially written ENOSPC files',async()=>{
    class FullBeforeWrite extends LocalPrivateBlobStore{protected override async checkAvailableSpace():Promise<void>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}}
    const preflight=await fixture({},directory=>new FullBeforeWrite(directory));expect((await preflight.upload()).statusCode).toBe(507);expect(await files(preflight.blobDirectory)).toEqual([]);expect(preflight.links()).toHaveLength(0);
    const address=await preflight.app.listen({host:'127.0.0.1',port:0});const meta=metadata(32);
    const status=await new Promise<number>((resolve,reject)=>{const request=httpRequest(`${address}/api/system/projects/project-1/media`,{method:'POST',headers:{...headers(meta),'content-length':'32'}},response=>{response.resume();response.on('end',()=>{request.destroy();resolve(response.statusCode!);});});request.on('error',reject);request.write(Buffer.concat([...video(16)]));});expect(status).toBe(507);
    const sourceFile=path.join(preflight.directory,'provider-video');await writeFile(sourceFile,Buffer.concat([...video(32)]));const input=createReadStream(sourceFile);const closed=new Promise<void>(resolve=>input.once('close',resolve));await expect(preflight.blobs.putStream!(metadata(32).hash,input,{size:32,mime:'video/mp4'})).rejects.toMatchObject({code:'MEDIA_STORAGE_FULL'});await closed;expect(input.closed).toBe(true);expect((await stat(sourceFile)).size).toBe(32);
    class FullDuringWrite extends LocalPrivateBlobStore{protected override async openTemporaryFile(file:string):Promise<FileHandle>{const handle=await super.openTemporaryFile(file);handle.write=async()=>{throw Object.assign(new Error('disk full'),{code:'ENOSPC'});};return handle;}}
    const midway=await fixture({},directory=>new FullDuringWrite(directory));expect((await midway.upload()).statusCode).toBe(507);expect(await files(midway.blobDirectory)).toEqual([]);expect(midway.links()).toHaveLength(0);
  });
  it('rejects unsafe hashes, filenames, ZIP and symlink directories/files',async()=>{
    const state=await fixture();const meta=metadata(32);for(const changed of [{hash:'../outside'},{filename:'private.mp4'},{path:'/tmp/private'},{mime:'application/zip'}]){const response=await state.app.inject({method:'POST',url:'/api/system/projects/project-1/media',headers:headers({...meta,...changed}),payload:Buffer.concat([...video(32)])});expect([400,415]).toContain(response.statusCode);}
    const outside=path.join(state.directory,'outside');await mkdir(outside);await mkdir(state.blobDirectory);await symlink(outside,path.join(state.blobDirectory,meta.hash.slice(0,2)));
    await expect(state.blobs.putStream!(meta.hash,Readable.from(video(32)),{size:32,mime:'video/mp4'})).rejects.toMatchObject({code:'UNSAFE_BLOB_PATH'});expect(await readdir(outside)).toEqual([]);
    await rm(path.join(state.blobDirectory,meta.hash.slice(0,2)));await mkdir(path.join(state.blobDirectory,meta.hash.slice(0,2)));const victim=path.join(outside,'victim');await writeFile(victim,'keep');await symlink(victim,path.join(state.blobDirectory,meta.hash.slice(0,2),meta.hash));
    await expect(state.blobs.verifiedRead!(meta.hash,32)).rejects.toMatchObject({code:'UNSAFE_BLOB_PATH'});await expect(state.blobs.putStream!(meta.hash,Readable.from(video(32)),{size:32,mime:'video/mp4'})).rejects.toMatchObject({code:'UNSAFE_BLOB_PATH'});expect(await readFile(victim,'utf8')).toBe('keep');expect(state.links()).toHaveLength(0);
  });
  it('checks ACL, generation and deleted targets before admission and again before ACK',async()=>{
    const state=await fixture();expect((await state.upload(metadata(32),'viewer')).statusCode).toBe(403);expect((await state.upload(metadata(32),'operator')).statusCode).toBe(403);expect((await state.upload({...metadata(32),generation:2})).statusCode).toBe(409);expect((await state.upload({...metadata(32),entity:{type:'asset',id:'missing'}})).statusCode).toBe(409);expect(await files(state.blobDirectory)).toEqual([]);
    for(const mutation of ['acl','generation','tombstone'] as const){const late=await fixture({},(directory,projects)=>{const blobs=new LocalPrivateBlobStore(directory);const put=blobs.putStream.bind(blobs);blobs.putStream=async(...args)=>{await put(...args);if(mutation==='acl')projects.setMembers('project-1',owner,[]);else if(mutation==='generation'){projects.disable('project-1',owner);projects.share('project-1',owner,initial,members);}else projects.apply('project-1',owner,commandSchema.parse({commandId:'delete-media-target',generation:1,operations:[{kind:'delete',type:'asset',id:'asset-1',expectedVersions:{}}]}));};return blobs;});const response=await late.upload(metadata(32),'editor');expect(response.statusCode).toBe(mutation==='acl'?403:409);expect(late.links()).toHaveLength(0);}
  });
  it('reserves declared quota across concurrent uploads and frees it on completion',async()=>{
    let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let calls=0;
    const state=await fixture({projectBytes:48,ownerBytes:48},directory=>{const store=new LocalPrivateBlobStore(directory);const put=store.putStream.bind(store);store.putStream=async(...args)=>{calls++;if(calls===1){enter();await waiting;}await put(...args);};return store;});
    const first=state.upload(metadata(32));await entered;const second=await state.upload(metadata(32,2),'editor',Buffer.concat([...video(32,2)]));expect(second.statusCode).toBe(413);expect(second.json().error.code).toBe('MEDIA_QUOTA_EXCEEDED');expect(calls).toBe(1);release();expect((await first).statusCode).toBe(200);expect((await state.upload(metadata(32))).statusCode).toBe(200);expect(state.links()).toHaveLength(1);
  });
  it('bounds per-user admission slots and rejects large stores without streaming',async()=>{
    let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let calls=0;
    const state=await fixture({maxConcurrentPerUser:1,maxConcurrentUploads:1},directory=>{const store=new LocalPrivateBlobStore(directory);const put=store.putStream.bind(store);store.putStream=async(...args)=>{if(++calls===1){enter();await waiting;}await put(...args);};return store;});const first=state.upload();await entered;expect((await state.upload()).statusCode).toBe(429);expect((await state.upload(metadata(32),'editor')).statusCode).toBe(429);release();expect((await first).statusCode).toBe(200);expect((await state.upload()).statusCode).toBe(200);
    const fake=await fixture({},()=>({put:async()=>{throw new Error('must not buffer');},get:async()=>null}));const big=metadata(21*MiB);expect((await fake.app.inject({method:'POST',url:'/api/system/projects/project-1/media',headers:{...headers(big),'content-length':String(big.size)},payload:Buffer.alloc(0)})).statusCode).toBe(501);
  });
  it('reserves declared physical bytes independently of unique-hash quota',async()=>{
    let enter!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;});let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});let calls=0;
    const state=await fixture({maxReservedBytes:48,maxReservedPerUserBytes:48},directory=>{const store=new LocalPrivateBlobStore(directory);const put=store.putStream.bind(store);store.putStream=async(...args)=>{if(++calls===1){enter();await waiting;}await put(...args);};return store;});const first=state.upload();await entered;expect((await state.upload(metadata(32),'editor')).statusCode).toBe(429);release();expect((await first).statusCode).toBe(200);expect((await state.upload(metadata(32),'editor')).statusCode).toBe(200);
  });
  it('refuses corrupted stored content before sending download bytes and revoked readers',async()=>{
    const state=await fixture();const meta=metadata(32);expect((await state.upload(meta)).statusCode).toBe(200);await writeFile(path.join(state.blobDirectory,meta.hash.slice(0,2),meta.hash),Buffer.alloc(32));const url=`/api/system/projects/project-1/media/${meta.hash}`;expect((await state.app.inject({url,headers:{'x-user':'viewer'}})).statusCode).toBe(404);state.projects.setMembers('project-1',owner,[]);expect((await state.app.inject({url,headers:{'x-user':'viewer'}})).statusCode).toBe(403);
  });
  it('defaults safely, ignores undefined env values and enforces hard caps',()=>{expect(resolveMediaPolicy({maxFileBytes:undefined})).toMatchObject({maxFileBytes:256*MiB,projectBytes:1024*MiB,ownerBytes:2048*MiB,uploadTimeoutMs:900000});expect(()=>resolveMediaPolicy({maxFileBytes:hardMediaMaxBytes+1})).toThrow('hard limit');expect(()=>resolveMediaPolicy({uploadTimeoutMs:1800001})).toThrow('30 minutes');expect(()=>resolveMediaPolicy({maxConcurrentUploads:0})).toThrow('positive');});
});
