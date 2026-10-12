import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, expect, test } from 'vitest';
import type { SystemRuntime } from '../system/index.js';
import { ManagedAccountOperations } from './account-operations.js';
import { registerChannelRoutes } from './routes.js';
import { ChannelStore } from './store.js';

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
function fixture(){const db=new Database(':memory:');cleanup.push(()=>{db.close();});const store=new ChannelStore(db,Buffer.alloc(32,39).toString('base64'));return {db,store};}
function account(store:ChannelStore,label:string,credits?:number){
  const jwt='eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({sub:label,exp:4102444800})).toString('base64url')+'.fake';
  const id=store.import(jwt,label).id;
  if(credits!==undefined)store.recordCredits(id,store.row(id)!.encrypted,{credits,checkedAt:'2026-10-12T01:00:00.000Z'});
  return id;
}

test('funded enabled accounts are ordered by confirmed balance before SQL pagination',()=>{
  const {store}=fixture();const low=account(store,'low',15.52),high=account(store,'high',300),medium=account(store,'medium',100),disabled=account(store,'disabled',1000),archived=account(store,'archived',2000),unknown=account(store,'unknown'),zero=account(store,'zero',0),failed=account(store,'failed',3000);
  store.update(disabled,{enabled:false});store.update(archived,{archived:true});store.recordCredits(failed,store.row(failed)!.encrypted,{errorCode:'CREDIT_READ_FAILED'});
  store.db.prepare("UPDATE managed_channel_accounts SET updated_at='2026-10-12T00:00:00.000Z'").run();
  const otherEnabled=[unknown,zero,failed].sort();
  expect(store.list(1,2).data.map(row=>row.id)).toEqual([high,medium]);expect(store.list(2,2).data.map(row=>row.id)).toEqual([low,otherEnabled[0]]);
  expect(store.list(1,50).data.map(row=>row.id)).toEqual([high,medium,low,...otherEnabled,disabled,archived]);
});

test('statistics are global despite search and pagination and exclude stale failed balances',()=>{
  const {store}=fixture();account(store,'boundary',26.48);account(store,'two',53.06);const disabled=account(store,'disabled',500),archived=account(store,'archived',5),failed=account(store,'failed',1000);account(store,'unchecked');account(store,'zero',0);
  store.update(disabled,{enabled:false});store.update(archived,{archived:true});store.recordCredits(archived,store.row(archived)!.encrypted,{credits:5,checkedAt:'2026-10-12T02:00:00.000Z'});store.recordCredits(failed,store.row(failed)!.encrypted,{errorCode:'RATE_LIMITED'});
  const statistics={total:7,enabled:5,disabled:1,archived:1,usable:2,usableCredits:79.54,unchecked:1,failed:1,lowCredit:1,minimumCredits:26.48,minimumVideoCount:3,lastCheckedAt:'2026-10-12T02:00:00.000Z'};
  expect(store.list(1,1,'boundary',26.48)).toMatchObject({total:1,statistics});expect(store.list(2,1,'absent',26.48)).toMatchObject({data:[],total:0,statistics});
});

test('minimum video estimates floor each account independently and honor the dynamic model minimum',()=>{
  const {store}=fixture();account(store,'first',40);account(store,'second',40);account(store,'exact',26.48);account(store,'multiple',79.44);
  expect(store.statistics(26.48)).toMatchObject({usable:4,minimumVideoCount:6,usableCredits:185.92,lowCredit:0});
  expect(store.statistics(27.4)).toMatchObject({usable:3,minimumVideoCount:4,usableCredits:159.44,lowCredit:1,minimumCredits:27.4});
});

test('unknown model minimum keeps usability and capacity unknown while preserving lifecycle counts',()=>{
  const {store}=fixture();account(store,'funded',100);account(store,'unknown');
  for(const minimum of [undefined,null,0,Number.NaN])expect(store.statistics(minimum)).toEqual({total:2,enabled:2,disabled:0,archived:0,usable:null,usableCredits:null,unchecked:1,failed:0,lowCredit:null,minimumCredits:null,minimumVideoCount:null,lastCheckedAt:'2026-10-12T01:00:00.000Z'});
});

test('empty statistics use zero counts, no check timestamp, and no assumed credits',()=>{
  const {store}=fixture();expect(store.statistics(26.48)).toEqual({total:0,enabled:0,disabled:0,archived:0,usable:0,usableCredits:0,unchecked:0,failed:0,lowCredit:0,minimumCredits:26.48,minimumVideoCount:0,lastCheckedAt:null});
});

test('list route returns unfiltered statistics with the runtime model minimum without provider reads',async()=>{
  const {db,store}=fixture();account(store,'visible',26.48);account(store,'other',40);let reads=0;
  const operations=new ManagedAccountOperations(store,{minimumCredits:26.48,busy:()=>false,readCredits:async()=>{reads++;throw new Error('No remote reads allowed');}});
  const runtime={db,assertRequestOrigin:()=>{},requireAdmin:async()=>({id:'fake-owner'})} as unknown as SystemRuntime;
  const app=Fastify();cleanup.push(()=>app.close());registerChannelRoutes(app,{runtime,store,operations});await app.ready();
  const response=await app.inject({method:'GET',url:'/api/admin/channels/accounts?q=visible&pageSize=1'});
  expect(response.statusCode).toBe(200);expect(response.json()).toMatchObject({total:1,cleanupMinimumCredits:26.48,statistics:{total:2,usable:2,usableCredits:66.48,minimumVideoCount:2,minimumCredits:26.48}});expect(reads).toBe(0);
});
