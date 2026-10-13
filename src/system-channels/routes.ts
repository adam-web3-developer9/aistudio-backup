import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SystemRuntime } from '../system/index.js';
import { SystemError } from '../system/types.js';
import { ChannelStore } from './store.js';
import type { ManagedAccountOperations } from './account-operations.js';
import { readCredentialMutation, type CredentialBytes } from './credential-stream.js';
const idSchema=z.string().regex(/^managed-miora-[a-f0-9]{24}$/);
const credentialsSchema=z.string().min(1);
const labelSchema=z.string().trim().min(1).max(120);
// A transport window, not a limit on the total size of an administrative operation.
const idsSchema=z.array(idSchema).max(500);
const historyQuery=z.object({page:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1),pageSize:z.coerce.number().int().min(1).max(200).default(10)});
export function registerChannelRoutes(app:FastifyInstance,options:{runtime:SystemRuntime;store:ChannelStore;changed?:()=>Promise<void>;operations?:ManagedAccountOperations}) {
  const {runtime,store}=options;
  app.register(async scoped=>{
    scoped.addHook('onRequest',async request=>runtime.assertRequestOrigin(request));
    scoped.setErrorHandler((error,_request,reply)=>{ if(error instanceof SystemError)return reply.code(error.statusCode).send({code:error.code,message:error.message}); if(error instanceof z.ZodError)return reply.code(400).send({code:'INVALID_INPUT',message:'Invalid channel input'});return reply.code(500).send({code:'CHANNEL_OPERATION_FAILED',message:'Channel operation failed'}); });
    const operate=async(request:Parameters<SystemRuntime['authenticate']>[0])=>runtime.requireAdmin(request,'authorize');
    scoped.get('/api/admin/channels/accounts',async request=>{await runtime.requireAdmin(request);const query=z.object({page:z.coerce.number().int().positive().default(1),pageSize:z.coerce.number().int().min(1).max(200).default(50),q:z.string().max(200).default('')}).parse(request.query);const minimum=options.operations?.cleanupMinimumCredits??null;return {...store.list(query.page,query.pageSize,query.q,minimum),cleanupMinimumCredits:minimum};});
    scoped.post('/api/admin/channels/accounts/batch',async request=>{
      const principal=await operate(request);const body=z.object({ids:idsSchema.min(1),action:z.enum(['enable','disable','archive','restore']),partial:z.boolean().optional()}).strict().parse(request.body);const ids=[...new Set(body.ids)];
      if(body.partial){
        const results=ids.map(id=>{
          try{
            const account=store.db.transaction(()=>{
              const row=store.row(id);if(!row)throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account is unavailable');
              if(body.action==='enable'&&row.archived_at)throw new SystemError(409,'ACCOUNT_ARCHIVED','Restore the account before enabling it');
              const unchanged=body.action==='archive'?!!row.archived_at:body.action==='restore'?!row.archived_at:!!row.enabled===(body.action==='enable');
              if(unchanged)return store.public(row);
              return store.update(id,body.action==='archive'?{archived:true}:body.action==='restore'?{archived:false,enabled:false}:{enabled:body.action==='enable'});
            })();
            return {id,status:'succeeded' as const,account};
          }catch(error){return {id,status:'failed' as const,code:error instanceof SystemError?error.code:'CHANNEL_OPERATION_FAILED',message:error instanceof SystemError?error.message:'Channel account operation failed'};}
        });
        const accounts=results.flatMap(result=>result.status==='succeeded'?[result.account]:[]),failed=results.length-accounts.length;
        runtime.store.audit({actorId:principal.id,action:'channel.account.batch',targetType:'channelAccount',targetId:'multiple',metadata:{action:body.action,ids,updated:accounts.length,failed}});
        if(accounts.length)await options.changed?.();return {updated:accounts.length,failed,accounts,results};
      }
      const accounts=store.db.transaction(()=>{for(const id of ids){const row=store.row(id);if(!row)throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account is unavailable');if(body.action==='enable'&&row.archived_at)throw new SystemError(409,'ACCOUNT_ARCHIVED','Restore the account before enabling it');}return ids.map(id=>store.update(id,body.action==='archive'?{archived:true}:body.action==='restore'?{archived:false,enabled:false}:{enabled:body.action==='enable'}));})();
      runtime.store.audit({actorId:principal.id,action:'channel.account.batch',targetType:'channelAccount',targetId:'multiple',metadata:{action:body.action,ids,updated:accounts.length}});await options.changed?.();return {updated:accounts.length,accounts};
    });
    scoped.post('/api/admin/channels/accounts/credits/refresh',async request=>{
      const principal=await operate(request);const body=z.object({ids:idsSchema.optional()}).strict().parse(request.body??{});const result=store.creditSummary(body.ids);runtime.store.audit({actorId:principal.id,action:'channel.accounts.credits.readStored',targetType:'channelAccount',targetId:'multiple',metadata:result});return result;
    });
    scoped.post('/api/admin/channels/accounts/cleanup',async request=>{
      const principal=await operate(request);const body=z.object({ids:idsSchema.optional()}).strict().parse(request.body??{});if(!options.operations)throw new SystemError(503,'CHANNEL_WORKER_DISABLED','Channel account checks are unavailable');const result=await options.operations.cleanup(body.ids);runtime.store.audit({actorId:principal.id,action:'channel.accounts.cleanup',targetType:'channelAccount',targetId:'multiple',metadata:result});return result;
    });
    scoped.register(async credentials=>{
      credentials.removeContentTypeParser('application/json');
      credentials.addContentTypeParser('application/json',(_request,payload,done)=>done(null,payload));
      credentials.addHook('onRequest',async request=>{await operate(request);});
      const bodyOf=async(request: {body:unknown})=>{try{return await readCredentialMutation(request.body as CredentialBytes);}catch{throw new SystemError(400,'INVALID_CREDENTIALS','凭据格式无效，请检查导出文件或令牌。');}};
      credentials.post('/api/admin/channels/accounts/miora/import',async request=>{const principal=await operate(request);const body=z.object({credentials:credentialsSchema,label:labelSchema.optional()}).strict().parse(await bodyOf(request));const result=store.import(body.credentials,body.label);runtime.store.audit({actorId:principal.id,action:'channel.credentials.import',targetType:'channelAccount',targetId:result.id});await options.changed?.();return result;});
      credentials.patch('/api/admin/channels/accounts/:id',async request=>{const principal=await operate(request);const id=idSchema.parse((request.params as {id:string}).id);const body=z.object({credentials:credentialsSchema.optional(),label:labelSchema.optional(),enabled:z.boolean().optional()}).strict().parse(await bodyOf(request));if(!store.row(id))throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account unavailable');if(body.credentials)store.import(body.credentials,body.label,id);const result=store.update(id,body);runtime.store.audit({actorId:principal.id,action:body.credentials?'channel.credentials.update':'channel.account.update',targetType:'channelAccount',targetId:id,metadata:{...(body.enabled===undefined?{}:{enabled:body.enabled})}});await options.changed?.();return result;});
    });
    scoped.delete('/api/admin/channels/accounts/:id',async request=>{const principal=await operate(request);const id=idSchema.parse((request.params as {id:string}).id);const result=store.update(id,{archived:true});runtime.store.audit({actorId:principal.id,action:'channel.account.archive',targetType:'channelAccount',targetId:id});await options.changed?.();return result;});
    scoped.post('/api/admin/channels/accounts/:id/restore',async request=>{const principal=await operate(request);const id=idSchema.parse((request.params as {id:string}).id);const result=store.update(id,{archived:false,enabled:false});runtime.store.audit({actorId:principal.id,action:'channel.account.restore',targetType:'channelAccount',targetId:id});await options.changed?.();return result;});
    scoped.get('/api/admin/channels/accounts/:id/jobs',async request=>{
      await runtime.requireAdmin(request);const id=idSchema.parse((request.params as {id:string}).id),query=historyQuery.parse(request.query);
      const offset=(query.page-1)*query.pageSize;if(!Number.isSafeInteger(offset))throw new SystemError(400,'INVALID_INPUT','Invalid history page');
      if(!store.row(id))throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account unavailable');
      const table=runtime.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='system_channel_jobs'").get();if(!table)return {data:[],total:0};
      return runtime.db.transaction(()=>{
        const total=(runtime.db.prepare('SELECT COUNT(*) AS n FROM system_jobs j JOIN system_channel_jobs c ON c.job_id=j.id WHERE c.account_id=?').get(id) as {n:number}).n;
        const data=runtime.db.prepare('SELECT j.id,j.status,j.kind,j.created_at AS createdAt,j.updated_at AS updatedAt,j.error_code AS errorCode,CASE WHEN j.result IS NULL THEN 0 ELSE 1 END AS resultAvailable FROM system_jobs j JOIN system_channel_jobs c ON c.job_id=j.id WHERE c.account_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT ? OFFSET ?').all(id,query.pageSize,offset);
        return {data,total};
      })();
    });
    scoped.post('/api/admin/channels/accounts/:id/validate',async request=>{const principal=await operate(request);const id=idSchema.parse((request.params as {id:string}).id);const row=store.row(id);if(!row)throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account unavailable');store.session(id);runtime.store.audit({actorId:principal.id,action:'channel.account.validate',targetType:'channelAccount',targetId:id});return {...store.public(row),validationStatus:'unknown',localCredentialStatus:row.expires_at&&row.expires_at<new Date().toISOString()?'expired':'format-and-decryption-passed',validationScope:'local-format-and-vault',remoteValidationPerformed:false};});
  });
}
