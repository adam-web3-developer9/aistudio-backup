import type { FastifyInstance, FastifyReply } from 'fastify';
import { SystemError } from '../system/types.js';
import { AsrService, asrJobSchema, asrRequestKey } from './service.js';

const jobId = /\/v1\/asr\/jobs\/asr_[0-9a-f-]{36}/.source;
const lookup = /^\/v1\/asr\/jobs\/by-request-key\/[a-zA-Z0-9_-]{1,200}$/;
export function isAsrGatewayRoute(method: string, path: string) {
  return method === 'POST' && (path === '/v1/asr/jobs' || new RegExp(`^${jobId}/inputs$`).test(path)) ||
    method === 'GET' && (new RegExp(`^${jobId}$`).test(path) || lookup.test(path));
}

function replyWith(reply: FastifyReply, run: () => { statusCode: number; body: unknown }) {
  try {
    const response = run();
    return reply.code(response.statusCode).send(response.body);
  } catch (error) {
    if (error instanceof SystemError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    throw error;
  }
}

export function registerAsrRoutes(app: FastifyInstance, service: AsrService) {
  app.post('/v1/asr/jobs', (request, reply) => replyWith(reply, () => {
    const input = asrJobSchema.safeParse(request.body);
    if (!input.success) throw new SystemError(400, 'ASR_REQUEST_INVALID', input.error.issues
      .map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', '));
    const created = service.create(input.data);
    return { statusCode: created.created ? 202 : 200, body: created.job };
  }));
  app.get<{ Params: { key: string } }>('/v1/asr/jobs/by-request-key/:key', (request, reply) => replyWith(reply, () => {
    const key = asrRequestKey.safeParse(request.params.key);
    if (!key.success) throw new SystemError(400, 'ASR_REQUEST_INVALID', 'Invalid request key');
    return { statusCode: 200, body: service.findRequest(key.data) };
  }));
  app.get<{ Params: { id: string } }>('/v1/asr/jobs/:id', (request, reply) => replyWith(reply, () =>
    ({ statusCode: 200, body: service.find(request.params.id) })));
  app.post<{ Params: { id: string } }>('/v1/asr/jobs/:id/inputs', (request, reply) => replyWith(reply, () =>
    ({ statusCode: 200, body: service.confirm(request.params.id) })));
}
