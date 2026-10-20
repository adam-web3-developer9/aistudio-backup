import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { WorkflowProfile } from './workflow.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const binding = z.object({ nodeId: z.string().min(1), input: z.string().min(1), required: z.boolean().optional(), kind: z.enum(['value', 'media', 'output-prefix']).optional(), omitWhenMissing: z.boolean().optional() }).strict();
const configurationSchema = z.object({
  autoOpen: z.boolean().default(false),
  pollIntervalMs: z.number().int().min(1_000).max(60_000).default(5_000),
  bootTimeoutMs: z.number().int().min(30_000).max(3_600_000).default(600_000),
  jobTimeoutMs: z.number().int().min(60_000).max(86_400_000).default(7_200_000),
  capacityPollIntervalMs: z.number().int().min(1_000).max(3_600_000).default(30_000),
  capacityWaitTimeoutMs: z.number().int().min(60_000).max(604_800_000).default(21_600_000),
  capacityErrorCodes: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/)).max(100).default([]),
  instances: z.array(z.object({
    id: z.string().regex(/^\d{1,30}$/), baseUrl: z.url(),
    areaName: z.enum(['华东一区', '华东二区']).optional(),
    gpuModel: z.enum(['5090', '4090']).optional(),
    headersEnv: z.record(z.string(), z.string().regex(/^[A-Z_][A-Z0-9_]*$/)).default({}),
    workflowIds: z.array(identifier).min(1),
  }).strict()).min(1).max(3),
  workflows: z.array(z.object({
    id: identifier, version: z.string().min(1), file: z.string().min(1),
    bindings: z.record(z.string(), binding), outputNodeIds: z.array(z.string().min(1)).min(1),
  }).strict()).min(1),
}).strict();

export interface ComfyPoolConfiguration {
  autoOpen: boolean; pollIntervalMs: number; bootTimeoutMs: number; jobTimeoutMs: number;
  capacityPollIntervalMs?: number; capacityWaitTimeoutMs?: number; capacityErrorCodes?: string[];
  instances: Array<{ id: string; baseUrl: string; areaName?: '华东一区' | '华东二区'; gpuModel?: '5090' | '4090'; headers?: Record<string, string>; workflowIds: string[] }>;
  workflows: WorkflowProfile[];
}

export async function loadComfyConfiguration(file: string, environment = process.env): Promise<ComfyPoolConfiguration> {
  const parsed = configurationSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  if (new Set(parsed.instances.map(instance => instance.id)).size !== parsed.instances.length) throw new Error('Duplicate ComfyUI instance ID');
  if (parsed.instances.length === 3 && (parsed.instances.some(instance => !instance.areaName || !instance.gpuModel)
    || new Set(parsed.instances.map(instance => instance.areaName)).size !== 2)) {
    throw new Error('Three ComfyUI instances require explicit areaName and gpuModel across both areas');
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
      gpuModel: instance.gpuModel ?? '5090' as const };
  });
  return { ...parsed, instances, workflows };
}
