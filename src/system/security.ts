import type { FastifyRequest } from 'fastify';
import { SystemError } from './types.js';

/** Reuse on every /api plugin, including project and channel mutations. */
export function assertSystemRequestOrigin(request: FastifyRequest, trustedOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  if (origin && !trustedOrigins.includes(origin)) throw new SystemError(403, 'UNTRUSTED_ORIGIN', 'Origin is not allowed');
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (mutation && request.headers.cookie && !origin) throw new SystemError(403, 'ORIGIN_REQUIRED', 'Origin is required for cookie-authenticated mutations');
  if (request.headers['sec-fetch-site'] === 'cross-site' && !origin) throw new SystemError(403, 'UNTRUSTED_ORIGIN', 'Origin is required for cross-site requests');
  if (mutation && !request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new SystemError(415, 'JSON_REQUIRED', 'Use application/json for system requests');
  }
}

/** Do not log auth verification/reset query tokens or incoming credentials. */
export const systemLoggerOptions = {
  redact: ['req.headers.cookie', 'req.headers.authorization', 'res.headers.set-cookie'],
  serializers: {
    err: (error: {name?: string; code?: unknown}) => ({type: 'Error', message: 'Request failed', stack: '', code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'INTERNAL_ERROR'}),
    req: (request: { method?: string; url?: string; id?: string }) => ({ id: request.id, method: request.method, url: request.url?.split('?')[0] }),
  },
};
