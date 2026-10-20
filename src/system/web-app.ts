import path from 'node:path';
import type { ComfyRuntimeOptions } from '../comfyui/runtime.js';
import type { ComfyService } from '../comfyui/service.js';
import { registerComfyAdminRoutes } from '../comfyui/routes.js';
import { readFile, realpath } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { createSystemRuntime, registerSystemRoutes, systemLoggerOptions, type SystemRuntimeOptions } from './index.js';
import { SystemError } from './types.js';
import { registerProjectRoutes } from '../projects/routes.js';
import { LocalPrivateBlobStore, registerSystemMediaRoutes, resolveMediaPolicy, type MediaPolicy } from '../system-media/routes.js';
import { registerSystemJobRoutes } from '../system-jobs/routes.js';
import { ChannelStore } from '../system-channels/store.js';
import { registerChannelRoutes } from '../system-channels/routes.js';
import type { ManagedAccountOperations, ManagedAccountCreditReader } from '../system-channels/account-operations.js';
import { ChannelJobBridge, type LegacyChannelRuntime } from '../system-channels/bridge.js';
import { assertVideoGatewayConfiguration, assertVideoGatewayProxyConfiguration } from '../system-channels/video-gateway.js';
import { config } from '../config.js';
import { registerPackageShareRoutes } from '../package-shares/routes.js';

export interface SystemWebOptions extends SystemRuntimeOptions { mediaDirectory: string; adminDirectory?: string; credentialKey?: string; channelsEnabled?: boolean; videoGatewayEnabled?: boolean; comfyui?: ComfyRuntimeOptions; packageSharesEnabled?: boolean; managedAccountCreditReader?:ManagedAccountCreditReader; trustProxy?: boolean | string[]; mediaPolicy?: Partial<MediaPolicy>; beforeReady?: (app: FastifyInstance) => void | Promise<void> }
/** One Fastify service: identity, administration, drafts/media/jobs; legacy video becomes an optional channel. */
export async function buildSystemWebApp(options:SystemWebOptions) {
  if(options.videoGatewayEnabled&&!options.channelsEnabled)throw new Error('Video gateway requires SYSTEM_CHANNELS_ENABLED=true');
  if(options.comfyui&&!options.videoGatewayEnabled)throw new Error('ComfyUI requires SYSTEM_VIDEO_GATEWAY_ENABLED=true');
  assertVideoGatewayConfiguration(options.videoGatewayEnabled===true,config.apiKey);
  assertVideoGatewayProxyConfiguration(options.videoGatewayEnabled===true,config.mioraProxyUrl);
  const runtime=await createSystemRuntime(options);let app:FastifyInstance | undefined;
  try {
    const channels=new ChannelStore(runtime.db,options.credentialKey);
    if(options.channelsEnabled){if(!options.credentialKey)throw new Error('Channel worker requires CHANNEL_CREDENTIAL_KEY');const {buildApp}=await import('../app.js');app=await buildApp({managedChannels:channels,managedGateway:options.videoGatewayEnabled,comfyui:options.comfyui,managedAccountCreditReader:options.managedAccountCreditReader,managedAccountArchived:(id,reason)=>runtime.store.audit({actorId:null,action:'channel.account.autoArchive',targetType:'channelAccount',targetId:id,metadata:{reason}}),trustProxy:options.trustProxy,warmup:false});}
    else app=Fastify({logger:systemLoggerOptions,bodyLimit:2*1024*1024,trustProxy:options.trustProxy??false});
    app.setErrorHandler<Error & {statusCode?:number}>((error,_request,reply)=>{if(error instanceof SystemError)return reply.code(error.statusCode).send({code:error.code,message:error.message});return reply.code(error.statusCode&&error.statusCode<500?error.statusCode:500).send({code:'REQUEST_FAILED',message:'Request failed'});});
    app.addHook('onRequest',async(request,reply)=>{
      if(!request.url.startsWith('/api/'))return;
      runtime.assertRequestOrigin(request);reply.header('Cache-Control','no-store').header('X-Content-Type-Options','nosniff');
      if(!['GET','HEAD','OPTIONS'].includes(request.method)&&request.url.startsWith('/api/system/projects')){
        await runtime.authenticate(request);
      }
    });
    await registerSystemRoutes(app,{runtime});
    const packageShares=registerPackageShareRoutes(app,{runtime,enabled:options.packageSharesEnabled});
    const mediaPolicy=resolveMediaPolicy(options.mediaPolicy);
    app.get('/api/system/media-policy',async request=>{await runtime.authenticate(request);return {streaming:true,deprecatedQuotaPolicy:true,maxFileBytes:mediaPolicy.maxFileBytes,projectBytes:mediaPolicy.projectBytes,ownerBytes:mediaPolicy.ownerBytes};});
    const projects=registerProjectRoutes(app,{runtime});const blobs=new LocalPrivateBlobStore(options.mediaDirectory);registerSystemMediaRoutes(app,{runtime,projects,blobs,mediaPolicy});
    const jobs=registerSystemJobRoutes(app,{runtime,projects,onServerJob:(id,principal)=>bridge.submit(id,principal)});
    const legacy=options.channelsEnabled?(app as unknown as {channelRuntime:LegacyChannelRuntime&{accountOperations?:ManagedAccountOperations}}).channelRuntime:undefined;
    const comfy=(legacy as (typeof legacy & {comfy?:ComfyService}))?.comfy;
    if(comfy)registerComfyAdminRoutes(app,runtime,comfy);
    const bridge=new ChannelJobBridge({runtime,channels,jobs,legacy,blobs,mediaPolicy});
    app.post('/api/system/projects/:projectId/jobs/:jobId/reconcile',async(request,reply)=>{const params=request.params as {projectId:string;jobId:string};const principal=await runtime.authenticate(request);jobs.access(params.projectId,params.jobId,principal,true);return bridge.reconcile(params.jobId,principal);});
    app.addHook('onClose',async()=>bridge.close());
    registerChannelRoutes(app,{runtime,store:channels,operations:legacy?.accountOperations,changed:async()=>{if(legacy){const accounts=runtime.db.prepare('SELECT id,enabled,archived_at FROM managed_channel_accounts').all() as {id:string;enabled:number;archived_at:string|null}[];for(const account of accounts){if(account.enabled&&!account.archived_at)legacy.accountPool.unretire(account.id);else legacy.accountPool.retire(account.id);}await legacy.accountPool.sync();if(config.mioraProxyUrl)legacy.accountOperations?.schedule(accounts.filter(account=>account.enabled&&!account.archived_at).map(account=>account.id));}}});
    if(options.adminDirectory)registerAdminFiles(app,options.adminDirectory);
    if(!options.channelsEnabled)app.get('/health',async()=>({status:'ok',service:'system',channelsEnabled:false,videoGatewayEnabled:false}));
    await options.beforeReady?.(app);
    await app.ready();return {app,runtime,projects,jobs,channels,bridge,packageShares};
  }catch(error){await app?.close();await runtime.close();throw error;}
}
function registerAdminFiles(app:FastifyInstance,directory:string){
  const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
  const serve=async(request:import('fastify').FastifyRequest,reply:import('fastify').FastifyReply)=>{let requested:string;try{requested=decodeURIComponent(request.url.split('?')[0]!.replace(/^\/admin\/?/,''));}catch{return reply.code(400).send();}if(requested.includes('\0')||requested.includes('\\'))return reply.code(404).send();const root=await realpath(directory);const candidate=path.resolve(root,requested||'index.html');if(!candidate.startsWith(root+path.sep))return reply.code(404).send();let file=candidate;try{const actual=await realpath(file);if(!actual.startsWith(root+path.sep))return reply.code(404).send();file=actual;}catch{if(path.extname(requested))return reply.code(404).send();file=path.join(root,'index.html');}reply.header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'").header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff').header('Cache-Control','no-store');return reply.type(mime[path.extname(file)]??'application/octet-stream').send(await readFile(file));};
  app.get('/admin',serve);app.get('/admin/*',serve);
}
