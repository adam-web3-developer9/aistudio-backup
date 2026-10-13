import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readFile, rm, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { SystemRuntime } from '../system/index.js';
import { SystemError } from '../system/types.js';
import type { ProjectPrincipal } from '../projects/protocol.js';
import { publicSystemJob, type SystemJobStore, type SystemJobRow, type Lease } from '../system-jobs/store.js';
import type { ChannelStore } from './store.js';
import type { JobStore } from '../stores/job-store.js';
import type { JobRunner } from '../jobs/job-runner.js';
import type { AccountPool } from '../jobs/account-pool.js';
import type { AssetStore } from '../stores/asset-store.js';
import type { SessionStore } from '../stores/session-store.js';
import { checkMediaQuota, resolveMediaPolicy, type MediaPolicy, type PrivateBlobStore } from '../system-media/routes.js';
import { assertMediaMemory, MediaAdmission, mediaIdleWatchdog } from '../system-media/resources.js';
export interface LegacyChannelRuntime {
  jobs: JobStore; runner: JobRunner; accountPool: AccountPool; assets: AssetStore; sessions: SessionStore;
}
const parametersSchema = z.object({
  text: z.string().min(1).max(20000),
  mediaHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(8),
  options: z.object({ modelId: z.string().max(100).optional(), resolution: z.string().max(30).optional(),
    durationSeconds: z.number().int().min(1).max(30).optional(), aspectRatio: z.string().max(30).optional() }).strict().optional(),
}).strict();
interface BridgeOptions {
  runtime: SystemRuntime; channels: ChannelStore; jobs: SystemJobStore; legacy?: LegacyChannelRuntime;
  blobs: PrivateBlobStore; fetchResult?: typeof fetch; pollIntervalMs?: number; mediaPolicy?: Partial<MediaPolicy>;
}
/** Durable system claim delegates to existing channel worker; public results are private blob references. */
export class ChannelJobBridge {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private reconciliation = new Map<string,Promise<void>>();
  private claims = new Map<string, { jobId: string; principal: ProjectPrincipal; lease: Lease }>();
  private resultAdmission = new MediaAdmission();
  private closing = new AbortController();
  constructor(private options: BridgeOptions) {
    const { runtime, jobs, channels, legacy } = options;
    runtime.db.exec('CREATE TABLE IF NOT EXISTS system_channel_jobs(job_id TEXT PRIMARY KEY,channel_job_id TEXT UNIQUE NOT NULL,account_id TEXT NOT NULL,created_at TEXT NOT NULL)');
    runtime.db.prepare("UPDATE system_jobs SET status='uncertain',error_code='RECONCILIATION_REQUIRED',lease_hash=NULL,lease_until=NULL WHERE executor='server' AND status='running'").run();
    // No provider identity means there is no real query recovery. Release only the old process's attempt, preserving unknown billing.
    if (legacy) for (const row of runtime.db.prepare("SELECT j.id,m.channel_job_id FROM system_jobs j LEFT JOIN system_channel_jobs m ON m.job_id=j.id WHERE j.executor='server' AND j.status='uncertain'").all() as {id:string;channel_job_id:string|null}[]) {
      const old=row.channel_job_id ? legacy.jobs.get(row.channel_job_id) : undefined;
      if (!old?.progress?.providerJobId && old?.status!=='succeeded') this.failedOutcome(row.id,'SUBMISSION_OUTCOME_UNKNOWN');
    }
    legacy?.runner.setExecutionGuard(job => {
      if (!job.id.startsWith('job_system_')) return;
      const claim = this.claims.get(job.id);
      if (!claim) throw new Error('System execution owner requires reconciliation');
      const row = jobs.row(claim.jobId)!;
      const mapping = runtime.db.prepare('SELECT account_id FROM system_channel_jobs WHERE job_id=?').get(row.id) as { account_id: string };
      const account = channels.row(mapping.account_id);
      if (!account?.enabled || account.archived_at) throw new Error('Channel account is disabled');
      // Includes live session, entitlement, sharing eligibility and project ACL checks.
      jobs.heartbeat(row.project_id, row.id, claim.principal, claim.lease, 300000, true);
    });
  }
  private uncertain(jobId: string, fence: number) {
    this.options.runtime.db.prepare("UPDATE system_jobs SET status='uncertain',error_code='RECONCILIATION_REQUIRED',lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND fence=?")
      .run(new Date().toISOString(), jobId, fence);
  }
  private failedOutcome(jobId:string,code:string) {
    this.options.runtime.db.prepare("UPDATE system_jobs SET status='failed',error_code=?,fence=fence+1,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=? AND executor='server' AND status IN ('running','uncertain')").run(code,new Date().toISOString(),jobId);
  }
  private async materialize(row: SystemJobRow, principal: ProjectPrincipal, raw: unknown) {
    const { jobs, runtime, blobs } = this.options;
    const policy=resolveMediaPolicy(this.options.mediaPolicy);
    jobs.projects.access(row.project_id, principal, true);
    const videoUrl = (raw as { videoUrl?: unknown } | null)?.videoUrl;
    if (typeof videoUrl !== 'string') throw new Error('Result is unavailable');
    const url = new URL(videoUrl);
    if (url.protocol !== 'https:' || !/(?:\.myqcloud\.com|\.miora\.design|\.miora\.ai)$/.test(url.hostname) || url.username || url.password) throw new Error('Result host is not allowed');
    const release = await this.resultAdmission.acquire(principal.id, policy, this.closing.signal);
    const idle = mediaIdleWatchdog(policy.uploadTimeoutMs, () => new SystemError(408, 'MEDIA_UPLOAD_TIMEOUT', '视频结果传输无进展，请稍后核对已有结果'), this.closing.signal);
    let directory:string|undefined,pendingResponse:Response|undefined;
    try {
      jobs.projects.access(row.project_id, principal, true);
      const response = await (this.options.fetchResult ?? fetch)(url, { redirect: 'error', signal: idle.signal });
      pendingResponse=response;
      if (!response.ok || !response.body) throw new Error('Result is unavailable');
      idle.progress();
      const lengthHeader=response.headers.get('content-length'),declared=lengthHeader===null?undefined:Number(lengthHeader);
      if(declared!==undefined&&(!Number.isSafeInteger(declared)||declared<=0))throw new SystemError(400,'INVALID_MEDIA_SIZE','视频声明长度无效');
      const checkSpace = async (remaining: number) => {
        const space = await statfs(tmpdir(), { bigint: true });
        if (space.bavail * space.bsize < BigInt(remaining) + BigInt(64 * 1024 * 1024)) throw new SystemError(507,'MEDIA_DISK_FULL','临时磁盘空间不足，生成结果保留上游，稍后核对');
      };
      await checkSpace(declared ?? 64 * 1024);
      directory=await mkdtemp(path.join(tmpdir(),'aistudio-result-'));const file=path.join(directory,'result.tmp');
      const handle=await open(file,'wx',0o600),reader=response.body.getReader(),digest=createHash('sha256');let size=0,head=Buffer.alloc(0),nextSpaceCheck=0;
      let rejectAbort: (error: unknown) => void = () => {};
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const onAbort = () => { rejectAbort(idle.signal.reason); void reader.cancel().catch(() => {}); };
      idle.signal.addEventListener('abort', onAbort, { once: true });
      try {
        for (;;) {
          idle.signal.throwIfAborted();
          const next=await Promise.race([reader.read(), aborted]);if(next.done)break;
          idle.progress();size+=next.value.length;
          if(!Number.isSafeInteger(size))throw new SystemError(400,'INVALID_MEDIA_SIZE','视频长度超出协议可表示范围');
          if(declared!==undefined&&size>declared)throw new SystemError(400,'MEDIA_SIZE_MISMATCH','视频实际长度超过声明');
          if(size>=nextSpaceCheck){await checkSpace(declared===undefined?next.value.length:Math.max(0,declared-size));nextSpaceCheck=size+4*1024*1024;}
          const chunk=Buffer.from(next.value.buffer,next.value.byteOffset,next.value.byteLength);digest.update(chunk);if(head.length<12)head=Buffer.concat([head,chunk.subarray(0,12-head.length)]);await handle.writeFile(chunk);idle.progress();
        }
        await handle.sync();
      } finally {idle.signal.removeEventListener('abort',onAbort);try{await handle.close();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}}
      idle.close();
      if(size<12||head.toString('ascii',4,8)!=='ftyp'||declared!==undefined&&declared!==size)throw new Error('Result signature or size does not match');
      const hash=digest.digest('hex');checkMediaQuota(runtime.db,row.project_id,hash,size,policy);
      if(blobs.putStream)await blobs.putStream(hash,createReadStream(file),{size,mime:'video/mp4',timeoutMs:policy.uploadTimeoutMs,signal:this.closing.signal});
      else {assertMediaMemory(size);await blobs.put(hash,await readFile(file));}
    // Async I/O above may overlap member removal, expiry, logout or target deletion.
      const project = jobs.projects.access(row.project_id, principal, true); jobs.projects.generation(project, row.generation);
      const target = jobs.projects.snapshotFromRow(project).entities.find(entity => entity.type === row.target_type && entity.id === row.target_id && !entity.deleted);
      if (!target) throw new Error('Result target was removed');
      return { channel: 'miora', media: { hash, size, mime: 'video/mp4' } };
    } catch(error) {
      if(['ENOSPC','EDQUOT'].includes((error as NodeJS.ErrnoException)?.code??''))throw new SystemError(507,'MEDIA_DISK_FULL','结果落盘空间不足，生成结果保留上游，稍后核对');
      throw error;
    } finally {idle.close();await pendingResponse?.body?.cancel().catch(()=>{});release();if(directory)await rm(directory,{recursive:true,force:true});}
  }
  private commitResult<T>(row:SystemJobRow,principal:ProjectPrincipal,result:{media:{hash:string;size:number;mime:string}},complete:()=>T):T {
    return this.options.runtime.db.transaction(()=>{
      const project=this.options.jobs.projects.access(row.project_id,principal,true);this.options.jobs.projects.generation(project,row.generation);
      checkMediaQuota(this.options.runtime.db,row.project_id,result.media.hash,result.media.size,resolveMediaPolicy(this.options.mediaPolicy));
      this.options.runtime.db.prepare('INSERT OR IGNORE INTO shared_project_media VALUES(?,?,?,?,?,?,?)').run(row.project_id,row.generation,row.target_type,row.target_id,result.media.hash,result.media.size,result.media.mime);
      return complete();
    }).immediate();
  }
  async submit(jobId: string, principal: ProjectPrincipal) {
    const { runtime, channels, jobs, legacy, blobs } = this.options;
    if (this.timers.has(jobId)) return;
    const claimed = jobs.claimServer(jobId, principal, 300000);
    const lease: Lease = { fence: claimed.fence, leaseToken: claimed.leaseToken }; const row = jobs.row(jobId)!;
    const fail = (code: string) => { try { jobs.fail(row.project_id, jobId, principal, lease, code, true); } catch { /* A canceled or fenced attempt stays terminal. */ } };
    if (!legacy) { fail('CHANNEL_WORKER_DISABLED'); return; }
    let channelId: string | undefined;
    try {
      if (row.kind !== 'miora.video' && row.kind !== 'video:miora') throw new Error('Unsupported channel');
      const parameters = parametersSchema.parse(claimed.input.parameters);
      const selected = channels.sessions()[0]; if (!selected) { fail('NO_MANAGED_ACCOUNTS'); return; }
      const refs = [];
      for (const hash of parameters.mediaHashes) {
        const project=jobs.projects.access(row.project_id,principal,true);jobs.projects.generation(project,row.generation);
        const entities=jobs.projects.snapshotFromRow(project).entities;
        const links=runtime.db.prepare('SELECT mime,entity_type,entity_id FROM shared_project_media WHERE project_id=? AND generation=? AND hash=?').all(row.project_id,row.generation,hash) as {mime:string;entity_type:string;entity_id:string}[];
        const link=links.find(item=>entities.some(entity=>entity.type===item.entity_type&&entity.id===item.entity_id&&!entity.deleted));
        if (!link) throw new Error('Media is unavailable');
        const bytes = await blobs.get(hash);
        if (!bytes || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Media is unavailable');
        refs.push(await legacy.assets.save({ originalName: hash + (link.mime === 'image/png' ? '.png' : '.jpg'), mimeType: link.mime, buffer: bytes }));
      }
      channelId = 'job_system_' + jobId.replace(/-/g, '');
      runtime.db.prepare('INSERT INTO system_channel_jobs VALUES(?,?,?,?)').run(jobId, channelId, selected.id, new Date().toISOString());
      const channelJob = legacy.jobs.create({ adapterId: 'miora-v1', sessionId: selected.id, text: parameters.text,
        assetId: refs[0]!.id, assetIds: refs.map(ref => ref.id), options: parameters.options }, channelId);
      await legacy.jobs.flushOrThrow(channelId);
      jobs.heartbeat(row.project_id, jobId, principal, lease, 300000, true);
      this.claims.set(channelId, { jobId, principal, lease });
      let settling = false;
      const stop = () => { const timer = this.timers.get(jobId); if (timer) clearInterval(timer); this.timers.delete(jobId); if (channelId) this.claims.delete(channelId); };
      const settle = async () => {
        if (settling) return; settling = true;
        try {
          if (jobs.row(jobId)?.status !== 'running') { stop(); return; }
          jobs.heartbeat(row.project_id, jobId, principal, lease, 300000, true);
          const completed = legacy.jobs.get(channelId!);
          if (completed?.status === 'failed') {
            const knownBeforeSubmit=new Set(['ADAPTER_NOT_FOUND','ASSET_NOT_FOUND','SESSION_NOT_FOUND','SESSION_ADAPTER_MISMATCH','EXECUTION_OWNER_REQUIRED','NO_ACCOUNTS_AVAILABLE','INSUFFICIENT_CREDITS','ACCOUNT_BALANCE_UNAVAILABLE']);
            if (!completed.progress?.providerJobId) this.failedOutcome(jobId,knownBeforeSubmit.has(completed.error?.code??'')?'CHANNEL_GENERATION_FAILED':'SUBMISSION_OUTCOME_UNKNOWN');
            else if (['PROVIDER_RENDER_FAILED','CONTENT_REJECTED','INSUFFICIENT_CREDITS'].includes(completed.error?.code??'')) this.failedOutcome(jobId,'CHANNEL_GENERATION_FAILED');
            else this.uncertain(jobId,lease.fence);
            stop();
          }
          else if (completed?.status === 'succeeded') {
            const result = await this.materialize(row, principal, completed.result);
            this.commitResult(row,principal,result,()=>jobs.complete(row.project_id, jobId, principal, lease, result, true)); stop();
          }
        } catch { this.uncertain(jobId, lease.fence); stop(); }
        finally { settling = false; }
      };
      const timer = setInterval(() => { void settle(); }, this.options.pollIntervalMs ?? 3000); timer.unref(); this.timers.set(jobId, timer);
      legacy.runner.submit(channelJob);
    } catch {
      if (channelId && legacy.jobs.get(channelId)?.status === 'queued') {
        legacy.jobs.update(channelId, { status: 'failed', error: { code: 'EXECUTION_OWNER_REQUIRED', message: 'System execution owner is unavailable' }, finishedAt: new Date().toISOString() });
        await legacy.jobs.flushOrThrow(channelId).catch(() => {});
      }
      fail('CHANNEL_INPUT_OR_PERSISTENCE_FAILED');
    }
  }
  /** Read/reconcile an existing channel outcome only. Never submits or retries a generation. */
  async reconcile(jobId: string, principal: ProjectPrincipal) {
    const { jobs, legacy, runtime } = this.options; const row = jobs.row(jobId);
    if (!row) throw new SystemError(404, 'JOB_UNAVAILABLE', 'Job is unavailable');
    jobs.access(row.project_id, jobId, principal, true);
    if (row.status === 'succeeded') return { job: publicSystemJob(row) };
    if (row.executor !== 'server' || row.status !== 'uncertain') throw new SystemError(409, 'RECONCILIATION_NOT_REQUIRED', 'Job is not awaiting reconciliation');
    if (!legacy) throw new SystemError(503, 'CHANNEL_WORKER_DISABLED', 'Channel worker is disabled');
    const mapping = runtime.db.prepare('SELECT channel_job_id FROM system_channel_jobs WHERE job_id=?').get(jobId) as { channel_job_id: string } | undefined;
    const completed = mapping && legacy.jobs.get(mapping.channel_job_id);
    if ((!completed?.progress?.providerJobId && completed?.status !== 'succeeded' && completed?.status !== 'running') || completed?.status==='failed'&&['PROVIDER_RENDER_FAILED','CONTENT_REJECTED','INSUFFICIENT_CREDITS'].includes(completed.error?.code??'')) {
      this.failedOutcome(jobId,completed?.progress?.providerJobId?'CHANNEL_GENERATION_FAILED':'SUBMISSION_OUTCOME_UNKNOWN');
      return {job:publicSystemJob(jobs.row(jobId)!),retryAllowed:true,billingUnknown:!completed?.progress?.providerJobId};
    }
    if (completed?.status !== 'succeeded') {
      if(completed?.status==='failed'&&completed.progress?.providerJobId&&!this.reconciliation.has(jobId)){
        const pending=legacy.runner.resumeRecorded(completed.id).catch(()=>{}).finally(()=>this.reconciliation.delete(jobId));
        this.reconciliation.set(jobId,pending);
      }
      return { job: publicSystemJob(row), channelStatus: completed?.status ?? 'unknown', reconciliationRequired: true, reconciliationPending:this.reconciliation.has(jobId) };
    }
    const result = await this.materialize(row, principal, completed.result);
    return this.commitResult(row,principal,result,()=>jobs.reconcileCompleted(jobId, principal, result));
  }
  close() { this.closing.abort(new SystemError(503,'RESULT_TRANSFER_INTERRUPTED','服务正在关闭，生成结果保留供下次核对'));for (const timer of this.timers.values()) clearInterval(timer); this.timers.clear(); this.claims.clear(); }
}
