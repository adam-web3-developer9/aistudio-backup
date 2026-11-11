import { randomUUID } from 'node:crypto';
import type { AigateClient, AigateInstance } from './aigate-client.js';
import type { ComfyPoolConfiguration } from './configuration.js';
import type { ComfyClient } from './comfy-client.js';
import type { ComfyJob, ComfyResource, ComfyStore, FrozenComfyInput } from './store.js';
import { schedulerPolicy } from './scheduler.js';

type InstanceConfiguration = ComfyPoolConfiguration['instances'][number];
type ElasticTemplate = NonNullable<ComfyPoolConfiguration['elastic']>['templates'][number];
export type ComfyLifecyclePlatform = Pick<AigateClient, 'getInstanceStatus' | 'closeInstance'> &
  Partial<Pick<AigateClient, 'getInstance' | 'skuList' | 'createInstance' | 'releaseInstance' | 'pageInstances' | 'findInstancesByName' | 'listImages' | 'getImage'>>;

function safeCode(error: unknown): string {
  const value = (error as { code?: unknown })?.code;
  return typeof value === 'string' && /^[A-Z_]{1,80}$/.test(value) ? 'COMFY_' + value : 'COMFY_LIFECYCLE_FAILED';
}

// 实际租到的机型由可用 SKU 决定；保留 SKU 前缀与去掉 DDR 后缀的别名，供原生 GPU 名称校验使用。
const SKU_MODELS = ['5090', '4090', '6000D', '3090', 'A10G'];
export function skuModelAliases(skuName: string): string[] {
  const token = skuName.split('-')[0] ?? '';
  const family = SKU_MODELS.find(model => new RegExp(`(?:^|[^A-Za-z0-9])${model}(?:$|[^A-Za-z0-9])`, 'i').test(skuName))
    ?? (/^[45]090D$/i.test(token) ? token : undefined) ?? token;
  const aliases = [family];
  if (/^[45]090D$/i.test(family)) aliases.push(family.slice(0, 4));
  return [...new Set(aliases.filter(Boolean))];
}

function templateSkus(template: ElasticTemplate): string[] {
  return template.skuNames ?? (template.skuName === undefined ? [] : [template.skuName]);
}

export class ComfyLifecycle {
  private active?: Promise<void>;
  private managing = false;
  private readonly images = new Map<string, { at: number; image?: { id: string; type: '2' | '3' } }>();
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
    const retained = this.retainedStoppedInstances();
    await Promise.all([...this.options.configuration.instances].map(async instance => {
      try { await this.idle(instance, retained); }
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
  private needsCapacity(template: ElasticTemplate): boolean {
    const { configuration, store } = this.options;
    const policy = schedulerPolicy(configuration);
    const demand = this.compatible({ workflowIds: template.workflowIds }).length;
    if (!demand) return false;
    const supported = configuration.instances.filter(instance => !store.instance(instance.id)?.draining
      && instance.workflowIds.some(id => template.workflowIds.includes(id)));
    const busy = supported.filter(instance => store.instance(instance.id)?.job_id).length;
    const desired = Math.min(policy.maxConcurrentInstances,
      busy + Math.min(demand, Math.ceil(demand * policy.estimatedJobMs / policy.targetQueueWaitMs)));
    // Unknown creations consume count/budget reservations, but are not usable
    // capacity. Even a single queued job may need another confirmed instance.
    return supported.length < desired;
  }

  private unregisteredResources(): ComfyResource[] {
    return this.options.store.resources().filter(resource => resource.state !== 'released'
      && !this.options.configuration.instances.some(instance => instance.id === resource.instance_id));
  }

  private async scale(): Promise<void> {
    const { configuration, store, platform } = this.options;
    const elastic = configuration.elastic;
    if (!configuration.autoOpen || !elastic?.enabled) return;
    if (!platform.skuList || !platform.createInstance || !platform.getInstance) { this.lastError = 'COMFY_ELASTIC_API_UNAVAILABLE'; return; }
    if (elastic.templates.some(template => template.imageName !== undefined) && !platform.listImages) {
      this.lastError = 'COMFY_IMAGE_DISCOVERY_UNAVAILABLE'; return;
    }
    const resources = store.resources();
    if (resources.some(resource => ['creating', 'blocked', 'releasing'].includes(resource.state))) {
      this.lastError = 'COMFY_RESOURCE_RECONCILIATION_REQUIRED'; return;
    }
    const policy = schedulerPolicy(configuration);
    const lastCreated = Math.max(0, ...resources.map(resource => resource.created_at));
    if (Date.now() - lastCreated < elastic.createCooldownMs) return;
    const reservedInstances = configuration.instances.length + this.unregisteredResources().length;
    if (reservedInstances >= elastic.maxInstances || reservedInstances >= policy.maxConcurrentInstances) return;
    const templates = [...elastic.templates].sort((left, right) => (left.gpuModel === '4090' ? 1 : 0) - (right.gpuModel === '4090' ? 1 : 0)
      || (left.hourlyCost ?? Number.POSITIVE_INFINITY) - (right.hourlyCost ?? Number.POSITIVE_INFINITY));
    for (const template of templates) {
      if (!template.skuPriceUnitVerified || !Number.isFinite(template.skuPriceToHourlyFactor) || template.skuPriceToHourlyFactor <= 0) {
        this.lastError = 'COMFY_SKU_PRICE_UNIT_UNVERIFIED'; continue;
      }
      if (!this.needsCapacity(template)) continue;
      const skus = await platform.skuList(template.areaName);
      this.options.assertWorker();
      // 白名单顺序即优先级；平台只返回当前有货的 SKU，售罄的自动跳过而不是判任务失败。
      const available = templateSkus(template)
        .map(name => skus.find(item => item.areaName === template.areaName && item.skuName === name))
        .filter((sku): sku is NonNullable<typeof sku> => !!sku && /^\d+(?:\.\d+)?$/.test(sku.price)
          && Number.isFinite(Number(sku.price) * template.skuPriceToHourlyFactor));
      if (!available.length) { this.lastError = 'COMFY_SKU_QUOTE_UNVERIFIED'; continue; }
      if (!this.needsCapacity(template)) continue;
      // 逐个型号解析镜像：某个型号没上架该镜像时继续试白名单里的下一个，而不是直接放弃这台模板。
      let selected: { sku: (typeof available)[number]; image: { id: string; type: '2' | '3' } } | undefined;
      for (const sku of available) {
        const image = await this.resolveImage(template, sku.skuName);
        this.options.assertWorker();
        if (image) { selected = { sku, image }; break; }
      }
      if (!selected) { this.lastError = 'COMFY_IMAGE_UNAVAILABLE'; continue; }
      const { sku, image } = selected;
      const key = randomUUID();
      const resource: ComfyResource = { key, name: 'hailuo-' + key, state: 'creating', instance_id: null, configuration: null,
        template_id: template.id, hourly_cost: Number(sku.price) * template.skuPriceToHourlyFactor, storage_hourly_cost: template.storageHourlyCost,
        created_at: Date.now(), updated_at: Date.now(), error_code: null,
        image_id: image.id, image_type: image.type, sku_name: sku.skuName, area_name: template.areaName };
      store.saveResource(resource);
      try {
        const id = await platform.createInstance({ areaName: template.areaName, count: 1, skuName: sku.skuName,
          imageId: image.id, imageType: image.type });
        this.options.assertWorker();
        resource.instance_id = id;
        store.saveResource({ ...resource, updated_at: Date.now() });
        await this.register(resource, template);
        this.lastError = null;
        return;
      } catch (error) {
        this.options.assertWorker();
        const confirmed = !resource.instance_id && (error as { uncertain?: boolean })?.uncertain === false;
        const capacityUnavailable = confirmed && (error as { code?: string })?.code === 'CAPACITY_UNAVAILABLE';
        const rejectedRequest = confirmed && (error as { code?: string })?.code === 'BUSINESS_REJECTED';
        const reason = (error as { reason?: string })?.reason;
        // 镜像刚被删除/替换：清掉缓存，下一个模板或下一轮自动重新解析，不把任务判死。
        const imageUnavailable = rejectedRequest && reason === 'IMAGE_UNAVAILABLE';
        if (rejectedRequest) this.invalidateImages();
        const errorCode = imageUnavailable ? 'COMFY_IMAGE_UNAVAILABLE'
          : rejectedRequest ? (reason === 'INSUFFICIENT_BALANCE' ? 'COMFY_INSUFFICIENT_BALANCE' : 'COMFY_INSTANCE_CREATE_REJECTED') : safeCode(error);
        store.saveResource({ ...resource, state: resource.instance_id ? 'creating' : confirmed ? 'released' : 'uncertain',
          updated_at: Date.now(), error_code: errorCode });
        this.lastError = resource.instance_id ? 'COMFY_RESOURCE_INITIALIZING'
          : capacityUnavailable ? 'COMFY_CAPACITY_UNAVAILABLE' : confirmed ? errorCode : 'COMFY_CREATION_UNCONFIRMED';
        if (reason === 'INSUFFICIENT_BALANCE' || (rejectedRequest && !imageUnavailable)) {
          // 明确的账户/业务拒绝立即结束相关排队任务（保持原有“暴露拒绝原因”语义）。
          this.failTemplateJobs(template, errorCode);
          return;
        }
        // 明确缺卡或镜像刚被删除/替换：继续尝试下一个模板或下一轮自动重新解析，不把任务判死。
        if (capacityUnavailable || imageUnavailable) continue;
      }
      return;
    }
  }

  private failTemplateJobs(template: ElasticTemplate, errorCode: string): void {
    const { configuration, store } = this.options;
    for (const job of this.compatible(template)) {
      const workflowId = (JSON.parse(job.input) as FrozenComfyInput).workflowId;
      const available = configuration.instances.some(candidate => candidate.workflowIds.includes(workflowId)
        && !store.instance(candidate.id)?.draining && ['ready', 'busy', 'starting'].includes(store.instance(candidate.id)!.state));
      if (!available) store.failUnsubmitted(job.id, errorCode, { areaName: template.areaName, gpuModel: template.gpuModel });
    }
  }

  private imageRefreshMs(): number {
    return this.options.configuration.elastic?.imageRefreshMs ?? 300_000;
  }

  private invalidateImages(): void {
    // 平台拒绝或回执显示镜像失效时，整表作废；下一轮重新解析最新可用版本。
    this.images.clear();
  }

  private async resolveImage(template: ElasticTemplate, skuName: string): Promise<{ id: string; type: '2' | '3' } | undefined> {
    const { platform } = this.options;
    const cacheKey = template.imageName === undefined
      ? 'id:' + template.imageId + '|' + template.imageType
      : ['name', template.areaName, skuName, template.imageName, template.imageVersion ?? '', template.imageType].join('|');
    const cached = this.images.get(cacheKey);
    if (cached && Date.now() - cached.at < this.imageRefreshMs()) return cached.image;
    try {
      const image = template.imageName === undefined
        ? await this.verifyPinnedImage(template)
        : await this.discoverImage(template, skuName);
      this.images.set(cacheKey, { at: Date.now(), image });
      return image;
    } catch (error) {
      // 读不到镜像列表时保留上一次结果；没有缓存则让本轮扩容先跳过，避免用过期 ID 反复撞拒绝。
      if (cached?.image) return cached.image;
      throw error;
    }
  }

  private async verifyPinnedImage(template: ElasticTemplate): Promise<{ id: string; type: '2' | '3' } | undefined> {
    const id = template.imageId!;
    if (!this.options.platform.getImage) return { id, type: template.imageType };
    const image = await this.options.platform.getImage(id, template.imageType);
    if (!image || image.status !== '1') return undefined;
    if (image.areaName !== undefined && image.areaName !== template.areaName) return undefined;
    return { id, type: template.imageType };
  }

  private async discoverImage(template: ElasticTemplate, skuName: string): Promise<{ id: string; type: '2' | '3' } | undefined> {
    const images = await this.options.platform.listImages!({ imageType: template.imageType, imageName: template.imageName!,
      areaName: template.areaName, skuName, ...(template.imageVersion === undefined ? {} : { imageVersion: template.imageVersion }), maxPages: 5 });
    const matched = images.filter(image => image.name === template.imageName && image.status === '1'
      && (image.imageType === undefined || image.imageType === template.imageType)
      && (image.areaName === undefined || image.areaName === template.areaName)
      && (image.imageVersion === undefined || template.imageVersion === undefined || image.imageVersion === template.imageVersion)
      && image.comfyPort !== false);
    if (!matched.length) return undefined;
    const newest = matched.reduce((left, right) => BigInt(right.id) > BigInt(left.id) ? right : left);
    return { id: newest.id, type: template.imageType };
  }

  private async register(resource: ComfyResource, template: ElasticTemplate, observed?: AigateInstance): Promise<void> {
    const metadata = observed ?? await this.options.platform.getInstance!(resource.instance_id!);
    this.options.assertWorker();
    if (metadata.id !== resource.instance_id) throw { code: 'RESOURCE_ID_MISMATCH' };
    this.options.store.observeResource(resource.key, metadata.operationStatus ?? metadata.status);
    const expectedImageId = resource.image_id ?? template.imageId;
    const expectedImageType = resource.image_type ?? template.imageType;
    const expectedArea = resource.area_name ?? template.areaName;
    const areaName = expectedArea === '华东一区' || expectedArea === '华东二区' ? expectedArea : undefined;
    if (metadata.id !== resource.instance_id || metadata.areaName !== expectedArea || !areaName
      || (expectedImageId !== undefined && expectedImageId !== null && metadata.imageId !== expectedImageId)
      || (expectedImageType !== undefined && expectedImageType !== null && metadata.imageType !== expectedImageType)
      || metadata.count !== 1) throw { code: 'ELASTIC_METADATA_UNVERIFIED' };
    const candidates = metadata.services.filter(item => /^(?:https?)$/i.test(item.protocol ?? '') && item.httpType === '1' && item.port === 8188);
    const service = candidates.length === 1 ? candidates[0] : undefined;
    if (!service) throw { code: 'ELASTIC_ENDPOINT_PENDING' };
    const baseUrl = this.endpoint(service);
    const skuName = resource.sku_name ?? template.skuName ?? templateSkus(template)[0];
    const models = skuName ? skuModelAliases(skuName) : (template.gpuModel ? [template.gpuModel] : []);
    const configuration: InstanceConfiguration = { id: metadata.id, baseUrl, areaName,
      ...(models.length ? { gpuModel: models[0], ...(models.length > 1 ? { gpuModels: models } : {}) }
        : template.gpuModel ? { gpuModel: template.gpuModel } : {}),
      workflowIds: template.workflowIds, headers: {}, lifecycle: { allowRelease: template.allowRelease, rebuildVerified: template.rebuildVerified,
        hourlyCost: resource.hourly_cost, storageHourlyCost: resource.storage_hourly_cost } };
    if (this.options.configuration.instances.some(instance => instance.id === metadata.id)) throw { code: 'ELASTIC_INSTANCE_COLLISION' };
    this.options.store.saveResource({ ...resource, state: 'registered', configuration: JSON.stringify(configuration), updated_at: Date.now(), error_code: null });
    this.options.store.registerInstances([metadata.id]);
    if (['2', '8', '9', '13'].includes(metadata.operationStatus ?? metadata.status)) {
      this.options.store.updateInstance(metadata.id, { state: 'starting', action_started_at: Date.now(), action_sent: 1,
        stopped_at: null, idle_since: null, error_code: 'COMFY_INSTANCE_INITIALIZING' });
    }
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
      } else if (resource.state === 'uncertain' && !resource.instance_id) {
        // start has no client idempotency key or custom instance name. An empty
        // name lookup cannot prove that this request did not create an instance.
        this.lastError = 'COMFY_CREATION_UNCONFIRMED';
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

  private retainedStoppedInstances(): Set<string> {
    const { configuration, store } = this.options;
    const elastic = configuration.elastic;
    if (!elastic?.stoppedRetention) return new Set();
    const resources = store.resources();
    const candidates = configuration.instances.filter(item => {
      const instance = store.instance(item.id);
      const resource = resources.find(resource => resource.instance_id === item.id);
      return item.lifecycle?.allowRelease && item.lifecycle.rebuildVerified
        && instance?.state === 'offline' && !instance.draining && instance.stopped_at !== null
        && Date.now() - instance.stopped_at < elastic.releaseAfterMs
        && !store.hasUnresolvedWork(item.id) && !this.compatible(item).length
        && (!resource || resource.state === 'registered');
    });
    candidates.sort((left, right) => store.instance(right.id)!.stopped_at! - store.instance(left.id)!.stopped_at!
      || left.id.localeCompare(right.id));
    return new Set(candidates.slice(0, elastic.stoppedRetention.maxInstances).map(instance => instance.id));
  }

  private async idle(configuration: InstanceConfiguration, retained: Set<string>): Promise<void> {
    const { store, platform } = this.options;
    if (await this.retireFailedWork(configuration)) return;
    let instance = store.instance(configuration.id)!;
    if (instance.state === 'closing' || instance.state === 'starting' || instance.state === 'waiting_capacity' || instance.draining) return;
    if (store.terminalSlot(instance.id)) {
      const status = await platform.getInstanceStatus(instance.id);
      this.options.assertWorker();
      if (status === '22' || status === '26') {
        // Recompute the existing stopped-retention tier on the next tick after releasing this slot.
        if (store.settleStoppedSlot(instance.id)) return;
      }
    }
    const policy = schedulerPolicy(this.options.configuration);
    if (store.hasComputeWork(instance.id) || this.compatible(configuration).length) {
      if (instance.idle_since !== null) store.updateInstance(instance.id, { idle_since: null });
      return;
    }
    if (instance.idle_since === null) store.updateInstance(instance.id, { idle_since: Date.now() });
    instance = store.instance(instance.id)!;
    if (!(this.options.configuration.elastic?.stoppedRetention && instance.state === 'offline' && instance.stopped_at !== null)
      && Date.now() - instance.idle_since! < policy.idleStopAfterMs) return;
    const warm = this.options.configuration.instances.filter(item => !store.instance(item.id)?.draining
      && ['ready', 'busy', 'starting'].includes(store.instance(item.id)!.state)).sort((left, right) => left.id.localeCompare(right.id)).slice(0, policy.minWarmInstances);
    if (warm.some(item => item.id === instance.id)) return;
    const status = await platform.getInstanceStatus(instance.id);
    this.options.assertWorker();
    if (store.hasComputeWork(instance.id) || this.compatible(configuration).length) return;
    if (['22', '26'].includes(status)) {
      if (instance.stopped_at === null) store.updateInstance(instance.id, { state: 'offline', stopped_at: Date.now(), idle_policy_applied_at: null });
      // A terminal execution may stop consuming GPU while its original disk and IDs remain recoverable.
      if (store.hasUnresolvedWork(instance.id)) return;
      const stopped = store.instance(instance.id)!;
      const elastic = this.options.configuration.elastic;
      const releaseAfter = elastic?.stoppedRetention && !retained.has(instance.id)
        ? elastic.stoppedRetention.excessReleaseAfterMs : elastic?.releaseAfterMs;
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
    if (status !== '2' || Date.now() - instance.idle_since! < policy.idleStopAfterMs) return;
    const client = this.options.client(configuration);
    await client.health();
    const queue = await client.queue();
    this.options.assertWorker();
    if (queue.running.length || queue.pending.length || store.hasComputeWork(instance.id) || this.compatible(configuration).length) return;
    store.updateInstance(instance.id, { state: 'closing', action_started_at: Date.now(), action_sent: 1, idle_policy_applied_at: null });
    await platform.closeInstance(instance.id);
  }

  private async retireFailedWork(configuration: InstanceConfiguration): Promise<boolean> {
    const { store, platform } = this.options;
    if (!configuration.lifecycle?.allowRelease || !configuration.lifecycle.rebuildVerified || !platform.releaseInstance) return false;
    const id = configuration.id;
    const failed = (job: ComfyJob) => ['failed', 'cancelled'].includes(job.stage)
      && ['COMFY_REMOTE_UNCONFIRMED', 'COMFY_EXECUTION_CLOSED', 'COMFY_ARCHIVE_TRANSFER_FAILED'].includes(job.error_code ?? '');
    const interrupted = (job: ComfyJob) => ['queued', 'submitting', 'running'].includes(job.stage)
      && (!!job.provider_confirmed || (job.native_checkpoint
        ? (JSON.parse(job.native_checkpoint) as { attempts: unknown[] }).attempts.length > 0 : false));
    if (!store.instanceJobs(id).some(job => failed(job) || interrupted(job))) return false;
    const status = await platform.getInstanceStatus(id);
    this.options.assertWorker();
    const stopped = status === '22' || status === '26';
    const jobs = store.instanceJobs(id);
    if (!jobs.some(job => failed(job) || stopped && interrupted(job))) return false;
    store.db.transaction(() => {
      // A stopped GPU cannot retain an in-memory execution. End it instead of paying to reopen it.
      for (const job of jobs.filter(job => failed(job) || stopped && interrupted(job))) {
        if (job.error_code !== 'COMFY_ARCHIVE_TRANSFER_FAILED') {
          store.updateJob(job.id, { stage: job.cancel_requested ? 'cancelled' : 'failed', error_code: 'COMFY_EXECUTION_CLOSED',
            result_pending: 0, result_wake_requested: 0 });
        }
        if (store.instance(id)?.job_id === job.id) store.updateInstance(id, { job_id: null });
      }
      // Stop new claims and wakeups while any unrelated current work finishes.
      store.updateInstance(id, { draining: 1 });
    })();
    if (store.hasUnresolvedWork(id)) return true;
    let resource = store.resources().find(item => item.instance_id === id);
    if (resource && resource.state !== 'registered') return true;
    if (status === '2') {
      const instance = store.instance(id)!;
      if (instance.state === 'closing' && instance.action_sent) return true;
      let queue: Awaited<ReturnType<ComfyClient['queue']>> | undefined;
      try { queue = await this.options.client(configuration).queue(); }
      catch { this.options.assertWorker(); } // An unreachable failed GPU must not retain paid compute forever.
      this.options.assertWorker();
      const ownPrompts = new Set(jobs.filter(failed).flatMap(job => {
        const checkpoint = job.native_checkpoint ? JSON.parse(job.native_checkpoint) as { attempts: Array<{ plannedId: string; promptId?: string }> } : undefined;
        return [job.prompt_id, ...(checkpoint?.attempts.flatMap(attempt => [attempt.plannedId, attempt.promptId ?? '']) ?? [])];
      }));
      if (queue && [...queue.running, ...queue.pending].some(item => !ownPrompts.has(item.promptId))) {
        store.updateInstance(id, { error_code: 'COMFY_EXTERNAL_OCCUPANCY' });
        return true;
      }
      if (store.hasUnresolvedWork(id)) return true;
      store.updateInstance(id, { state: 'closing', action_started_at: Date.now(), action_sent: 1, idle_policy_applied_at: null });
      await platform.closeInstance(id);
      this.options.assertWorker();
      return true;
    }
    if (!stopped) return true;
    // Failure disposal bypasses warm retention and ordinary idle/release timers.
    resource ??= { key: randomUUID(), name: 'registered-' + id, state: 'registered', instance_id: id,
      configuration: JSON.stringify(configuration), template_id: 'registered', hourly_cost: configuration.lifecycle.hourlyCost,
      storage_hourly_cost: configuration.lifecycle.storageHourlyCost, created_at: Date.now(), updated_at: Date.now(), error_code: null };
    store.updateInstance(id, { state: 'offline', stopped_at: store.instance(id)!.stopped_at ?? Date.now(),
      action_started_at: null, action_sent: 0, next_action_at: null });
    store.saveResource({ ...resource, state: 'releasing', updated_at: Date.now(), error_code: null });
    try {
      await platform.releaseInstance(id);
      this.options.assertWorker();
    } catch (error) {
      this.options.assertWorker();
      const rejected = (error as { uncertain?: boolean })?.uncertain === false;
      store.saveResource({ ...resource, state: rejected ? 'registered' : 'releasing', updated_at: Date.now(), error_code: safeCode(error) });
    }
    return true;
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
