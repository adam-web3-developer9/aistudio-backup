import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { WorkflowProfile } from './workflow.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const durationMs = z.number().int().positive().max(604_800_000);
const imageId = z.string().regex(/^[1-9]\d{0,18}$/).refine(value =>
  value === value.trim() && (value.length < 19 || (value.length === 19 && value <= '9223372036854775807')), 'Image ID must be a canonical positive int64 string');
const schedulerSchema = z.object({
  uploadReservationTimeoutMs: durationMs.default(600_000),
  uploadRetryDelayMs: durationMs.default(60_000),
  maxUploadReservations: z.number().int().positive().default(3),
  idleStopAfterMs: durationMs.default(300_000),
  minWarmInstances: z.number().int().nonnegative().default(0),
  maxConcurrentInstances: z.number().int().positive().max(100).default(6),
  estimatedJobMs: durationMs.default(600_000),
  targetQueueWaitMs: durationMs.default(600_000),
}).strict();
const lifecycleSchema = z.object({
  allowRelease: z.boolean().default(false),
  rebuildVerified: z.boolean().default(false),
  hourlyCost: z.number().nonnegative(),
  storageHourlyCost: z.number().nonnegative(),
}).strict();
const elasticSchema = z.object({
  enabled: z.boolean().default(false),
  maxInstances: z.number().int().positive().max(100).default(6),
  maxHourlyCost: z.number().positive().optional(),
  createCooldownMs: durationMs.default(60_000),
  releaseAfterMs: durationMs.default(3_600_000),
  stoppedRetention: z.object({
    maxInstances: z.number().int().nonnegative().max(100).default(1),
    excessReleaseAfterMs: durationMs.default(60_000),
  }).strict().optional(),
  reconcileTimeoutMs: durationMs.default(300_000),
  templates: z.array(z.object({
    id: identifier,
    areaName: z.enum(['华东一区', '华东二区']),
    gpuModel: z.enum(['5090', '4090']),
    imageId,
    imageType: z.enum(['2', '3']),
    skuName: z.string().min(1).max(100).refine(value => value.trim().length > 0),
    skuPriceToHourlyFactor: z.number().positive(),
    skuPriceUnitVerified: z.boolean(),
    workflowIds: z.array(identifier).min(1),
    hourlyCost: z.number().positive(),
    storageHourlyCost: z.number().nonnegative(),
    rebuildVerified: z.boolean(),
    allowRelease: z.boolean(),
  }).strict()).default([]),
}).strict();
const binding = z.object({ nodeId: z.string().min(1), input: z.string().min(1), required: z.boolean().optional(), kind: z.enum(['value', 'media', 'output-prefix']).optional(), omitWhenMissing: z.boolean().optional() }).strict();
const configurationSchema = z.object({
  autoOpen: z.boolean().default(false),
  pollIntervalMs: z.number().int().min(1_000).max(60_000).default(5_000),
  bootTimeoutMs: z.number().int().min(30_000).max(3_600_000).default(600_000),
  jobTimeoutMs: z.number().int().min(60_000).max(86_400_000).default(7_200_000),
  capacityPollIntervalMs: z.number().int().min(1_000).max(3_600_000).default(30_000),
  capacityWaitTimeoutMs: z.number().int().min(60_000).max(604_800_000).default(21_600_000),
  capacityErrorCodes: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/)).max(100).default([]),
  scheduler: schedulerSchema.prefault({}),
  resultArchive: z.object({
    bucket: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    region: z.string().regex(/^[a-z]{2}(?:-[a-z0-9]+)+$/),
    endpoint: z.string().regex(/^https:\/\/tos-[a-z]{2}(?:-[a-z0-9]+)+\.volces\.com$/),
    keyPrefix: z.string().regex(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/).default('comfy-results'),
    publicReadApproved: z.literal(true),
    gpuExporterVerified: z.literal(true),
  }).strict().optional(),
  elastic: elasticSchema.optional(),
  instances: z.array(z.object({
    id: z.string().regex(/^\d{1,30}$/), baseUrl: z.url(),
    areaName: z.enum(['华东一区', '华东二区']).optional(),
    gpuModel: z.enum(['5090', '4090']).optional(),
    headersEnv: z.record(z.string(), z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default({}),
    workflowIds: z.array(identifier).min(1),
    lifecycle: lifecycleSchema.optional(),
  }).strict()).min(1).max(100),
  workflows: z.array(z.object({
    id: identifier, version: z.string().min(1), file: z.string().min(1),
    bindings: z.record(z.string(), binding), outputNodeIds: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
}).strict();

export type ComfySchedulerConfiguration = z.infer<typeof schedulerSchema>;
export type ComfyElasticConfiguration = z.infer<typeof elasticSchema>;
export type ComfyInstanceLifecycleConfiguration = z.infer<typeof lifecycleSchema>;

export interface ComfyPoolConfiguration {
  autoOpen: boolean; pollIntervalMs: number; bootTimeoutMs: number; jobTimeoutMs: number;
  capacityPollIntervalMs?: number; capacityWaitTimeoutMs?: number; capacityErrorCodes?: string[];
  scheduler?: ComfySchedulerConfiguration;
  elastic?: ComfyElasticConfiguration;
  resultArchive?: z.infer<typeof configurationSchema>['resultArchive'];
  instances: Array<{ id: string; baseUrl: string; areaName?: '华东一区' | '华东二区'; gpuModel?: '5090' | '4090'; headers?: Record<string, string>; workflowIds: string[]; lifecycle?: ComfyInstanceLifecycleConfiguration }>;
  workflows: WorkflowProfile[];
}

export async function loadComfyConfiguration(file: string, environment = process.env): Promise<ComfyPoolConfiguration> {
  const parsed = configurationSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (new Set(parsed.instances.map(instance => instance.id)).size !== parsed.instances.length) throw new Error('Duplicate ComfyUI instance ID');
  if (parsed.scheduler.minWarmInstances > parsed.scheduler.maxConcurrentInstances) throw new Error('Scheduler minWarmInstances must not exceed maxConcurrentInstances');
  if (parsed.instances.some(instance => instance.lifecycle?.allowRelease && !instance.lifecycle.rebuildVerified)) {
    throw new Error('Instance allowRelease requires rebuildVerified');
  }
  const elastic = parsed.elastic;
  if (parsed.resultArchive && parsed.resultArchive.endpoint !== `https://tos-${parsed.resultArchive.region}.volces.com`) {
    throw new Error('Result archive endpoint must match its region');
  }
  if (elastic) {
    if (new Set(elastic.templates.map(template => template.id)).size !== elastic.templates.length) throw new Error('Duplicate ComfyUI elastic template ID');
    if (elastic.templates.some(template => template.workflowIds.some(id => !parsed.workflows.some(profile => profile.id === id)))) {
      throw new Error('Elastic template references an unknown workflow');
    }
    if (elastic.templates.some(template => template.allowRelease && !template.rebuildVerified)) throw new Error('Template allowRelease requires rebuildVerified');
    if (elastic.releaseAfterMs < parsed.scheduler.idleStopAfterMs) throw new Error('Elastic releaseAfterMs must cover scheduler idleStopAfterMs');
    if (elastic.stoppedRetention && elastic.stoppedRetention.excessReleaseAfterMs > elastic.releaseAfterMs) {
      throw new Error('Elastic excessReleaseAfterMs must not exceed releaseAfterMs');
    }
    if (elastic.enabled) {
      if (!elastic.maxHourlyCost) throw new Error('Enabled elastic configuration requires an explicit maxHourlyCost budget');
      if (!elastic.templates.length) throw new Error('Enabled elastic configuration requires templates');
      if (elastic.templates.some(template => template.skuPriceUnitVerified !== true)) throw new Error('Enabled elastic configuration requires skuPriceUnitVerified for every template');
      if (parsed.scheduler.maxConcurrentInstances > elastic.maxInstances) throw new Error('Scheduler maxConcurrentInstances must not exceed elastic maxInstances');
      if (parsed.instances.length > elastic.maxInstances) throw new Error('Existing ComfyUI instances exceed elastic maxInstances');
    }
  }
  if (parsed.capacityWaitTimeoutMs < parsed.capacityPollIntervalMs) throw new Error('Capacity wait timeout must cover the polling interval');
  if (new Set(parsed.workflows.map(profile => profile.id)).size !== parsed.workflows.length) throw new Error('Duplicate ComfyUI workflow ID');
  const workflows = await Promise.all(parsed.workflows.map(async profile => ({
    id: profile.id, version: profile.version, bindings: profile.bindings, outputNodeIds: profile.outputNodeIds,
    graph: JSON.parse(await readFile(path.resolve(path.dirname(file), profile.file), 'utf8')) as Record<string, unknown>,
  })));
  const instances = parsed.instances.map((instance, index) => {
    const url = new URL(instance.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid trusted ComfyUI service URL');
    if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Remote ComfyUI services require HTTPS');
    if (instance.workflowIds.some(id => !workflows.some(profile => profile.id === id))) throw new Error('Instance references an unknown workflow');
    const headers = Object.fromEntries(Object.entries(instance.headersEnv).map(([name, env]) => {
      const value = environment[env];
      if (!value || /[\r\n]/.test(value) || !/^[A-Za-z0-9-]+$/.test(name)) throw new Error('ComfyUI instance authentication is not configured');
      return [name, value];
    }));
    return { id: instance.id, baseUrl: url.toString().replace(/\/$/, ''), headers, workflowIds: instance.workflowIds,
      areaName: instance.areaName ?? (index % 2 === 0 ? '华东一区' as const : '华东二区' as const),
      gpuModel: instance.gpuModel ?? '5090' as const, ...(instance.lifecycle ? { lifecycle: instance.lifecycle } : {}) };
  });
  return { ...parsed, instances, workflows };
}
