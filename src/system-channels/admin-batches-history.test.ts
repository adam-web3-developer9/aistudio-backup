import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, expect, test } from 'vitest';
import type { SystemRuntime } from '../system/index.js';
import { registerChannelRoutes } from './routes.js';
import { ChannelStore } from './store.js';

const close:Array<()=>void|Promise<unknown>>=[];
afterEach(async()=>{for(const fn of close.splice(0).reverse())await fn();});
async function fixture(){
  const db=new Database(':memory:');close.push(()=>db.close());
  const store=new ChannelStore(db);const audits:unknown[]=[];
  const runtime={db,assertRequestOrigin:()=>{},requireAdmin:async()=>({id:'test-admin'}),store:{audit:(entry:unknown)=>audits.push(entry)}} as unknown as SystemRuntime;
  const app=Fastify();close.push(()=>app.close());registerChannelRoutes(app,{runtime,store});await app.ready();
  const add=(index:number)=>{const id='managed-miora-'+index.toString(16).padStart(24,'0');db.prepare('INSERT INTO managed_channel_accounts VALUES(?,?,NULL,1,NULL,?,NULL,?)').run(id,'fixture '+index,'2026-10-13T00:00:00.000Z','fake-encrypted-no-credentials');return id;};
  return {app,db,store,audits,add};
}
test('partial batch isolates item errors, is idempotent, and retains the atomic API default',async()=>{
  const {app,store,add}=await fixture();const first=add(1),second=add(2),missing='managed-miora-'+'f'.repeat(24);
  const post=(payload:unknown)=>app.inject({method:'POST',url:'/api/admin/channels/accounts/batch',payload});
  expect((await post({ids:[first,missing],action:'disable'})).statusCode).toBe(404);
  expect(store.row(first)!.enabled).toBe(1);
  const result=await post({ids:[first,missing,first,second],action:'archive',partial:true});
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({updated:2,failed:1,results:[{id:first,status:'succeeded'},{id:missing,status:'failed',code:'ACCOUNT_UNAVAILABLE'},{id:second,status:'succeeded'}]});
  const archivedAt=store.row(first)!.archived_at;
  expect((await post({ids:[first],action:'archive',partial:true})).json()).toMatchObject({updated:1,failed:0});
  expect(store.row(first)!.archived_at).toBe(archivedAt);
  expect((await post({ids:[first,missing],action:'enable',partial:true})).json()).toMatchObject({updated:0,failed:2});
  await post({ids:[first],action:'restore',partial:true});store.update(first,{enabled:true});
  await post({ids:[first],action:'restore',partial:true});expect(store.row(first)!.enabled).toBe(1);
});
test('transport windows accept 500 accounts and can reach beyond 500 through subsequent windows',async()=>{
  const {app,store,add}=await fixture();const ids=Array.from({length:501},(_,i)=>add(i+1));
  const post=(selected:string[])=>app.inject({method:'POST',url:'/api/admin/channels/accounts/batch',payload:{ids:selected,action:'disable',partial:true}});
  expect((await post(ids)).statusCode).toBe(400);
  expect((await post(ids.slice(0,500))).json()).toMatchObject({updated:500,failed:0});
  expect((await post(ids.slice(500))).json()).toMatchObject({updated:1,failed:0});
  expect(ids.every(id=>store.row(id)!.enabled===0)).toBe(true);
});
test('channel history uses requested pages and the full count beyond 200 with deterministic ties',async()=>{
  const {app,db,add}=await fixture();const id=add(1),other=add(2);
  db.exec('CREATE TABLE system_jobs(id TEXT PRIMARY KEY,status TEXT,kind TEXT,created_at TEXT,updated_at TEXT,error_code TEXT,result TEXT,input TEXT); CREATE TABLE system_channel_jobs(job_id TEXT PRIMARY KEY,account_id TEXT)');
  for(let i=0;i<206;i++){const job='job-'+i.toString().padStart(3,'0');db.prepare('INSERT INTO system_jobs VALUES(?,?,?,?,?,?,?,?)').run(job,'succeeded','miora.video','2026-10-13T00:00:00Z','2026-10-13T00:00:00Z',null,'private-result','private-input');db.prepare('INSERT INTO system_channel_jobs VALUES(?,?)').run(job,i===205?other:id);}
  const first=(await app.inject({url:`/api/admin/channels/accounts/${id}/jobs?page=1&pageSize=100`})).json();
  const second=(await app.inject({url:`/api/admin/channels/accounts/${id}/jobs?page=2&pageSize=100`})).json();
  const last=(await app.inject({url:`/api/admin/channels/accounts/${id}/jobs?page=3&pageSize=100`})).json();
  expect([first.total,second.total,last.total]).toEqual([205,205,205]);
  expect([first.data.length,second.data.length,last.data.length]).toEqual([100,100,5]);
  const ids=[...first.data,...second.data,...last.data].map(row=>row.id);
  expect(new Set(ids).size).toBe(205);expect(ids[0]).toBe('job-204');expect(ids.at(-1)).toBe('job-000');
  expect(JSON.stringify(first)).not.toMatch(/private-result|private-input/);
  expect((await app.inject({url:`/api/admin/channels/accounts/${id}/jobs?page=0`})).statusCode).toBe(400);
  expect((await app.inject({url:`/api/admin/channels/accounts/${id}/jobs?pageSize=201`})).statusCode).toBe(400);
  expect((await app.inject({url:`/api/admin/channels/accounts/${id}/jobs?page=4&pageSize=100`})).json()).toEqual({data:[],total:205});
});
