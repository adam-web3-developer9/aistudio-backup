import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { afterEach, expect, test, vi } from 'vitest';
import { MioraApiError, readMioraTokens } from '../adapters/miora-api.js';
import { assertSystemRequestOrigin } from '../system/security.js';
import { SystemError } from '../system/types.js';
import type { SystemRuntime } from '../system/index.js';
import type { CreditBalance } from '../types.js';
import { ManagedAccountOperations } from './account-operations.js';
import { registerChannelRoutes } from './routes.js';
import { ChannelStore } from './store.js';

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const close of cleanup.splice(0).reverse())await close();});
const jwt=(sub:string,exp:number|null=4102444800)=>'eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({sub,...(exp===null?{}:{exp})})).toString('base64url')+'.fake';
const credit=(totalCredits:number):CreditBalance=>({totalCredits,breakdown:[]});
function fixture(){const db=new Database(':memory:');cleanup.push(()=>{db.close();});const store=new ChannelStore(db,Buffer.alloc(32,35).toString('base64'));return {db,store};}
const add=(store:ChannelStore,name='fixture',expiry?:number,refreshToken?:string)=>store.import(JSON.stringify({authToken:jwt(name,expiry),...(refreshToken?{refreshToken}:{})}),name).id;

test('search is a literal case insensitive substring with filtered total and paging',()=>{
  const {store}=fixture();add(store,'Alpha%_');add(store,'Beta');add(store,'Alpha second');
  expect(store.list(1,1,'alpha').total).toBe(2);expect(store.list(1,1,'alpha').data).toHaveLength(1);
  expect(store.list(1,50,'%_').total).toBe(1);expect(store.list(1,50,'absent').total).toBe(0);
});
test('plain account JSON preserves its own refresh token and cookie rather than export text scanning',()=>{
  const {store}=fixture();const tokens={authToken:jwt('plain-json'),refreshToken:'fixture-refresh',cookie:'fixture-cookie=value'};const account=store.import(JSON.stringify(tokens));expect(store.credentials(account.id).tokens).toEqual(tokens);
});
test('confirmed low balances use the Miora minimum and preserve archived credentials',async()=>{
  const {store}=fixture();const low=add(store,'low'),boundary=add(store,'boundary');
  const operations=new ManagedAccountOperations(store,{minimumCredits:26.48,busy:()=>false,readCredits:async tokens=>credit(tokens.authToken===jwt('low')?15.52:26.48)});
  expect(await operations.refresh([low,boundary])).toEqual({checked:2,succeeded:2,failed:0});
  expect(store.public(store.row(low)!)).toMatchObject({enabled:false,credits:15.52,creditStatus:'ok',cleanupReason:'insufficient-credits'});
  expect(store.row(boundary)!.archived_at).toBeNull();expect(readMioraTokens(store.session(low)!.cookies)!.authToken).toBe(jwt('low'));
  store.update(low,{archived:false,enabled:false});expect(store.public(store.row(low)!)).toMatchObject({cleanupReason:null,credits:15.52,enabled:false});
});
test('disabled accounts can be refreshed and a successful zero is real credit data',async()=>{
  const {store}=fixture();const id=add(store);store.update(id,{enabled:false});
  const operations=new ManagedAccountOperations(store,{busy:()=>false,readCredits:async()=>credit(0)});
  expect(await operations.refresh([id])).toEqual({checked:1,succeeded:1,failed:0});expect(store.public(store.row(id)!)).toMatchObject({enabled:false,credits:0,creditStatus:'ok',archivedAt:null});
});
test.each([
  ['network',new Error('secret-token network details'),'CREDIT_READ_FAILED'],
  ['rate limit',new MioraApiError(429,'REFRESH_TOKEN_DEAD','secret-token','/api/auth/refresh-token'),'RATE_LIMITED'],
  ['malformed',credit(Number.NaN),'INVALID_CREDIT_RESPONSE'],
  ['negative',credit(-1),'INVALID_CREDIT_RESPONSE']
])('failed %s reads preserve the last successful balance and time',async(_name,result,code)=>{
  const {store}=fixture();const id=add(store);let next:unknown=credit(100);
  const operations=new ManagedAccountOperations(store,{minimumCredits:26.48,busy:()=>false,readCredits:async()=>{if(next instanceof Error)throw next;return next as CreditBalance;}});
  await operations.refresh([id]);const checkedAt=store.public(store.row(id)!).creditsCheckedAt;next=result;
  expect(await operations.cleanup([id])).toEqual({checked:1,archived:0,retained:1,failed:1});
  expect(store.public(store.row(id)!)).toMatchObject({credits:100,creditsCheckedAt:checkedAt,creditStatus:'error',lastErrorCode:code,archivedAt:null});
  expect(JSON.stringify(store.list())).not.toContain('secret-token');
});
test('cleanup archives only confirmed expired credentials with no refresh token',async()=>{
  const {store}=fixture();const expired=add(store,'expired',1),unknown=store.import(jwt('unknown',null)).id;
  const readCredits=vi.fn(async()=>{throw new Error('offline');});const operations=new ManagedAccountOperations(store,{busy:()=>false,readCredits});
  expect(await operations.cleanup([expired,unknown])).toEqual({checked:2,archived:1,retained:1,failed:1});expect(readCredits).toHaveBeenCalledTimes(1);
  expect(store.public(store.row(expired)!)).toMatchObject({lastErrorCode:'AUTH_EXPIRED',cleanupReason:'credentials-expired'});expect(store.row(unknown)!.archived_at).toBeNull();
});
test.each([['expired',1,400,true],['unexpired',4102444800,400,false],['rate limited',1,429,false]])('dead refresh evidence for %s has a safe archive decision',async(_name,expiry,status,archived)=>{
  const {store}=fixture();const id=add(store,'dead',expiry,'fake-refresh');const operations=new ManagedAccountOperations(store,{busy:()=>false,readCredits:async()=>{throw new MioraApiError(status,'REFRESH_TOKEN_DEAD','private-refresh','/api/auth/refresh-token');}});
  await operations.cleanup([id]);expect(!!store.row(id)!.archived_at).toBe(archived);expect(JSON.stringify(store.list())).not.toContain('private-refresh');
});
test('busy cleanup skips network and explicit refresh never archives busy original jobs',async()=>{
  const {store}=fixture();const id=add(store);const readCredits=vi.fn(async()=>credit(1));const operations=new ManagedAccountOperations(store,{minimumCredits:26.48,busy:()=>true,readCredits});
  expect(await operations.cleanup([id])).toEqual({checked:1,archived:0,retained:1,failed:0});expect(readCredits).not.toHaveBeenCalled();
  await operations.refresh([id]);expect(readCredits).toHaveBeenCalledTimes(1);expect(store.row(id)!.archived_at).toBeNull();
});
test('credential replacement during a pending balance read prevents stale balance and archival',async()=>{
  const {store}=fixture();const id=add(store);let finish!:(balance:CreditBalance)=>void;let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
  const operations=new ManagedAccountOperations(store,{minimumCredits:26.48,busy:()=>false,readCredits:async()=>{began();return new Promise<CreditBalance>(resolve=>{finish=resolve;});}});
  const pending=operations.refresh([id]);await started;store.import(jwt('fixture',4102444801));finish(credit(0));
  expect(await pending).toEqual({checked:1,succeeded:0,failed:1});expect(store.public(store.row(id)!)).toMatchObject({credits:null,creditStatus:'unknown',archivedAt:null});
});
test('a concurrent disable prevents archival even when the confirmed balance is low',async()=>{
  const {store}=fixture();const id=add(store);let finish!:(balance:CreditBalance)=>void;let began!:()=>void;const started=new Promise<void>(resolve=>{began=resolve;});
  const operations=new ManagedAccountOperations(store,{minimumCredits:26.48,busy:()=>false,readCredits:async()=>{began();return new Promise<CreditBalance>(resolve=>{finish=resolve;});}});
  const pending=operations.refresh([id]);await started;store.db.prepare("UPDATE managed_channel_accounts SET enabled=0,updated_at='changed-by-user' WHERE id=?").run(id);finish(credit(0));await pending;expect(store.row(id)!.archived_at).toBeNull();
});
test('a renewed credential is not treated as expired when a later read fails',async()=>{
  const {store}=fixture();const id=add(store,'renewed',1,'fake-refresh');const operations=new ManagedAccountOperations(store,{busy:()=>false,readCredits:async(tokens,onTokens)=>{await onTokens(tokens,{authToken:jwt('renewed'),refreshToken:'new-refresh'});throw new MioraApiError(400,'REFRESH_TOKEN_DEAD','private','/api/auth/refresh-token');}});
  await operations.cleanup([id]);expect(store.row(id)!.archived_at).toBeNull();expect(readMioraTokens(store.session(id)!.cookies)!.authToken).toBe(jwt('renewed'));
});
test('bulk requests share concurrency two and duplicate ID reads are coalesced',async()=>{
  const {store}=fixture();const ids=Array.from({length:6},(_,i)=>add(store,'concurrent-'+i));let active=0,max=0,calls=0;
  const operations=new ManagedAccountOperations(store,{busy:()=>false,readCredits:async()=>{active++;calls++;max=Math.max(max,active);await new Promise<void>(resolve=>setTimeout(resolve,5));active--;return credit(100);}});
  await Promise.all([operations.refresh(ids),operations.refresh(ids)]);expect(max).toBe(2);expect(calls).toBe(6);
});
test('missing required proxy fails safely without a direct provider request',async()=>{
  const {store}=fixture();const id=add(store);const operations=new ManagedAccountOperations(store,{minimumCredits:26.48,busy:()=>false});
  expect(await operations.refresh([id])).toEqual({checked:1,succeeded:0,failed:1});expect(store.public(store.row(id)!)).toMatchObject({creditStatus:'error',lastErrorCode:'VIDEO_GATEWAY_PROXY_CONFIGURATION_INVALID',archivedAt:null});
});
test('background scheduling performs cleanup and close drains the operation',async()=>{
  const {store}=fixture();const id=add(store);const operations=new ManagedAccountOperations(store,{minimumCredits:26.48,busy:()=>false,readCredits:async()=>credit(15.52)});operations.schedule([id]);await operations.close();expect(store.public(store.row(id)!)).toMatchObject({cleanupReason:'insufficient-credits',credits:15.52});
});
test('new routes enforce superadmin and trusted origin, batch atomically, and audit safe summaries',async()=>{
  const {db,store}=fixture();const id=add(store,'search account');const operations=new ManagedAccountOperations(store,{minimumCredits:26.48,busy:()=>false,readCredits:async()=>credit(100)});
  let role='superadmin';const audits:unknown[]=[];const runtime={db,assertRequestOrigin:(req:Parameters<typeof assertSystemRequestOrigin>[0])=>assertSystemRequestOrigin(req,['http://localhost']),requireAdmin:async(_req:unknown,permission?:string)=>{if(permission==='authorize'&&role!=='superadmin')throw new SystemError(403,'SUPERADMIN_REQUIRED','Superadmin required');return {id:'fake-owner'};},store:{audit:(entry:unknown)=>audits.push(entry)}} as unknown as SystemRuntime;
  const app=Fastify();cleanup.push(()=>app.close());registerChannelRoutes(app,{runtime,store,operations});await app.ready();const headers={origin:'http://localhost',cookie:'fake=test'};
  expect((await app.inject({method:'GET',url:'/api/admin/channels/accounts?q=search',headers})).json()).toMatchObject({total:1,cleanupMinimumCredits:26.48});
  const post=(path:string,payload:Record<string,unknown>)=>app.inject({method:'POST',url:'/api/admin/channels/accounts/'+path,headers,payload});
  role='operator';for(const path of ['batch','credits/refresh','cleanup'])expect((await post(path,{ids:[id],...(path==='batch'?{action:'disable'}:{})})).statusCode).toBe(403);role='superadmin';
  expect((await app.inject({method:'POST',url:'/api/admin/channels/accounts/cleanup',headers:{origin:'https://evil.invalid'},payload:{ids:[id]}})).statusCode).toBe(403);
  const absent='managed-miora-'+'a'.repeat(24);expect((await post('batch',{ids:[id,absent],action:'disable'})).statusCode).toBe(404);expect(store.row(id)!.enabled).toBe(1);
  expect((await post('batch',{ids:[id,id],action:'disable'})).json()).toMatchObject({updated:1});expect((await post('credits/refresh',{ids:[id]})).json()).toEqual({checked:1,succeeded:1,failed:0});
  await post('batch',{ids:[id],action:'archive'});expect(store.public(store.row(id)!)).toMatchObject({cleanupReason:'manual'});expect((await post('batch',{ids:[id],action:'enable'})).statusCode).toBe(409);
  await post('batch',{ids:[id],action:'restore'});expect(store.public(store.row(id)!)).toMatchObject({enabled:false,cleanupReason:null,archivedAt:null});
  expect((await post('cleanup',{ids:[]})).json()).toEqual({checked:0,archived:0,retained:0,failed:0});expect(audits).toHaveLength(5);expect(JSON.stringify(audits)).not.toContain(jwt('search account'));
});
