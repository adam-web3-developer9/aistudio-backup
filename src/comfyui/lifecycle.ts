import { randomUUID } from 'node:crypto';
import type { AigateClient, AigateInstance } from './aigate-client.js';
import type { ComfyPoolConfiguration } from './configuration.js';
import type { ComfyClient } from './comfy-client.js';
import type { ComfyResource, ComfyStore, FrozenComfyInput } from './store.js';
import { schedulerPolicy } from './scheduler.js';

type InstanceConfiguration = ComfyPoolConfiguration['instances'][number];
type ElasticTemplate = NonNullable<ComfyPoolConfiguration['elastic']>['templates'][number];
export type ComfyLifecyclePlatform = Pick<AigateClient, 'getInstanceStatus' | 'closeInstance'> &
  Partial<Pick<AigateClient, 'getInstance' | 'skuList' | 'createInstance' | 'releaseInstance' | 'pageInstances'>>;

function safeCode(error: unknown): string {
  const value = (error as { code?: unknown })?.code;
  return typeof value === 'string' && /^[A-Z_]{1,80}$/.test(value) ? 'COMFY_' + value : 'COMFY_LIFECYCLE_FAILED';
}

export class ComfyLifecycle {
  private active?: Promise<void>;
  private managing = false;
  lastError: string | null = null;
  constructor(private readonly options: {
    store: ComfyStore; configuration: ComfyPoolConfiguration; platform: ComfyLifecyclePlatform;
    client: (instance: InstanceConfiguration) => Pick<ComfyClient, 'health' | 'queue'>;
    assertWorker: () => void;
  }) {
    for (const resource of options.store.resources()) {
      if (!resource.instance_id) continue;
      if (resource.state === 'released') { this.removeConfiguration(resource.instance_id); continue; }
      if (!resource.configuration) continue;
      const configuration = JSON.parse(resource.configuration) as InstanceConfiguration;
      if (configuration.id !== resource.instance_id || !Array.isArray(configuration.workflowIds)
        || configuration.workflowIds.some(id => !options.configuration.workflows.some(profile => profile.id === id))) {
        throw new Error('Invalid persisted ComfyUI resource configuration');
      }
      if (!options.configuration.instances.some(instance => instance.id === configuration.id)) {
        this.validateEndpoint(configuration.baseUrl);
        options.configuration.instances.push(configuration);
      }
      options.store.registerInstances([configuration.id]);
      if (resource.state === 'releasing') options.store.updateInstance(configuration.id, { draining: 1 });
    }
  }

  tick(): Promise<void> {
    if (this.active || this.managing) return Promise.resolve();
    const operation = this.run().catch(error => { this.lastError = safeCode(error); });
    this.active = operation;
    void operation.finally(() => { if (this.active === operation) this.active = undefined; });
    return operation;
  }
  async close(): Promise<void> { await this.active; }
  isBusy(): boolean { return !!this.active || this.managing; }
  async inspect(key: string): Promise<void> {
    const resource = this.options.store.resource(key);
    if (!resource?.instance_id || !this.options.platform.getInstance) throw { code: 'RESOURCE_INSPECTION_UNAVAILABLE' };
    const metadata = await this.options.platform.getInstance(resource.instance_id);
    this.options.assertWorker();
    if (metadata.id !== resource.instance_id) throw { code: 'RESOURCE_ID_MISMATCH' };
    this.options.store.observeResource(key, metadata.operationStatus ?? metadata.status);
  }
  async stopUnregistered(key: string): Promise<void> {
    if (this.isBusy()) throw { code: 'RESOURCE_BUSY' };
    this.managing = true;
    try { await this.stopUnregisteredOperation(key); }
    finally { this.managing = false; }
  }
  private async stopUnregisteredOperation(key: string): Promise<void> {
    const resource = this.options.store.resource(key);
    if (!resource?.instance_id || resource.configuration || !['creating', 'blocked'].includes(resource.state)
      || this.options.configuration.instances.some(instance => instance.id === resource.instance_id)
      || this.options.store.hasUnresolvedWork(resource.instance_id)) throw { code: 'RESOURCE_STOP_UNSAFE' };
    if (resource.error_code === 'COMFY_RESOURCE_STOP_REQUESTED') throw { code: 'RESOURCE_STOP_UNCONFIRMED' };
    const metadata = await this.options.platform.getInstance!(resource.instance_id);
    this.options.assertWorker();
    if (metadata.id !== resource.instance_id) throw { code: 'RESOURCE_ID_MISMATCH' };
    const status = metadata.operationStatus ?? metadata.status;
    if (!['2', '22', '26'].includes(status)) throw { code: 'RESOURCE_STOP_UNSAFE' };
    this.options.store.observeResource(key, status);
    this.options.store.saveResource({ ...resource, state: 'blocked', error_code: status === '2' ? 'COMFY_RESOURCE_STOP_REQUESTED' : 'COMFY_RESOURCE_STOPPED', updated_at: Date.now() });
    if (status === '2') await this.options.platform.closeInstance(resource.instance_id);
  }

  private async run(): Promise<void> {
    this.options.assertWorker();
    await this.reconcile();
    this.warm();
    await this.scale();
    await Promise.all([...this.options.configuration.instances].map(async instance => {
      try { await this.idle(instance); }
      catch (error) {
        this.options.assertWorker();
        this.options.store.updateInstance(instance.id, { error_code: safeCode(error) });
      }
    }));
  }

  private pending() {
    return this.options.store.queued().filter(job => job.deadline > Date.now() && (job.eligible_at ?? 0) <= Date.now());
  }
  private warm(): void {
    const { configuration, store } = this.options;
    if (!configuration.autoOpen) return;
    const policy = schedulerPolicy(configuration);
    const warm = configuration.instances.filter(instance => !store.instance(instance.id)?.draining
      && ['ready', 'busy', 'starting'].includes(store.instance(instance.id)!.state)).length;
    let remaining = Math.min(policy.minWarmInstances, policy.maxConcurrentInstances) - warm;
    if (configuration.elastic?.enabled) {
      const cost = this.reservedCost();
      if (cost === null || cost > (configuration.elastic.maxHourlyCost ?? 0)) return;
    }
    for (const configuration of this.options.configuration.instances) {
      if (remaining <= 0) return;
      const instance = store.instance(configuration.id)!;
      if (instance.draining || instance.state !== 'offline' || store.hasUnresolvedWork(instance.id) || (instance.next_action_at ?? 0) > Date.now()) continue;
      store.updateInstance(instance.id, { state: 'starting', action_started_at: Date.now(), action_sent: 0, stopped_at: null, idle_since: null });
      remaining--;
    }
  }
  private compatible(instance: Pick<InstanceConfiguration, 'workflowIds'> & Partial<Pick<InstanceConfiguration, 'id'>>) {
    return this.pending().filter(job => (!job.instance_id || job.instance_id === instance.id)
      && instance.workflowIds.includes((JSON.parse(job.input) as FrozenComfyInput).workflowId));
  }
  private reservedCost(): number | null {
    let total = 0;
    const resources = this.options.store.resources().filter(resource => resource.state !== 'released');
    for (const instance of this.options.configuration.instances) {
      const resource = resources.find(item => item.instance_id === instance.id);
      const compute = resource?.hourly_cost ?? instance.lifecycle?.hourlyCost;
      const storage = resource?.storage_hourly_cost ?? instance.lifecycle?.storageHourlyCost;
      if (compute === undefined || storage === undefined) return null;
      total += compute + storage;
    }
    for (const resource of resources) {
      if (!this.options.configuration.instances.some(instance => instance.id === resource.instance_id)) total += resource.hourly_cost + resource.storage_hourly_cost;
    }
    return total;
  }

  private async scale(): Promise<void> {
    const { configuration, store, platform } = this.options;
    const elastic = configuration.elastic;
    if (!configuration.autoOpen || !elastic?.enabled) return;
    if (!platform.skuList || !platform.createInstance || !platform.getInstance) { this.lastError = 'COMFY_ELASTIC_API_UNAVAILABLE'; return; }
    const resources = store.resources();
    if (resources.some(resource => ['creating', 'uncertain', 'blocked', 'releasing'].includes(resource.state))) {
      this.lastError = 'COMFY_RESOURCE_RECONCILIATION_REQUIRED'; return;
    }
    const policy = schedulerPolicy(configuration);
    const lastCreated = Math.max(0, ...resources.map(resource => resource.created_at));
    if (Date.now() - lastCreated < elastic.createCooldownMs) return;
    const committed = this.reservedCost();
    if (committed === null) { this.lastError = 'COMFY_COST_UNKNOWN'; return; }
    if (configuration.instances.length >= elastic.maxInstances || configuration.instances.length >= policy.maxConcurrentInstances) return;
    const templates = [...elastic.templates].sort((left, right) => (left.gpuModel === '4090' ? 1 : 0) - (right.gpuModel === '4090' ? 1 : 0) || left.hourlyCost - right.hourlyCost);
    for (const template of templates) {
      if (!template.skuPriceUnitVerified || !Number.isFinite(template.skuPriceToHourlyFactor) || template.skuPriceToHourlyFactor <= 0) {
        this.lastError = 'COMFY_SKU_PRICE_UNIT_UNVERIFIED'; continue;
      }
      const demand = this.compatible({ workflowIds: template.workflowIds }).length;
      if (!demand) continue;
      const supported = configuration.instances.filter(instance => !store.instance(instance.id)?.draining
        && instance.workflowIds.some(id => template.workflowIds.includes(id)));
      const busy = supported.filter(instance => store.instance(instance.id)?.job_id).length;
      const desired = Math.min(policy.maxConcurrentInstances, busy + Math.ceil(demand * policy.estimatedJobMs / policy.targetQueueWaitMs));
      if (supported.length >= desired) continue;
      if (committed + template.hourlyCost + template.storageHourlyCost > (elastic.maxHourlyCost ?? 0)) {
        this.lastError = 'COMFY_ELASTIC_BUDGET_EXCEEDED'; continue;
      }
      const skus = await platform.skuList(template.areaName);
      this.options.assertWorker();
      const sku = skus.find(item => item.areaName === template.areaName && item.skuName === template.skuName);
      if (!sku || !sku.skuName.includes(template.gpuModel) || !/^\d+(?:\.\d+)?$/.test(sku.price)
        || !Number.isFinite(Number(sku.price) * template.skuPriceToHourlyFactor)
        || Number(sku.price) * template.skuPriceToHourlyFactor > template.hourlyCost) {
        this.lastError = 'COMFY_SKU_QUOTE_UNVERIFIED'; continue;
      }
      if (!this.compatible({ workflowIds: template.workflowIds }).some(job => !job.instance_id)) return;
      const key = randomUUID();
      const resource: ComfyResource = { key, name: 'hailuo-' + key, state: 'creating', instance_id: null, configuration: null,
        template_id: template.id, hourly_cost: template.hourlyCost, storage_hourly_cost: template.storageHourlyCost,
        created_at: Date.now(), updated_at: Date.now(), error_code: null };
      store.saveResource(resource);
      try {
        const id = await platform.createInstance({ areaName: template.areaName, count: 1, skuName: template.skuName,
          imageId: template.imageId, imageType: template.imageType });
        this.options.assertWorker();
        resource.instance_id = id;
        store.saveResource({ ...resource, updated_at: Date.now() });
        await this.register(resource, template);
        this.lastError = null;
      } catch (error) {
        this.options.assertWorker();
        const capacityUnavailable = !resource.instance_id && (error as { uncertain?: boolean })?.uncertain === false
          && (error as { code?: string })?.code === 'CAPACITY_UNAVAILABLE';
        store.saveResource({ ...resource, state: resource.instance_id ? 'creating' : (error as { uncertain?: boolean })?.uncertain === false ? 'released' : 'uncertain',
          updated_at: Date.now(), error_code: safeCode(error) });
        this.lastError = resource.instance_id ? 'COMFY_RESOURCE_INITIALIZING' : capacityUnavailable ? 'COMFY_CAPACITY_UNAVAILABLE' : 'COMFY_CREATION_UNCONFIRMED';
        if (capacityUnavailable) continue;
      }
      return;
    }
  }

  private async register(resource: ComfyResource, template: ElasticTemplate, observed?: AigateInstance): Promise<void> {
    const metadata = observed ?? await this.options.platform.getInstance!(resource.instance_id!);
    this.options.assertWorker();
    if (metadata.id !== resource.instance_id) throw { code: 'RESOURCE_ID_MISMATCH' };
    this.options.store.observeResource(resource.key, metadata.operationStatus ?? metadata.status);
    if (metadata.id !== resource.instance_id || metadata.areaName !== template.areaName || metadata.imageId !== template.imageId
      || metadata.imageType !== template.imageType || metadata.count !== 1) throw { code: 'ELASTIC_METADATA_UNVERIFIED' };
    const candidates = metadata.services.filter(item => /^(?:https?)$/i.test(item.protocol ?? '') && item.httpType === '1' && item.port === 8188);
    const service = candidates.length === 1 ? candidates[0] : undefined;
    if (!service) throw { code: 'ELASTIC_ENDPOINT_PENDING' };
    const baseUrl = this.endpoint(service);
    const configuration: InstanceConfiguration = { id: metadata.id, baseUrl, areaName: template.areaName, gpuModel: template.gpuModel,
      workflowIds: template.workflowIds, headers: {}, lifecycle: { allowRelease: template.allowRelease, rebuildVerified: template.rebuildVerified,
        hourlyCost: template.hourlyCost, storageHourlyCost: template.storageHourlyCost } };
    if (this.options.configuration.instances.some(instance => instance.id === metadata.id)) throw { code: 'ELASTIC_INSTANCE_COLLISION' };
    this.options.store.saveResource({ ...resource, state: 'registered', configuration: JSON.stringify(configuration), updated_at: Date.now(), error_code: null });
    this.options.store.registerInstances([metadata.id]);
    this.options.configuration.instances.push(configuration);
  }

  private async reconcile(): Promise<void> {
    const { store, configuration, platform } = this.options;
    for (const resource of store.resources()) {
      if ((resource.state === 'creating' || resource.state === 'blocked') && resource.instance_id) {
        const template = configuration.elastic?.templates.find(item => item.id === resource.template_id);
        if (!template || !platform.getInstance) { this.lastError = 'COMFY_RESOURCE_RECONCILIATION_REQUIRED'; continue; }
        try {
          const metadata = await platform.getInstance(resource.instance_id);
          this.options.assertWorker();
          if (metadata.id !== resource.instance_id) throw { code: 'RESOURCE_ID_MISMATCH' };
          store.observeResource(resource.key, metadata.operationStatus ?? metadata.status);
          const status = metadata.operationStatus ?? metadata.status;
          if (status === '4') this.released(resource);
          else if (['COMFY_RESOURCE_STOP_REQUESTED', 'COMFY_RESOURCE_STOPPED'].includes(resource.error_code ?? '')) {
            if (['22', '26'].includes(status)) store.saveResource({ ...resource, state: 'blocked', error_code: 'COMFY_RESOURCE_STOPPED', updated_at: Date.now() });
          } else await this.register(resource, template, metadata);
        }
        catch (error) {
          this.options.assertWorker();
          const stoppedByAdmin = ['COMFY_RESOURCE_STOP_REQUESTED', 'COMFY_RESOURCE_STOPPED'].includes(resource.error_code ?? '');
          store.saveResource({ ...resource, state: stoppedByAdmin || Date.now() - resource.created_at >= (configuration.elastic?.reconcileTimeoutMs ?? 300_000) ? 'blocked' : 'creating',
            updated_at: Date.now(), error_code: stoppedByAdmin ? resource.error_code : safeCode(error) });
          this.lastError = safeCode(error);
        }
      } else if (resource.state === 'creating' && !resource.instance_id) {
        store.saveResource({ ...resource, state: 'uncertain', updated_at: Date.now(), error_code: 'COMFY_CREATION_UNCONFIRMED' });
      } else if (resource.state === 'releasing' && resource.instance_id && platform.pageInstances) {
        if (platform.getInstance) {
          try {
            const metadata = await platform.getInstance(resource.instance_id);
            this.options.assertWorker();
            if (metadata.id === resource.instance_id) {
              store.observeResource(resource.key, metadata.operationStatus ?? metadata.status);
              if ((metadata.operationStatus ?? metadata.status) === '4') { this.released(resource); continue; }
            }
          } catch { this.options.assertWorker(); }
        }
        let confirmed = false;
        for (let current = 1; current <= 5; current++) {
          const page = await platform.pageInstances({ current, pageSize: 20, operationStatus: '4' });
          this.options.assertWorker();
          confirmed = page.records.some(instance => instance.id === resource.instance_id && (instance.operationStatus ?? instance.status) === '4');
          if (confirmed || current * 20 >= page.total || page.records.length < 20) break;
        }
        if (confirmed) {
          store.observeResource(resource.key, '4');
          this.released(resource);
        }
      }
    }
  }

  private async idle(configuration: InstanceConfiguration): Promise<void> {
    const { store, platform } = this.options;
    let instance = store.instance(configuration.id)!;
    if (instance.state === 'closing' || instance.state === 'starting' || instance.state === 'waiting_capacity' || instance.draining) return;
    const policy = schedulerPolicy(this.options.configuration);
    if (store.hasUnresolvedWork(instance.id) || this.compatible(configuration).length) {
      if (instance.idle_since !== null) store.updateInstance(instance.id, { idle_since: null });
      return;
    }
    if (instance.idle_since === null) store.updateInstance(instance.id, { idle_since: Date.now() });
    instance = store.instance(instance.id)!;
    if (Date.now() - instance.idle_since! < policy.idleStopAfterMs) return;
    const warm = this.options.configuration.instances.filter(item => !store.instance(item.id)?.draining
      && ['ready', 'busy', 'starting'].includes(store.instance(item.id)!.state)).sort((left, right) => left.id.localeCompare(right.id)).slice(0, policy.minWarmInstances);
    if (warm.some(item => item.id === instance.id)) return;
    const status = await platform.getInstanceStatus(instance.id);
    this.options.assertWorker();
    if (store.hasUnresolvedWork(instance.id) || this.compatible(configuration).length) return;
    if (['22', '26'].includes(status)) {
      if (instance.stopped_at === null) store.updateInstance(instance.id, { state: 'offline', stopped_at: Date.now(), idle_policy_applied_at: null });
      const stopped = store.instance(instance.id)!;
      const releaseAfter = this.options.configuration.elastic?.releaseAfterMs;
      if (!releaseAfter || Date.now() - stopped.stopped_at! < releaseAfter || !configuration.lifecycle?.allowRelease
        || !configuration.lifecycle.rebuildVerified || !platform.releaseInstance) return;
      let resource = store.resources().find(item => item.instance_id === instance.id);
      if (resource && resource.state !== 'registered') return;
      resource ??= { key: randomUUID(), name: 'registered-' + instance.id, state: 'registered', instance_id: instance.id,
        configuration: JSON.stringify(configuration), template_id: 'registered', hourly_cost: configuration.lifecycle.hourlyCost,
        storage_hourly_cost: configuration.lifecycle.storageHourlyCost, created_at: Date.now(), updated_at: Date.now(), error_code: null };
      store.saveResource({ ...resource, state: 'releasing', updated_at: Date.now(), error_code: null });
      store.updateInstance(instance.id, { draining: 1 });
      try {
        await platform.releaseInstance(instance.id);
        this.options.assertWorker();
        store.saveResource({ ...resource, state: 'releasing', updated_at: Date.now(), error_code: null });
      } catch (error) {
        this.options.assertWorker();
        const rejected = (error as { uncertain?: boolean })?.uncertain === false;
        store.saveResource({ ...resource, state: rejected ? 'registered' : 'releasing', updated_at: Date.now(), error_code: safeCode(error) });
        if (rejected) store.updateInstance(instance.id, { draining: 0, stopped_at: Date.now(), error_code: safeCode(error) });
      }
      return;
    }
    if (status !== '2') return;
    const client = this.options.client(configuration);
    await client.health();
    const queue = await client.queue();
    this.options.assertWorker();
    if (queue.running.length || queue.pending.length || store.hasUnresolvedWork(instance.id) || this.compatible(configuration).length) return;
    store.updateInstance(instance.id, { state: 'closing', action_started_at: Date.now(), action_sent: 1, idle_policy_applied_at: null });
    await platform.closeInstance(instance.id);
  }

  private released(resource: ComfyResource): void {
    this.options.assertWorker();
    if (resource.instance_id && this.options.store.hasUnresolvedWork(resource.instance_id)) throw { code: 'RELEASE_UNRESOLVED_WORK' };
    this.options.store.saveResource({ ...resource, state: 'released', updated_at: Date.now(), error_code: null });
    if (resource.instance_id) {
      this.options.store.updateInstance(resource.instance_id, { state: 'offline', draining: 1, stopped_at: Date.now() });
      this.removeConfiguration(resource.instance_id);
    }
  }
  private removeConfiguration(id: string): void {
    if (this.options.store.hasUnresolvedWork(id)) throw new Error('Cannot release a ComfyUI instance with unresolved work');
    const index = this.options.configuration.instances.findIndex(instance => instance.id === id);
    if (index >= 0) this.options.configuration.instances.splice(index, 1);
  }
  private endpoint(service: AigateInstance['services'][number]): string {
    const url = new URL(service.host.includes('://') ? service.host : 'https://' + service.host);
    this.validateEndpoint(url.toString());
    return url.toString().replace(/\/$/, '');
  }
  private validateEndpoint(value: string): void {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.waas.aigate.cc') || url.port && url.port !== '443'
      || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid managed ComfyUI service URL');
    }
  }
}
