import type { FastifyRequest } from 'fastify';
import { SystemError } from './types.js';

/** Reuse on every /api plugin, including project and channel mutations. */
export function assertSystemRequestOrigin(request: FastifyRequest, trustedOrigins: readonly string[]): void {
  const origin = request.headers.origin;
  if (origin && !trustedOrigins.includes(origin)) throw new SystemError(403, 'UNTRUSTED_ORIGIN', 'Origin is not allowed');
  const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
  if (mutation && request.headers.cookie && !origin) throw new SystemError(403, 'ORIGIN_REQUIRED', 'Origin is required for cookie-authenticated mutations');
  // Email links are top-level GET navigations and browsers normally omit Origin.
  const documentNavigation = request.method === 'GET' && request.headers['sec-fetch-mode'] === 'navigate'
    && request.headers['sec-fetch-dest'] === 'document';
  if (request.headers['sec-fetch-site'] === 'cross-site' && !origin && !documentNavigation) throw new SystemError(403, 'UNTRUSTED_ORIGIN', 'Origin is required for cross-site requests');
  if (mutation && !request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    const match = /^\/api\/system\/projects\/([^/]+)\/media$/.exec(request.url.split('?')[0]!);
    let mediaId = ''; try { mediaId = match ? decodeURIComponent(match[1]!) : ''; } catch { /* Reject invalid encoding. */ }
    const metadata = request.headers['x-media-metadata'];
    const binaryMedia = request.method === 'POST' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(mediaId)
      && request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/octet-stream'
      && typeof metadata === 'string' && Buffer.byteLength(metadata) <= 4096;
    if (!binaryMedia) throw new SystemError(415, 'JSON_REQUIRED', 'Use JSON or the bounded private-media streaming endpoint');
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
