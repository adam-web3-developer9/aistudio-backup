import {expect,test} from 'vitest';
import type {FastifyRequest} from 'fastify';
import {assertSystemRequestOrigin} from './security.js';
const request=(url:string,extra:Record<string,string>={})=>({method:'POST',url,headers:{origin:'http://127.0.0.1:3001',cookie:'test-only','content-type':'application/octet-stream','x-media-metadata':'%7B%7D',...extra}} as unknown as FastifyRequest);
test('binary uploads retain origin and an exact media-only request boundary',()=>{
  const origins=['http://127.0.0.1:3001'];
  expect(()=>assertSystemRequestOrigin(request('/api/system/projects/project-1/media'),origins)).not.toThrow();
  for(const url of ['/api/auth/sign-up/email','/api/admin/users','/api/system/projects/a%2Fb/media','/api/system/projects/%2e%2e/media','/api/system/projects/project-1/media/extra'])expect(()=>assertSystemRequestOrigin(request(url),origins)).toThrow();
  expect(()=>assertSystemRequestOrigin(request('/api/system/projects/project-1/media',{origin:'https://other.invalid'}),origins)).toThrow('Origin');
  expect(()=>assertSystemRequestOrigin(request('/api/system/projects/project-1/media',{'x-media-metadata':'x'.repeat(4097)}),origins)).toThrow();
});
