import Fastify, { type FastifyServerOptions } from 'fastify';
import { createSystemRuntime, type SystemRuntimeOptions } from './runtime.js';
import { registerSystemRoutes } from './routes.js';

export { createSystemRuntime, systemOptionsFromEnv, type SystemRuntime, type SystemRuntimeOptions } from './runtime.js';
export { registerSystemRoutes, type RegisterSystemRoutesOptions } from './routes.js';
export { MemorySystemMailer, createSmtpMailer, type SystemMailer, type VerificationMail } from './mail.js';
export { SystemStore } from './store.js';
export { SystemError, assertAdmin, adminRoles, type AdminRole, type AdminPermission, type SystemIdentity, type SystemPrincipal } from './types.js';
export { assertSystemRequestOrigin, systemLoggerOptions } from './security.js';

/** Does not import app.ts/config.ts, browsers, channels or generation code. */
export async function buildSystemApp(options: SystemRuntimeOptions, fastifyOptions: FastifyServerOptions = {}) {
  const runtime = await createSystemRuntime(options);
  const app = Fastify({ bodyLimit: 16_384, ...fastifyOptions });
  try {
    await registerSystemRoutes(app, { runtime });
    await app.ready();
    return { app, runtime };
  } catch (error) { await app.close(); await runtime.close(); throw error; }
}
