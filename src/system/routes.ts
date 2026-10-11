import type { FastifyInstance, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { z } from 'zod';
import type { SystemRuntime } from './runtime.js';
import { adminRoles, SystemError, type SystemPrincipal } from './types.js';
import { registerAccountPages } from './account-pages.js';
import { projectAuthHttpResponse } from './auth-response.js';

const listSchema = z.object({ page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20), q: z.string().max(200).optional(),
  sharingEligible: z.enum(['true', 'false']).optional() });
const idSchema = z.object({ id: z.string().min(1).max(200) });
const updateUserSchema = z.object({ disabled: z.boolean().optional(), sharingEligible: z.boolean().optional() }).strict()
  .refine(value => Object.keys(value).length > 0, 'At least one change is required');
const createCodesSchema = z.object({ count: z.number().int().min(1).max(100).default(1),
  validityDays: z.number().int().min(1).max(3650).default(365),
  redeemBefore: z.iso.datetime({ offset: true }).nullable().default(null), note: z.string().max(500).default('') }).strict();
const adminSchema = z.object({ role: z.enum(adminRoles) }).strict();
const redeemSchema = z.object({ code: z.string().trim().min(10).max(200) }).strict();

/** Strip internal session IDs and privilege aliases from the client identity contract. */
function safeIdentity(identity: SystemPrincipal) {
  const { sessionId: _sessionId, sharingEligible: _sharingEligible, adminRole: _adminRole, ...safe } = identity;
  return safe;
}

export interface RegisterSystemRoutesOptions { runtime: SystemRuntime; closeRuntime?: boolean }

export async function registerSystemRoutes(app: FastifyInstance, options: RegisterSystemRoutesOptions): Promise<void> {
  const runtime = options.runtime;
  if (options.closeRuntime !== false) app.addHook('onClose', async () => runtime.close());
  await app.register(async routes => {
    routes.addHook('onRoute', route => { route.bodyLimit = 16_384; });
    registerAccountPages(routes);
    routes.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
      if (error instanceof SystemError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
      if (error instanceof z.ZodError) return reply.code(400).send({ code: 'VALIDATION_ERROR', message: 'Invalid request', errors: error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
      if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ code: 'INVALID_REQUEST', message: 'Invalid request' });
      request.log.error({ err: error }, 'System request failed');
      return reply.code(500).send({ code: 'SYSTEM_FAILURE', message: 'System request failed' });
    });
    routes.addHook('onRequest', async (request, reply) => {
      // Cookie-authenticated custom routes need the same origin protection as Better Auth.
      runtime.assertRequestOrigin(request);
      const origin = request.headers.origin;
      if (origin) {
        reply.header('access-control-allow-origin', origin).header('vary', 'Origin')
          .header('access-control-allow-credentials', 'true');
      }
      reply.header('cache-control', 'no-store');
    });
    const optionsHandler = async (_request: FastifyRequest, reply: import('fastify').FastifyReply) => reply
      .header('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS')
      .header('access-control-allow-headers', 'Content-Type').code(204).send();
    for (const prefix of ['/api/auth', '/api/system', '/api/admin']) routes.options(`${prefix}/*`, optionsHandler);

    routes.route({ method: ['GET', 'POST'], url: '/api/auth/*', async handler(request, reply) {
      // Use the configured origin; never trust an incoming Host header for verification URLs.
      const url = new URL(request.url, runtime.baseUrl);
      const headers = fromNodeHeaders(request.headers);
      headers.set('x-system-client-ip', request.ip);
      const response = await runtime.auth.handler(new Request(url, { method: request.method, headers,
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}) }));
      reply.code(response.status);
      response.headers.forEach((value, key) => { if (key !== 'set-cookie' && key !== 'content-length') reply.header(key, value); });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
      if (!response.body) return reply.send(null);
      if (response.headers.get('content-type')?.includes('application/json')) {
        return reply.send(projectAuthHttpResponse(await response.json()));
      }
      return reply.send(await response.text());
    } });
    routes.get('/api/system/me', async request => safeIdentity(await runtime.authenticate(request)));
    const attempts = new Map<string, { count: number; expires: number }>();
    routes.post('/api/system/activate', async request => {
      const identity = await runtime.authenticate(request);
      const current = Date.now();
      // Bound memory, while retaining limits for abusive clients within the live window.
      for (const [key, record] of attempts) if (record.expires <= current) attempts.delete(key);
      const key = identity.id;
      const record = attempts.get(key) ?? { count: 0, expires: current + 60_000 };
      if (record.count >= 10 || (!attempts.has(key) && attempts.size >= 50_000)) throw new SystemError(429, 'RATE_LIMITED', 'Too many activation attempts; retry later');
      record.count++;
      attempts.set(key, record);
      const { code } = redeemSchema.parse(request.body);
      return runtime.store.redeemCode(identity.id, code);
    });
    routes.get('/api/admin/me', async request => {
      const identity = await runtime.requireAdmin(request);
      return { id: identity.id, email: identity.email, name: identity.name, role: identity.role };
    });
    routes.get('/api/admin/users', async request => {
      await runtime.requireAdmin(request);
      const query = listSchema.parse(request.query);
      return runtime.store.listUsers(query, query.sharingEligible === 'true');
    });
    routes.patch('/api/admin/users/:id', async request => {
      const actor = await runtime.requireAdmin(request, 'operate');
      return runtime.store.updateUser(actor, idSchema.parse(request.params).id, updateUserSchema.parse(request.body));
    });
    routes.post('/api/admin/users/:id/revoke-sessions', async request => {
      const actor = await runtime.requireAdmin(request, 'operate');
      return { revoked: runtime.store.revokeSessions(actor, idSchema.parse(request.params).id) };
    });
    routes.get('/api/admin/sharing-whitelist', async request => {
      await runtime.requireAdmin(request);
      return runtime.store.listUsers(listSchema.parse(request.query), true);
    });
    routes.put('/api/admin/sharing-whitelist/:id', async request => {
      const actor = await runtime.requireAdmin(request, 'operate');
      z.object({}).strict().parse(request.body);
      return runtime.store.updateUser(actor, idSchema.parse(request.params).id, { sharingEligible: true });
    });
    routes.delete('/api/admin/sharing-whitelist/:id', async request => {
      const actor = await runtime.requireAdmin(request, 'operate');
      return runtime.store.updateUser(actor, idSchema.parse(request.params).id, { sharingEligible: false });
    });
    routes.get('/api/admin/activation-codes', async request => {
      await runtime.requireAdmin(request);
      return runtime.store.listCodes(listSchema.parse(request.query));
    });
    routes.post('/api/admin/activation-codes', async (request, reply) => {
      const actor = await runtime.requireAdmin(request, 'operate');
      const input = createCodesSchema.parse(request.body);
      if (input.redeemBefore) {
        input.redeemBefore = new Date(input.redeemBefore).toISOString();
        if (Date.parse(input.redeemBefore) <= runtime.store.now().getTime()) throw new SystemError(400, 'INVALID_REDEEM_BEFORE', 'Redemption deadline must be in the future');
      }
      return reply.code(201).send(runtime.store.createCodes(actor.id, input));
    });
    routes.post('/api/admin/activation-codes/:id/revoke', async request => {
      const actor = await runtime.requireAdmin(request, 'operate');
      return runtime.store.revokeCode(actor.id, idSchema.parse(request.params).id);
    });
    routes.get('/api/admin/audit', async request => {
      await runtime.requireAdmin(request);
      return runtime.store.listAudit(listSchema.parse(request.query));
    });
    routes.get('/api/admin/admins', async request => {
      await runtime.requireAdmin(request, 'authorize');
      return runtime.store.listAdmins(listSchema.parse(request.query));
    });
    routes.put('/api/admin/admins/:id', async request => {
      const actor = await runtime.requireAdmin(request, 'authorize');
      return runtime.store.setAdmin(actor, idSchema.parse(request.params).id, adminSchema.parse(request.body).role);
    });
    routes.delete('/api/admin/admins/:id', async request => {
      const actor = await runtime.requireAdmin(request, 'authorize');
      return runtime.store.setAdmin(actor, idSchema.parse(request.params).id, null);
    });
  });
}
