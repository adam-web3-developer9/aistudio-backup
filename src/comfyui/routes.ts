import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SystemRuntime } from '../system/index.js';
import type { ComfyService } from './service.js';

export const comfyJobSchema = z.object({
  adapterId: z.literal('comfyui-v1'), requestKey: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/),
  workflowId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean()])),
  media: z.record(z.string(), z.string().regex(/^asset_[A-Za-z0-9_-]+$/)).default({}),
  transport: z.literal('direct').optional(),
  directMedia: z.record(z.string(), z.object({
    filename: z.string().regex(/^[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp|wav|mp3)$/i).max(200),
    contentType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'audio/mpeg', 'audio/wav']),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).optional(),
}).strict();

export const comfyInputsSchema = z.object({
  inputs: z.record(z.string(), z.object({ name: z.string().min(1).max(200), subfolder: z.string().min(1).max(250), type: z.literal('input') }).strict()),
}).strict();

export const comfyEventQuerySchema = z.object({ after: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict();

export function registerComfyAdminRoutes(app: FastifyInstance, runtime: SystemRuntime, service: ComfyService): void {
  app.get('/api/admin/comfyui/instances/:id/events', async (request, reply) => {
    await runtime.requireAdmin(request);
    const id = (request.params as { id: string }).id;
    if (!service.options.configuration.instances.some(instance => instance.id === id)) return reply.code(404).send({ code: 'COMFY_INSTANCE_UNKNOWN' });
    const parsed = comfyEventQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ code: 'INVALID_INPUT' });
    const events = service.store.events.list({ instanceId: id, ...parsed.data });
    return { events, nextAfter: events.at(-1)?.sequence ?? parsed.data.after };
  });
  app.get('/api/admin/comfyui', async request => {
    await runtime.requireAdmin(request);
    const registered = new Set(service.options.configuration.instances.map(instance => instance.id));
    return {
      autoOpen: service.options.configuration.autoOpen,
      scheduler: service.options.configuration.scheduler,
      elastic: { enabled: service.options.configuration.elastic?.enabled ?? false,
        maxInstances: service.options.configuration.elastic?.maxInstances,
        maxHourlyCost: service.options.configuration.elastic?.maxHourlyCost,
        lastError: service.lifecycle.lastError },
      metrics: service.metrics(),
      resources: service.store.resources().map(resource => {
        const observation = service.store.resourceObservations().find(item => item.resource_key === resource.key);
        return { key: resource.key, state: resource.state, instanceId: resource.instance_id,
          templateId: resource.template_id, errorCode: resource.error_code, createdAt: resource.created_at, updatedAt: resource.updated_at,
          platformStatus: observation?.status, observedAt: observation?.observed_at };
      }),
      instances: service.store.instances().filter(instance => registered.has(instance.id)).map(instance => ({
        id: instance.id, state: instance.state, draining: !!instance.draining, jobId: instance.job_id,
        errorCode: instance.error_code, pendingResults: service.store.pendingResults(instance.id).length,
        areaName: service.options.configuration.instances.find(configuration => configuration.id === instance.id)?.areaName,
        gpuModel: service.options.configuration.instances.find(configuration => configuration.id === instance.id)?.gpuModel,
        nextActionAt: instance.next_action_at,
        idleSince: instance.idle_since, stoppedAt: instance.stopped_at,
      })),
      queued: service.store.queued().length,
      workflows: service.options.configuration.workflows.map(profile => ({
        id: profile.id, version: profile.version,
        bindings: Object.entries(profile.bindings).map(([name, binding]) => ({ name, kind: binding.kind ?? 'value', required: binding.kind === 'media' && !binding.omitWhenMissing || binding.required === true })),
      })),
    };
  });
  app.post('/api/admin/comfyui/resources/:key/inspect', async (request, reply) => {
    const principal = await runtime.requireAdmin(request, 'authorize');
    const params = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_INPUT' });
    const key = params.data.key;
    if (!service.store.resource(key)) return reply.code(404).send({ code: 'COMFY_RESOURCE_UNKNOWN' });
    runtime.store.audit({ actorId: principal.id, action: 'comfyui.resource.inspect', targetType: 'comfyResource', targetId: key });
    await service.inspectResource(key);
    return reply.code(202).send({ resourceKey: key, accepted: true });
  });
  app.post('/api/admin/comfyui/resources/:key/stop-unregistered', async (request, reply) => {
    const principal = await runtime.requireAdmin(request, 'authorize');
    const params = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/) }).safeParse(request.params);
    const body = z.object({ confirmNoExternalWork: z.literal(true) }).strict().safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ code: 'INVALID_INPUT' });
    const key = params.data.key;
    if (!service.store.resource(key)) return reply.code(404).send({ code: 'COMFY_RESOURCE_UNKNOWN' });
    runtime.store.audit({ actorId: principal.id, action: 'comfyui.resource.stopUnregistered', targetType: 'comfyResource', targetId: key });
    await service.stopUnregisteredResource(key);
    return reply.code(202).send({ resourceKey: key, accepted: true });
  });
  app.post('/api/admin/comfyui/instances/:id/:action', async (request, reply) => {
    const principal = await runtime.requireAdmin(request, 'authorize');
    const params = z.object({ id: z.string().regex(/^\d{1,30}$/), action: z.enum(['open', 'close', 'drain']) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ code: 'INVALID_INPUT', message: 'Invalid pool action' });
    const { id, action } = params.data;
    runtime.db.transaction(() => {
      runtime.store.audit({ actorId: principal.id, action: `comfyui.instance.${action}`, targetType: 'comfyInstance', targetId: id });
      service.control(id, action);
    })();
    return reply.code(202).send({ instanceId: id, action, accepted: true });
  });
}
