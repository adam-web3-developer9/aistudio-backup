import { randomInt, randomUUID } from 'node:crypto';
import path from 'node:path';
import { SystemError } from '../system/types.js';
import type { AssetRecord } from '../types.js';
import type { AigateClient } from './aigate-client.js';
import type { ComfyClient } from './comfy-client.js';
import type { ComfyPoolConfiguration } from './configuration.js';
import type { ComfyResultStore } from './result-store.js';
import { ComfyStore, publicStatus, type ComfyInput, type ComfyJob, type FrozenComfyInput } from './store.js';
import { compileWorkflow } from './workflow.js';
import type { ComfyEventDetails } from './events.js';
import { schedulerPolicy } from './scheduler.js';
import { ComfyLifecycle } from './lifecycle.js';
import { comfyPoolMetrics } from './metrics.js';

type InstanceConfiguration = ComfyPoolConfiguration['instances'][number];
type DataClient = Pick<ComfyClient, 'health' | 'queue' | 'upload' | 'submit' | 'history' | 'findAttempt' | 'download'>;
export interface ComfyServiceOptions {
  store: ComfyStore; configuration: ComfyPoolConfiguration;
  platform: Pick<AigateClient, 'getInstanceStatus' | 'openInstance' | 'closeInstance'> & Partial<Pick<AigateClient,
    'getInstance' | 'setGpuIdleShutdown' | 'clearGpuIdleShutdown' | 'skuList' | 'createInstance' | 'releaseInstance' | 'pageInstances'>>;
  client: (instance: InstanceConfiguration) => DataClient;
  assets: { get(id: string): AssetRecord | undefined; read(id: string): Promise<Buffer | undefined> };
  results: Pick<ComfyResultStore, 'save' | 'read'>;
  ownsAsset: (id: string) => boolean;
  owner: string;
}
const completeStages = new Set(['succeeded', 'failed', 'cancelled']);
const stageMessages: Record<string, string> = {
  queued: '任务已入队，等待分配GPU实例', waiting_capacity: '目标区域暂缺显卡，正在轮询等卡', booting: '正在启动GPU实例并等待ComfyUI就绪',
  preparing: '正在校验输入并准备工作流', awaiting_upload: 'GPU已就绪，等待客户端直传参考素材', submitting: '正在提交工作流并等待原任务回执',
  running: 'ComfyUI正在执行原工作流，等待生成完成', collecting: '生成已完成，正在保存结果', preparing_result: '正在唤醒原实例以收取已生成结果，不会重新生成',
  succeeded: '视频生成完成', failed: '任务失败，请查看原任务事件和错误码', cancelled: '已取消本地等待，未保证远端执行已停止',
};
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z_]{1,94}$/.test(code) ? code.startsWith('COMFY_') ? code : `COMFY_${code}` : 'COMFY_OPERATION_FAILED';
}
function diagnosticDetails(error: unknown): ComfyEventDetails {
  const value = error as { errCode?: unknown; details?: { upstreamCode?: unknown; httpStatus?: unknown; nodeId?: unknown; errorType?: unknown } } | null;
  const details: ComfyEventDetails = {};
  for (const [key, item] of Object.entries({ upstreamCode: value?.errCode ?? value?.details?.upstreamCode, nodeId: value?.details?.nodeId, errorType: value?.details?.errorType })) {
    if (typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(item)) Object.assign(details, { [key]: item });
  }
  const status = value?.details?.httpStatus;
  if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599) details.httpStatus = status;
  return details;
}

export class ComfyService {
  readonly store: ComfyStore;
  readonly lifecycle: ComfyLifecycle;
  private readonly worker = randomUUID();
  private readonly closing = new AbortController();
  private readonly collecting = new Map<string, Promise<void>>();
  private readonly processing = new Map<string, Promise<void>>();
  private opening: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;

  constructor(readonly options: ComfyServiceOptions) {
    this.store = options.store;
    this.lifecycle = new ComfyLifecycle({ store: this.store, configuration: options.configuration, platform: options.platform,
      client: options.client, assertWorker: () => this.assertWorker() });
    this.store.registerInstances(options.configuration.instances.map(instance => instance.id));
    const registered = new Set(options.configuration.instances.map(instance => instance.id));
    if (this.store.instances().some(instance => !registered.has(instance.id) && (instance.job_id || this.store.pendingResults(instance.id).length))) {
      throw new Error('Cannot remove a ComfyUI instance with unresolved work');
    }
  }
  start(): void {
    if (this.timer) return;
    this.heartbeat = setInterval(() => { if (!this.closing.signal.aborted) this.store.acquireWorker(this.worker, Date.now()); }, 5_000);
    this.heartbeat.unref();
    this.timer = setInterval(() => { void this.tick(); }, this.options.configuration.pollIntervalMs);
    this.timer.unref();
    void this.tick();
  }
  async close(): Promise<void> {
    this.closing.abort(new Error('ComfyUI service is stopping'));
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    await Promise.allSettled(this.active ? [this.active] : []);
    await Promise.allSettled(this.processing.values());
    await this.lifecycle.close();
    await Promise.allSettled(this.collecting.values());
    this.store.releaseWorker(this.worker);
  }
  private assertWorker(): void {
    if (this.closing.signal.aborted || !this.store.ownsWorker(this.worker)) throw new Error('ComfyUI worker lease is unavailable');
  }
  metrics() { return comfyPoolMetrics(this.store, this.options.configuration); }
  async inspectResource(key: string): Promise<void> {
    const resource = this.store.resource(key);
    if (!resource) throw new SystemError(404, 'COMFY_RESOURCE_UNKNOWN', 'Resource is not owned by this pool');
    if (!resource.instance_id) throw new SystemError(409, 'COMFY_CREATION_UNCONFIRMED', 'Creation returned no confirmed instance ID');
    if (!this.options.platform.getInstance) throw new SystemError(503, 'COMFY_RESOURCE_INSPECTION_UNAVAILABLE', 'Instance inspection is unavailable');
    if (!this.store.acquireWorker(this.worker, Date.now())) throw new SystemError(409, 'COMFY_WORKER_BUSY', 'Another worker owns this pool');
    await this.lifecycle.inspect(key);
  }
  async stopUnregisteredResource(key: string): Promise<void> {
    if (this.lifecycle.isBusy()) throw new SystemError(409, 'COMFY_WORKER_BUSY', 'Resource maintenance is in progress');
    const resource = this.store.resource(key);
    if (!resource) throw new SystemError(404, 'COMFY_RESOURCE_UNKNOWN', 'Resource is not owned by this pool');
    if (!resource.instance_id || resource.configuration || !this.options.platform.getInstance
      || !['creating', 'blocked'].includes(resource.state) || this.store.hasUnresolvedWork(resource.instance_id)
      || this.options.configuration.instances.some(instance => instance.id === resource.instance_id)) {
      throw new SystemError(409, 'COMFY_RESOURCE_STOP_UNSAFE', 'Only confirmed unregistered resources without work may be stopped');
    }
    if (resource.error_code === 'COMFY_RESOURCE_STOP_REQUESTED') throw new SystemError(409, 'COMFY_RESOURCE_STOP_UNCONFIRMED', 'The previous stop request is still unconfirmed');
    if (!this.store.acquireWorker(this.worker, Date.now())) throw new SystemError(409, 'COMFY_WORKER_BUSY', 'Another worker owns this pool');
    await this.lifecycle.stopUnregistered(key);
  }
  private async configureIdlePolicy(id: string): Promise<void> {
    if (this.store.instance(id)!.idle_policy_applied_at || !this.options.platform.setGpuIdleShutdown) return;
    await this.options.platform.setGpuIdleShutdown(id);
    this.assertWorker();
    this.store.updateInstance(id, { idle_policy_applied_at: Date.now() });
  }
  submit(input: ComfyInput): { job: ComfyJob; created: boolean } {
    const prior = this.store.byRequest(this.options.owner, input.requestKey);
    if (prior) return this.store.submit(this.options.owner, { ...input, profile: (JSON.parse(prior.input) as FrozenComfyInput).profile }, this.options.configuration.jobTimeoutMs);
    const profile = this.options.configuration.workflows.find(candidate => candidate.id === input.workflowId);
    if (!profile) throw new SystemError(400, 'COMFY_WORKFLOW_UNKNOWN', 'Unknown workflow profile');
    const direct = input.transport === 'direct';
    if (!direct && input.directMedia || direct && Object.keys(input.media).length) throw new SystemError(400, 'COMFY_BINDING_INVALID', 'Direct and server media cannot be mixed');
    if (direct && !this.options.configuration.instances.some(instance => instance.workflowIds.includes(profile.id) && !Object.keys(instance.headers ?? {}).length)) {
      throw new SystemError(400, 'COMFY_DIRECT_UNAVAILABLE', 'No instance supports credential-free client direct transfer');
    }
    const supplied = direct ? input.directMedia ?? {} : input.media;
    for (const [name, binding] of Object.entries(profile.bindings)) {
      if (binding.kind === 'media') {
        if ((!binding.omitWhenMissing && !(name in supplied)) || name in input.values) throw new SystemError(400, 'COMFY_MEDIA_REQUIRED', 'Each required media binding requires explicit media');
      } else if (name in supplied || binding.kind === 'output-prefix' && name in input.values) throw new SystemError(400, 'COMFY_BINDING_INVALID', 'Media and server-owned output bindings cannot be overridden');
    }
    if (Object.keys(supplied).some(name => profile.bindings[name]?.kind !== 'media')) throw new SystemError(400, 'COMFY_BINDING_INVALID', 'Unregistered media binding');
    for (const [name, id] of Object.entries(input.media)) {
      if (profile.bindings[name]?.kind !== 'media' || !this.options.ownsAsset(id) || !this.options.assets.get(id)) throw new SystemError(400, 'COMFY_ASSET_UNAVAILABLE', 'Uploaded media is unavailable');
    }
    const generated = Object.fromEntries(Object.entries(profile.bindings).filter(([, binding]) => binding.kind === 'output-prefix').map(([name]) => [name, 'hailuo-validation']));
    try { compileWorkflow(profile, { ...input.values, ...Object.fromEntries(Object.keys(supplied).map(name => [name, 'explicit-upload'])), ...generated }); }
    catch { throw new SystemError(400, 'COMFY_BINDING_INVALID', 'Workflow input does not match its registered bindings'); }
    const frozenProfile = structuredClone(profile);
    if (profile.id === 'minimax-h3-9plus3') {
      for (const value of Object.values(frozenProfile.graph)) {
        const node = value as { class_type: string; inputs: Record<string, unknown> };
        if (node.class_type === 'RandomNoise' && typeof node.inputs.noise_seed === 'number') {
          node.inputs.noise_seed = randomInt(0, 281_474_976_710_655);
        }
      }
    }
    return this.store.submit(this.options.owner, { ...input, profile: frozenProfile }, this.options.configuration.capacityWaitTimeoutMs ?? 21_600_000);
  }
  get(id: string): ComfyJob {
    const job = this.store.get(id);
    if (!job || job.owner !== this.options.owner) throw new SystemError(404, 'JOB_NOT_FOUND', 'Unknown job');
    return job;
  }
  publicJob(job: ComfyJob) {
    const input = JSON.parse(job.input) as FrozenComfyInput;
    const candidates = this.store.instances().filter(instance => !instance.draining && this.options.configuration.instances.some(candidate => candidate.id === instance.id && candidate.workflowIds.includes(input.workflowId)));
    const assigned = job.instance_id ? this.store.instance(job.instance_id) : undefined;
    const uploadRecovery = ['awaiting_upload', 'preparing'].includes(job.stage) && input.transport === 'direct';
    const starting = job.stage === 'queued' ? candidates.find(instance => instance.state === 'starting') : uploadRecovery && assigned?.state === 'starting' ? assigned : undefined;
    const waiting = (uploadRecovery && assigned ? [assigned] : candidates).filter(instance => instance.state === 'waiting_capacity');
    const capacityWaiting = (job.stage === 'queued' || uploadRecovery) && !starting && waiting.length > 0;
    const recovering = !starting && !capacityWaiting ? (uploadRecovery && assigned?.state === 'offline' ? assigned : job.stage === 'queued' ? candidates.find(instance => !instance.job_id && instance.state === 'offline' && instance.error_code) : undefined) : undefined;
    const configuration = this.options.configuration.instances.find(instance => instance.id === (job.instance_id ?? starting?.id ?? waiting[0]?.id ?? recovering?.id));
    const wakingResult = !!job.result_wake_requested && job.stage === 'succeeded';
    const stage = job.cancel_requested ? 'cancelled' : wakingResult ? 'preparing_result' : recovering ? 'waiting_instance' : starting ? 'booting' : capacityWaiting ? 'waiting_capacity' : job.stage;
    const events = this.store.events.recent(job.id, 12);
    const waitingTargets = [...new Set(waiting.map(instance => this.options.configuration.instances.find(candidate => candidate.id === instance.id))
      .map(instance => [instance?.areaName, instance?.gpuModel].filter(Boolean).join(' / ')).filter(Boolean))];
    const message = uploadRecovery && starting ? '原GPU实例已离线，正在唤醒原实例；保留原任务和已上传素材' :
      capacityWaiting && !job.cancel_requested ? uploadRecovery && assigned ? '原GPU实例开机暂缺可分配GPU，正在轮询恢复；保留原任务和已上传素材' :
        `已登记实例开机暂缺可分配GPU，正在轮询候卡${waitingTargets.length ? `（${waitingTargets.join('、')}）` : ''}；尚未开始生成` :
      recovering ? recovering.error_code === 'COMFY_EXTERNAL_OCCUPANCY' ? '原GPU实例正在执行其他任务，等待空闲后自动重查，不抢占、不重复提交' : `GPU实例暂未就绪，正在退避后重新检查；保留原任务，不重复生成（${recovering.error_code ?? 'COMFY_INSTANCE_UNAVAILABLE'}）` : stageMessages[stage]!;
    return {
      id: job.id, adapterId: 'comfyui-v1', status: wakingResult && !job.cancel_requested ? 'running' : capacityWaiting && !job.cancel_requested ? 'queued' : publicStatus(job.cancel_requested ? 'cancelled' : job.stage), stage,
      createdAt: new Date(job.created_at).toISOString(),
      updatedAt: new Date(job.updated_at).toISOString(),
      ...(job.finished_at ? { finishedAt: new Date(job.finished_at).toISOString() } : {}),
      progress: { message, phase: stage, ...(job.provider_confirmed ? { providerJobId: job.prompt_id } : {}),
        elapsedMs: Math.max(0, (job.finished_at ?? Date.now()) - job.created_at), deadlineAt: new Date(job.deadline).toISOString(),
        ...(configuration && (!capacityWaiting || job.instance_id) ? { instance: { id: configuration.id, areaName: configuration.areaName, gpuModel: configuration.gpuModel } } : {}),
        ...(capacityWaiting ? { nextRetryAt: new Date(Math.min(...waiting.map(instance => instance.next_action_at ?? Date.now()))).toISOString(),
          waitingSince: new Date(Math.min(...waiting.map(instance => instance.capacity_started_at ?? job.created_at))).toISOString() } : {}),
        ...(recovering ? { nextRetryAt: new Date(recovering.next_action_at ?? Date.now()).toISOString() } : {}),
        ...(input.transport === 'direct' ? { upload: { completed: job.direct_inputs ? Object.keys(input.directMedia ?? {}).length : 0, total: Object.keys(input.directMedia ?? {}).length } } : {}),
      },
      events,
      ...(job.result && stage === 'succeeded' ? { result: { videoUrl: input.transport === 'direct' ? (JSON.parse(job.result) as { videoUrl: string }).videoUrl : `/v1/jobs/${job.id}/result` } } : {}),
      ...(stage === 'awaiting_upload' && assigned?.state === 'busy' && configuration && input.transport === 'direct' ? { upload: {
        baseUrl: configuration.baseUrl, subfolder: job.id,
        files: Object.entries(input.directMedia ?? {}).map(([binding, media]) => ({ binding, ...media })),
      } } : {}),
      ...(job.error_code ? { error: { code: job.error_code, message: `${stageMessages[job.cancel_requested ? 'cancelled' : 'failed']}（${job.error_code}）`, retryable: false } } : {}),
    };
  }
  async requestResultAvailability(id: string): Promise<ComfyJob> {
    const job = this.get(id);
    if (job.stage === 'succeeded' && job.result_pending && (job.result_wake_requested || (job.result_checked_at ?? 0) < Date.now() - 30_000) &&
      (JSON.parse(job.input) as FrozenComfyInput).transport === 'direct') {
      const configuration = this.options.configuration.instances.find(instance => instance.id === job.instance_id);
      if (!configuration) throw new SystemError(409, 'COMFY_INSTANCE_UNKNOWN', 'Original instance configuration is unavailable');
      try {
        await this.options.client(configuration).health();
        if (this.get(id).result_pending) this.store.updateJob(id, { result_wake_requested: 0, result_checked_at: Date.now() });
      } catch (error) {
        if (this.get(id).result_pending) this.store.updateJob(id, { result_wake_requested: 1 }, diagnosticDetails(error));
      }
    }
    return this.get(id);
  }
  completeInputs(id: string, inputs: Record<string, { name: string; subfolder: string; type: 'input' }>): ComfyJob {
    const job = this.get(id);
    const frozen = JSON.parse(job.input) as FrozenComfyInput;
    if (frozen.transport !== 'direct' || job.cancel_requested || job.deadline <= Date.now()) throw new SystemError(409, 'COMFY_UPLOAD_UNAVAILABLE', 'The original job is not accepting uploads');
    const expected = frozen.directMedia ?? {};
    if (Object.keys(inputs).length !== Object.keys(expected).length || Object.entries(inputs).some(([name, uploaded]) =>
      !Object.hasOwn(expected, name) || uploaded.type !== 'input' || uploaded.subfolder !== job.id || uploaded.name !== expected[name]!.filename)) {
      throw new SystemError(400, 'COMFY_UPLOAD_INVALID', 'Upload acknowledgement does not match the reserved job inputs');
    }
    const serialized = JSON.stringify(Object.fromEntries(Object.keys(inputs).sort().map(name => [name, {
      name: inputs[name]!.name, subfolder: inputs[name]!.subfolder, type: inputs[name]!.type,
    }])));
    if (job.direct_inputs) {
      if (job.direct_inputs !== serialized) throw new SystemError(409, 'COMFY_UPLOAD_CONFLICT', 'Original input acknowledgement is immutable');
      return job;
    }
    if (job.stage !== 'awaiting_upload') throw new SystemError(409, 'COMFY_UPLOAD_UNAVAILABLE', 'Wait for the original job upload reservation');
    this.store.updateJob(id, { direct_inputs: serialized, stage: 'preparing' }, { completed: Object.keys(expected).length, total: Object.keys(expected).length });
    return this.get(id);
  }
  acknowledgeCollected(id: string): ComfyJob {
    const job = this.get(id);
    const input = JSON.parse(job.input) as FrozenComfyInput;
    if (input.transport !== 'direct' || job.stage !== 'succeeded' || !job.result) throw new SystemError(409, 'COMFY_RESULT_UNAVAILABLE', 'The original direct result is not ready');
    this.store.updateJob(id, { result_pending: 0, result_wake_requested: 0 });
    this.store.releaseSlot(id);
    return this.get(id);
  }
  cancel(id: string): ComfyJob {
    const job = this.get(id);
    if (!completeStages.has(job.stage)) this.store.updateJob(id, { cancel_requested: 1,
      ...(job.stage === 'queued' || job.stage === 'collecting' || job.stage === 'awaiting_upload' ? { stage: 'cancelled' as const, result_pending: 0 } : {}), error_code: 'COMFY_CANCELLED' });
    return this.get(id);
  }
  control(id: string, action: 'open' | 'close' | 'drain'): void {
    if (!this.options.configuration.instances.some(instance => instance.id === id)) throw new SystemError(404, 'COMFY_INSTANCE_UNKNOWN', 'Instance is not registered in this pool');
    const instance = this.store.instance(id)!;
    if (action === 'drain') { this.store.updateInstance(id, { draining: 1 }); return; }
    if (instance.job_id || action === 'close' && this.store.pendingResults(id).length || instance.state === 'starting' || instance.state === 'closing') throw new SystemError(409, 'COMFY_INSTANCE_BUSY', 'Instance has active or unresolved work');
    this.store.updateInstance(id, { state: action === 'open' ? 'starting' : 'closing', draining: action === 'close' ? 1 : 0,
      action_started_at: Date.now(), action_sent: 0, error_code: null, ...(action === 'open' ? { idle_policy_applied_at: null } : {}) });
  }
  async reconcile(id: string): Promise<void> {
    const job = this.get(id);
    if (job.stage === 'succeeded' && job.result) return;
    if (!job.instance_id) return;
    const instance = this.options.configuration.instances.find(candidate => candidate.id === job.instance_id);
    if (!instance) throw new SystemError(409, 'COMFY_INSTANCE_UNKNOWN', 'Original instance configuration is unavailable');
    if (!this.store.acquireWorker(this.worker, Date.now())) throw new SystemError(409, 'COMFY_WORKER_BUSY', 'Another worker owns this pool');
    if (this.active || this.collecting.has(id)) throw new SystemError(409, 'COMFY_WORKER_BUSY', 'This job is being processed');
    this.active = (async () => {
      await this.observe(job, this.options.client(instance), true);
      if (this.store.get(id)?.stage === 'collecting') await this.collect(job.id, this.options.client(instance));
    })().finally(() => { this.active = undefined; });
    await this.active;
  }
  tick(): Promise<void> {
    if (this.closing.signal.aborted) return Promise.resolve();
    if (!this.store.acquireWorker(this.worker, Date.now())) return Promise.resolve();
    const operation = this.runTick().catch(() => {});
    this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = undefined; });
    return operation;
  }
  private async runTick(): Promise<void> {
    for (const job of this.store.queued()) {
      if (job.owner !== this.options.owner) this.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_OWNER_UNAVAILABLE' });
      else if (job.deadline <= Date.now()) this.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_QUEUE_TIMEOUT' });
    }
    const maintenance = this.options.configuration.scheduler ? this.lifecycle.tick() : Promise.resolve();
    const instances = [...this.options.configuration.instances].sort((left, right) => (left.gpuModel === '4090' ? 1 : 0) - (right.gpuModel === '4090' ? 1 : 0));
    const operations: Promise<void>[] = [];
    for (const instance of instances) {
      if (this.processing.has(instance.id)) continue;
      const operation = this.processInstance(instance).catch(error => {
        if (this.store.ownsWorker(this.worker) && !this.closing.signal.aborted) {
          this.store.updateInstance(instance.id, { error_code: codeOf(error), next_action_at: Date.now() + (this.options.configuration.capacityPollIntervalMs ?? 30_000) }, diagnosticDetails(error));
          this.checkActionTimeout(instance.id);
        }
      }).finally(() => { this.processing.delete(instance.id); });
      this.processing.set(instance.id, operation);
      operations.push(operation);
    }
    await Promise.all([...operations, maintenance]);
  }
  private async processInstance(configuration: InstanceConfiguration): Promise<void> {
    this.assertWorker();
    let instance = this.store.instance(configuration.id)!;
    const client = this.options.client(configuration);
    if (instance.job_id) {
      const job = this.store.get(instance.job_id)!;
      const policy = schedulerPolicy(this.options.configuration);
      if (['awaiting_upload', 'preparing'].includes(job.stage) && !job.provider_confirmed && job.cancel_requested) {
        this.store.updateJob(job.id, { stage: 'cancelled', error_code: 'COMFY_CANCELLED' });
        this.store.releaseSlot(job.id);
        instance = this.store.instance(configuration.id)!;
      } else if (job.stage === 'preparing' && job.deadline <= Date.now()) {
        this.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_PREPARATION_TIMEOUT' });
        this.store.releaseSlot(job.id);
        instance = this.store.instance(configuration.id)!;
      } else if (job.stage === 'awaiting_upload' && !job.cancel_requested && !job.direct_inputs && (job.deadline <= Date.now() || this.options.configuration.scheduler &&
        Date.now() - (job.reservation_started_at ?? job.updated_at) >= policy.uploadReservationTimeoutMs)) {
        if (job.deadline > Date.now() && job.upload_reservations < policy.maxUploadReservations && this.store.requeueUpload(job.id, policy.uploadRetryDelayMs)) {
          instance = this.store.instance(configuration.id)!;
        } else {
          this.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_UPLOAD_TIMEOUT' });
          this.store.releaseSlot(job.id);
          instance = this.store.instance(configuration.id)!;
        }
      } else if (['submitting', 'running'].includes(job.stage) && job.deadline <= Date.now()) {
        this.store.updateJob(job.id, { stage: job.cancel_requested ? 'cancelled' : 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED' });
      }
    }
    if (instance.state === 'quarantined') {
      this.store.updateInstance(instance.id, { state: 'offline', action_started_at: null, action_sent: 0, capacity_started_at: null,
        next_action_at: Date.now() + (this.options.configuration.capacityPollIntervalMs ?? 30_000) });
      instance = this.store.instance(instance.id)!;
    }
    const resultRequests = this.store.pendingResults(instance.id).filter(job => job.result_wake_requested && (JSON.parse(job.input) as FrozenComfyInput).transport === 'direct');
    if (resultRequests.length) {
      try {
        await client.health();
        this.assertWorker();
        for (const job of resultRequests) this.store.updateJob(job.id, { result_wake_requested: 0, result_checked_at: Date.now() });
        resultRequests.length = 0;
      } catch (error) {
        this.assertWorker();
        if (instance.job_id) throw error;
      }
    }
    for (const job of this.store.pendingResults(instance.id)) {
      if (job.stage !== 'collecting') continue;
      if (job.deadline <= Date.now()) { this.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_COLLECTION_TIMEOUT' }); continue; }
      this.launchCollection(job.id, client);
    }
    if (instance.state === 'waiting_capacity' && instance.capacity_started_at !== null && Date.now() - instance.capacity_started_at >= (this.options.configuration.capacityWaitTimeoutMs ?? 21_600_000)) {
      this.deferInstance(instance.id, 'COMFY_CAPACITY_WAIT_TIMEOUT');
      return;
    }
    if ((instance.next_action_at ?? 0) > Date.now()) {
      this.checkActionTimeout(instance.id);
      return;
    }
    if (instance.job_id) {
      let job = this.store.get(instance.job_id)!;
      if (job.stage === 'awaiting_upload' || job.stage === 'cancelled' && !job.provider_confirmed) {
        if (job.cancel_requested || job.deadline <= Date.now()) {
          this.store.updateJob(job.id, { stage: job.cancel_requested ? 'cancelled' : 'failed', error_code: job.cancel_requested ? 'COMFY_CANCELLED' : 'COMFY_UPLOAD_TIMEOUT' });
          this.store.releaseSlot(job.id);
        } else if (job.stage === 'awaiting_upload') await this.ensureUploadReady(configuration, client);
      } else if (job.stage === 'preparing') {
        if ((JSON.parse(job.input) as FrozenComfyInput).transport !== 'direct' || await this.ensureUploadReady(configuration, client)) await this.prepare(job, client);
      }
      else {
        if (this.options.configuration.scheduler) {
          const status = await this.options.platform.getInstanceStatus(instance.id);
          this.assertWorker();
          if (status !== '2') { await this.ensureUploadReady(configuration, client); return; }
        }
        await this.observe(job, client);
        if (this.store.instance(instance.id)?.job_id && job.deadline <= Date.now() && !['collecting', 'succeeded', 'cancelled'].includes(this.store.get(job.id)!.stage)) {
          this.store.updateJob(job.id, { stage: job.cancel_requested ? 'cancelled' : 'failed', error_code: 'COMFY_REMOTE_UNCONFIRMED' });
          this.deferInstance(instance.id, 'COMFY_REMOTE_UNCONFIRMED');
        }
      }
      instance = this.store.instance(configuration.id)!;
      if (instance.job_id) return;
    }
    if (instance.state === 'offline' && (instance.next_action_at ?? 0) > Date.now()) return;
    if (instance.state === 'waiting_capacity') {
      if (instance.capacity_started_at !== null && Date.now() - instance.capacity_started_at >= (this.options.configuration.capacityWaitTimeoutMs ?? 21_600_000)) {
        this.deferInstance(instance.id, 'COMFY_CAPACITY_WAIT_TIMEOUT'); return;
      }
      if ((instance.next_action_at ?? 0) > Date.now()) return;
    }
    const compatible = (job: ComfyJob) => {
      const frozen = JSON.parse(job.input) as FrozenComfyInput;
      return (!job.instance_id || job.instance_id === configuration.id) && (job.eligible_at ?? 0) <= Date.now()
        && configuration.workflowIds.includes(frozen.workflowId) && (frozen.transport !== 'direct' || !Object.keys(configuration.headers ?? {}).length);
    };
    const queued = this.store.queued().some(compatible);
    if (instance.state === 'waiting_capacity' && !queued && !resultRequests.length) return;
    if (instance.state === 'closing' || instance.state === 'starting' || (queued || resultRequests.length) && !instance.draining) {
      const status = await this.options.platform.getInstanceStatus(instance.id);
      this.assertWorker();
      instance = this.store.instance(configuration.id)!;
      if (instance.state === 'closing') {
        if (status === '22' || status === '26') { this.store.updateInstance(instance.id, { state: 'offline', action_started_at: null, action_sent: 0, stopped_at: instance.stopped_at ?? Date.now() }); return; }
        if (!instance.action_sent && status === '2') {
          const queue = await client.queue();
          this.assertWorker();
          if (queue.running.length || queue.pending.length) {
            this.store.updateInstance(instance.id, { error_code: 'COMFY_EXTERNAL_OCCUPANCY', action_started_at: null,
              next_action_at: Date.now() + (this.options.configuration.capacityPollIntervalMs ?? 30_000) });
            return;
          }
          this.store.updateInstance(instance.id, { action_sent: 1, action_started_at: Date.now() });
          await this.options.platform.closeInstance(instance.id);
        }
        this.checkActionTimeout(instance.id);
        return;
      }
      if (status !== '2') {
        const prior = this.opening;
        let release!: () => void;
        this.opening = new Promise<void>(resolve => { release = resolve; });
        await prior;
        try {
        this.assertWorker();
        instance = this.store.instance(configuration.id)!;
        this.store.updateInstance(instance.id, { idle_policy_applied_at: null });
        const needed = this.store.queued().filter(compatible).length + resultRequests.length;
        const reserved = this.store.instances().filter(candidate => candidate.id !== instance.id && !candidate.draining && !candidate.job_id && candidate.state === 'starting'
          && this.options.configuration.instances.some(registered => registered.id === candidate.id && registered.workflowIds.some(id => configuration.workflowIds.includes(id)))).length;
        const activeCount = this.store.instances().filter(candidate => candidate.id !== instance.id && !candidate.draining && ['ready', 'busy', 'starting'].includes(candidate.state)).length;
        if (instance.state !== 'starting' && activeCount < schedulerPolicy(this.options.configuration).maxConcurrentInstances && (instance.state === 'waiting_capacity' || this.options.configuration.autoOpen && needed > reserved) && ['22', '26'].includes(status)) {
          this.store.updateInstance(instance.id, { state: 'starting', action_started_at: Date.now(), action_sent: 0, error_code: null, next_action_at: null });
          instance = this.store.instance(instance.id)!;
        }
        if (instance.state === 'starting' && !instance.action_sent && ['22', '26'].includes(status)) {
          this.store.updateInstance(instance.id, { action_sent: 1 });
          try { await this.options.platform.openInstance(instance.id); }
          catch (error) {
            this.assertWorker();
            if ((error as { code?: string })?.code !== 'CAPACITY_UNAVAILABLE') throw error;
            this.store.updateInstance(instance.id, { state: 'waiting_capacity', action_started_at: null, action_sent: 0,
              capacity_started_at: instance.capacity_started_at ?? Date.now(), next_action_at: Date.now() + (this.options.configuration.capacityPollIntervalMs ?? 30_000), error_code: 'COMFY_CAPACITY_UNAVAILABLE' }, diagnosticDetails(error));
            for (const job of this.store.queued().filter(compatible)) this.store.events.record({ type: 'job.updated', jobId: job.id, instanceId: instance.id,
              stage: 'queued', code: 'COMFY_CAPACITY_UNAVAILABLE', details: { areaName: configuration.areaName, gpuModel: configuration.gpuModel, ...diagnosticDetails(error) } });
            return;
          }
        }
        this.checkActionTimeout(instance.id);
        } finally { release(); }
        return;
      }
      if (configuration.areaName && this.options.platform.getInstance) {
        const metadata = await this.options.platform.getInstance(instance.id);
        this.assertWorker();
        if (metadata.areaName !== configuration.areaName) {
          this.deferInstance(instance.id, 'COMFY_REGION_MISMATCH'); return;
        }
      }
      await client.health();
      const queue = await client.queue();
      this.assertWorker();
      const latest = this.store.instance(instance.id)!;
      if (latest.state === 'closing') return;
      if (queue.running.length || queue.pending.length) {
        this.deferInstance(instance.id, 'COMFY_EXTERNAL_OCCUPANCY');
        return;
      }
      await this.configureIdlePolicy(instance.id);
      this.store.updateInstance(instance.id, { state: 'ready', action_started_at: null, capacity_started_at: null, next_action_at: null, error_code: null, stopped_at: null });
      for (const job of resultRequests) this.store.updateJob(job.id, { result_wake_requested: 0, result_checked_at: Date.now() });
    }
    const workflowIds = configuration.workflowIds.filter(id => this.store.queued().some(job => compatible(job) && (JSON.parse(job.input) as FrozenComfyInput).workflowId === id));
    if (this.store.instances().filter(candidate => candidate.job_id).length >= schedulerPolicy(this.options.configuration).maxConcurrentInstances) return;
    const next = this.store.claim(instance.id, workflowIds);
    if (next) {
      this.store.updateJob(next.id, { deadline: Date.now() + this.options.configuration.jobTimeoutMs });
      const frozen = JSON.parse(next.input) as FrozenComfyInput;
      if (frozen.transport === 'direct') this.store.updateJob(next.id, { stage: 'awaiting_upload' });
      else await this.prepare(this.store.get(next.id)!, client);
    }
  }
  private async ensureUploadReady(configuration: InstanceConfiguration, client: DataClient): Promise<boolean> {
    let instance = this.store.instance(configuration.id)!;
    if ((instance.next_action_at ?? 0) > Date.now()) return false;
    if (instance.state === 'waiting_capacity') {
      if (instance.capacity_started_at !== null && Date.now() - instance.capacity_started_at >= (this.options.configuration.capacityWaitTimeoutMs ?? 21_600_000)) {
        this.deferInstance(instance.id, 'COMFY_CAPACITY_WAIT_TIMEOUT');
        return false;
      }
      if ((instance.next_action_at ?? 0) > Date.now()) return false;
    }
    const status = await this.options.platform.getInstanceStatus(instance.id);
    this.assertWorker();
    instance = this.store.instance(configuration.id)!;
    if (status !== '2') {
      if (instance.state !== 'starting') {
        this.store.updateInstance(instance.id, { state: 'starting', action_started_at: Date.now(), action_sent: 0,
          idle_policy_applied_at: null, error_code: 'COMFY_UPLOAD_INSTANCE_OFFLINE' });
        instance = this.store.instance(instance.id)!;
      }
      if (!instance.action_sent && ['22', '26'].includes(status)) {
        this.store.updateInstance(instance.id, { action_sent: 1, error_code: null });
        try { await this.options.platform.openInstance(instance.id); }
        catch (error) {
          this.assertWorker();
          if ((error as { code?: string })?.code !== 'CAPACITY_UNAVAILABLE') throw error;
          this.store.updateInstance(instance.id, { state: 'waiting_capacity', action_started_at: null, action_sent: 0,
            capacity_started_at: instance.capacity_started_at ?? Date.now(), next_action_at: Date.now() + (this.options.configuration.capacityPollIntervalMs ?? 30_000),
            error_code: 'COMFY_CAPACITY_UNAVAILABLE' }, diagnosticDetails(error));
          return false;
        }
      }
      this.checkActionTimeout(instance.id);
      return false;
    }
    if (!this.options.configuration.scheduler && instance.state === 'busy' && instance.idle_policy_applied_at) return true;
    await client.health();
    const queue = await client.queue();
    this.assertWorker();
    if (queue.running.length || queue.pending.length) {
      this.deferInstance(instance.id, 'COMFY_EXTERNAL_OCCUPANCY');
      return false;
    }
    await this.configureIdlePolicy(instance.id);
    this.store.updateInstance(instance.id, { state: 'busy', action_started_at: null, action_sent: 0,
      capacity_started_at: null, next_action_at: null, error_code: null, stopped_at: null });
    return true;
  }
  private deferInstance(id: string, code: string): void {
    this.store.updateInstance(id, { state: 'offline', error_code: code, action_started_at: null, action_sent: 0,
      capacity_started_at: null, next_action_at: Date.now() + (this.options.configuration.capacityPollIntervalMs ?? 30_000) });
  }
  private checkActionTimeout(id: string): void {
    const instance = this.store.instance(id)!;
    if (instance.action_started_at && Date.now() - instance.action_started_at >= this.options.configuration.bootTimeoutMs) {
      if (instance.state === 'closing') this.store.updateInstance(id, { action_started_at: null, action_sent: 0,
        error_code: 'COMFY_INSTANCE_ACTION_TIMEOUT', next_action_at: Date.now() + (this.options.configuration.capacityPollIntervalMs ?? 30_000) });
      else this.deferInstance(id, 'COMFY_INSTANCE_ACTION_TIMEOUT');
    }
  }
  private async prepare(job: ComfyJob, client: DataClient): Promise<void> {
    try {
      if (job.cancel_requested) { this.store.updateJob(job.id, { stage: 'cancelled' }); this.store.releaseSlot(job.id); return; }
      if (job.owner !== this.options.owner) { this.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_OWNER_UNAVAILABLE' }); this.store.releaseSlot(job.id); return; }
      const input = JSON.parse(job.input) as FrozenComfyInput;
      const values = { ...input.values };
      if (input.transport === 'direct') {
        if (!job.direct_inputs) throw new Error('Direct media has not been acknowledged');
        const uploaded = JSON.parse(job.direct_inputs) as Record<string, { name: string; subfolder: string }>;
        for (const [name, media] of Object.entries(uploaded)) values[name] = `${media.subfolder}/${media.name}`;
      }
      for (const [name, binding] of Object.entries(input.profile.bindings)) if (binding.kind === 'output-prefix') values[name] = job.id;
      for (const [name, id] of Object.entries(input.media)) {
        this.assertWorker();
        if (this.store.get(job.id)?.cancel_requested) { this.store.updateJob(job.id, { stage: 'cancelled' }); this.store.releaseSlot(job.id); return; }
        const asset = this.options.assets.get(id);
        const bytes = this.options.ownsAsset(id) ? await this.options.assets.read(id) : undefined;
        if (!asset || !bytes) throw new SystemError(400, 'ASSET_UNAVAILABLE', 'Uploaded media is unavailable');
        const uploaded = await client.upload({ bytes, filename: `${id}${path.extname(asset.originalName)}`, contentType: asset.mimeType, subfolder: job.id });
        if (uploaded.type !== 'input') throw new Error('Unexpected upload storage type');
        values[name] = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
      }
      const graph = compileWorkflow(input.profile, values);
      this.assertWorker();
      const current = this.store.get(job.id)!;
      if (current.cancel_requested) { this.store.updateJob(job.id, { stage: 'cancelled' }); this.store.releaseSlot(job.id); return; }
      if (current.deadline <= Date.now()) { this.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_PREPARATION_TIMEOUT' }); this.store.releaseSlot(job.id); return; }
      this.store.updateJob(job.id, { stage: 'submitting' });
      const accepted = await client.submit({ graph, attemptId: job.id, promptId: job.prompt_id });
      this.assertWorker();
      this.store.updateJob(job.id, { prompt_id: accepted.promptId, provider_confirmed: 1, stage: 'running',
        error_code: this.store.get(job.id)?.cancel_requested ? 'COMFY_CANCELLED' : null });
    } catch (error) {
      this.assertWorker();
      const current = this.store.get(job.id)!;
      if (current.stage === 'preparing' || (error as { uncertain?: boolean })?.uncertain === false) {
        this.store.updateJob(job.id, { stage: current.cancel_requested ? 'cancelled' : 'failed', error_code: codeOf(error) }, diagnosticDetails(error));
        this.store.releaseSlot(job.id);
      } else this.store.updateInstance(job.instance_id!, { error_code: 'COMFY_SUBMISSION_UNCONFIRMED' });
    }
  }
  private async observe(job: ComfyJob, client: DataClient, manual = false): Promise<void> {
    let history = await client.history(job.prompt_id);
    this.assertWorker();
    if (history.state === 'missing') {
      const recovered = await client.findAttempt(job.id);
      this.assertWorker();
      if (!recovered) return;
      this.store.updateJob(job.id, { prompt_id: recovered.promptId, provider_confirmed: 1 });
      history = await client.history(recovered.promptId);
      this.assertWorker();
    }
    const current = this.store.get(job.id)!;
    if (history.state !== 'missing') this.store.updateJob(job.id, { provider_confirmed: 1 });
    if (history.state === 'failed') {
      this.store.updateJob(job.id, { stage: current.cancel_requested ? 'cancelled' : 'failed', error_code: current.cancel_requested ? 'COMFY_CANCELLED' : 'COMFY_RENDER_FAILED' }, history.error);
      this.store.releaseSlot(job.id);
    } else if (history.state === 'succeeded') {
      if (current.cancel_requested) this.store.updateJob(job.id, { stage: 'cancelled', result_pending: 0 });
      else if (!completeStages.has(current.stage) || manual || current.error_code === 'COMFY_REMOTE_UNCONFIRMED') this.store.updateJob(job.id, {
        stage: 'collecting', result_pending: 1, error_code: null,
        ...(current.error_code === 'COMFY_REMOTE_UNCONFIRMED' ? { deadline: Date.now() + this.options.configuration.jobTimeoutMs } : {}) });
      const input = JSON.parse(current.input) as FrozenComfyInput;
      if (input.transport === 'direct' && !current.cancel_requested) {
        const outputs = history.outputs.filter(output => input.profile.outputNodeIds.includes(output.nodeId ?? '') && output.type === 'output' && /\.mp4$/i.test(output.filename));
        if (outputs.length !== 1) throw new Error('Expected exactly one registered MP4 output');
        const configuration = this.options.configuration.instances.find(instance => instance.id === current.instance_id)!;
        const output = outputs[0]!;
        const videoUrl = `${configuration.baseUrl.replace(/\/$/, '')}/view?${new URLSearchParams({ filename: output.filename, subfolder: output.subfolder, type: output.type })}`;
        this.store.updateJob(job.id, { stage: 'succeeded', result_pending: current.result_pending || !current.result ? 1 : 0, result: JSON.stringify({ videoUrl }), result_checked_at: Date.now(), result_wake_requested: 0, error_code: null });
        if (Object.values(input.profile.bindings).some(binding => binding.kind === 'output-prefix')) this.store.releaseSlot(job.id);
        return;
      }
      if (current.cancel_requested || Object.values(input.profile.bindings).some(binding => binding.kind === 'output-prefix')) this.store.releaseSlot(job.id);
      if (!manual && this.store.get(job.id)?.stage === 'collecting') this.launchCollection(job.id, client);
    } else if (current.stage === 'submitting') this.store.updateJob(job.id, { stage: 'running' });
  }
  private launchCollection(id: string, client: DataClient): void {
    if (this.collecting.has(id) || this.collecting.size >= (this.options.configuration.scheduler?.maxConcurrentInstances ?? 3)) return;
    const operation = this.collect(id, client).finally(() => { this.collecting.delete(id); });
    this.collecting.set(id, operation);
  }
  private async collect(id: string, client: DataClient): Promise<void> {
    try {
      const job = this.store.get(id)!;
      const input = JSON.parse(job.input) as FrozenComfyInput;
      const history = await client.history(job.prompt_id);
      const outputs = history.outputs.filter(output => input.profile.outputNodeIds.includes(output.nodeId ?? '') && /\.mp4$/i.test(output.filename));
      if (history.state !== 'succeeded' || outputs.length !== 1) throw new Error('Expected exactly one registered MP4 output');
      const response = await client.download(outputs[0]!);
      const result = await this.options.results.save(job.id, response, this.closing.signal);
      this.assertWorker();
      const current = this.store.get(id)!;
      if (current.cancel_requested) this.store.updateJob(id, { stage: 'cancelled', result_pending: 0 });
      else if (current.stage === 'collecting') this.store.updateJob(id, { stage: 'succeeded', result_pending: 0, result: JSON.stringify(result), error_code: null });
      else this.store.updateJob(id, { result_pending: 0, result: JSON.stringify(result) });
      this.store.releaseSlot(id);
    } catch (error) {
      if (this.store.ownsWorker(this.worker) && !this.closing.signal.aborted) this.store.updateJob(id, { error_code: codeOf(error) }, diagnosticDetails(error));
    }
  }
}
