import Database from 'better-sqlite3';
import Fastify from 'fastify';
import {afterEach,expect,test} from 'vitest';
import {extractCredentialText,readCredentialMutation} from './credential-stream.js';
import {ChannelStore} from './store.js';
import {registerChannelRoutes} from './routes.js';
import type {SystemRuntime} from '../system/index.js';

const cleanup:Array<()=>void|Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();});
const jwt=(sub:string,iat:number,padding=0)=>'eyJhbGciOiJub25lIn0.'+Buffer.from(JSON.stringify({sub,iat,exp:4102444800,padding:'x'.repeat(padding)})).toString('base64url')+'.fake';
const old=jwt('first',1),fresh=jwt('second',2),refresh='def50200'+'a'.repeat(100);
async function* chunks(text:string,width=113){for(let i=0;i<text.length;i+=width)yield Buffer.from(text.slice(i,i+width));}
function store(){const db=new Database(':memory:');cleanup.push(()=>{db.close();});return new ChannelStore(db,Buffer.alloc(32,7).toString('base64'));}
test.each([
  ['compact account takes its own token over nested newer unrelated account',JSON.stringify({authToken:old,refreshToken:refresh,cookie:'TSEC=fake',unrelated:{authToken:fresh}})],
  ['pretty account retains legacy browser-export token selection',JSON.stringify({authToken:old,refreshToken:refresh,unrelated:{authToken:fresh}},null,2)],
  ['site-state chooses newest token and retains risk cookie jar',JSON.stringify({localStorage:{authToken:fresh,refreshToken:refresh,miora__user_info:JSON.stringify({email:'fixture@example.test'})},cookies:[{name:'authToken',value:old,domain:'.miora.design'},{name:'TDID',value:'fake-risk',domain:'miora.design'},{name:'unrelated',value:'not-cookie',domain:'unrelated.test'}]})],
  ['cookie editor array keeps its jar',JSON.stringify([{name:'authToken',value:old,domain:'.miora.design'},{name:'refreshToken',value:refresh,domain:'miora.design'},{name:'risk',value:'fake-risk',domain:'.miora.design'}])],
  ['hand pasted named account',`fixture----${old}----${refresh}`],
  ['one account per JSON line keeps first account',JSON.stringify({authToken:old,refreshToken:refresh})+'\n'+JSON.stringify({authToken:fresh})],
  ['leading comments in account files', '# fixture account\n'+JSON.stringify({authToken:old,refreshToken:refresh})],
  ['first valid ordinary account does not depend on later comments or invalid lines',JSON.stringify({authToken:old,refreshToken:refresh})+'\n# ignored comment\nnot an account\n'+JSON.stringify({authToken:fresh})],
])('stream normalization preserves existing %s',async(_name,source)=>{
  const before=store(),after=store();const expected=before.import(source),actual=after.import(await extractCredentialText(chunks(source)));
  expect(actual.id).toBe(expected.id);expect(after.credentials(actual.id).tokens).toEqual(before.credentials(expected.id).tokens);
  expect(actual.emailMasked).toBe(expected.emailMasked);
});
test('same-line trailing content is not accepted as an ordinary account',async()=>{
  await expect(extractCredentialText(chunks(JSON.stringify({authToken:old})+JSON.stringify({authToken:fresh})))).rejects.toThrow();
});
test('multi-megabyte irrelevant JSON values are discarded while necessary JWTs beyond 16KiB remain valid',async()=>{
  const authToken=jwt('large-token',3,24000),source=JSON.stringify({authToken,refreshToken:refresh,padding:'x'.repeat(2*1024*1024)});
  const normalized=await extractCredentialText(chunks(source,65536));expect(normalized.length).toBeLessThan(40000);
  expect(JSON.parse(normalized).authToken).toBe(authToken);expect(store().import(normalized).id).toMatch(/^managed-miora-/);
});
test('wire credentials strings above the old 600KiB envelope limit stream into the same normalization',async()=>{
  const raw=JSON.stringify({credentials:JSON.stringify({authToken:old,padding:'x'.repeat(1024*1024)}),label:'测试账户'});
  const body=await readCredentialMutation(chunks(raw,8192));expect(body.label).toBe('测试账户');expect(JSON.parse(body.credentials!).authToken).toBe(old);expect(body.credentials!.length).toBeLessThan(500);
  expect(await readCredentialMutation(chunks(JSON.stringify({label:' '.repeat(10000)+'fixture'+' '.repeat(10000)}),8192))).toEqual({label:'fixture'});
  await expect(readCredentialMutation(chunks('{"enabled":1}'))).rejects.toThrow('凭据格式无效');
  await expect(readCredentialMutation(chunks('{"credentials":"secret","unknown":"'+('x'.repeat(10000))+'"}'))).rejects.toThrow('凭据格式无效');
});
test('real channel routes stream large imports, preserve format errors and reject unauthorized requests before parsing',async()=>{
  const vault=store();let allowed=true;const runtime={db:vault.db,assertRequestOrigin:()=>{},requireAdmin:async()=>{if(!allowed){const {SystemError}=await import('../system/types.js');throw new SystemError(403,'SUPERADMIN_REQUIRED','Superadmin required');}return{id:'test-admin'};},store:{audit:()=>{}}} as unknown as SystemRuntime;
  const app=Fastify({bodyLimit:16384});cleanup.push(()=>app.close());registerChannelRoutes(app,{runtime,store:vault});await app.ready();
  const response=await app.inject({method:'POST',url:'/api/admin/channels/accounts/miora/import',payload:{credentials:JSON.stringify({authToken:old,padding:'x'.repeat(1024*1024)})}});
  expect(response.statusCode).toBe(200);expect(response.json().id).toMatch(/^managed-miora-/);expect(JSON.stringify(response.json())).not.toContain(old);
  allowed=false;expect((await app.inject({method:'POST',url:'/api/admin/channels/accounts/miora/import',payload:{credentials:'not even JSON'}})).statusCode).toBe(403);
});
