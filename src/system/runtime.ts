import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyRequest } from 'fastify';
import type Database from 'better-sqlite3';
import { migrateSystemDatabase, openSystemDatabase } from './database.js';
import { createSmtpMailer, type SystemMailer, type VerificationMail } from './mail.js';
import { SystemStore } from './store.js';
import { assertAdmin, SystemError, type AdminPermission, type SystemPrincipal } from './types.js';
import { assertSystemRequestOrigin } from './security.js';
import { normalizeVerificationCallback } from './verification-link.js';

export interface SystemRuntimeOptions {
  databasePath: string;
  secret: string;
  baseUrl: string;
  trustedOrigins?: string[];
  mailer: SystemMailer;
  now?: () => Date;
  /** Only explicit isolated test runtimes may disable auth rate limiting. */
  testMode?: boolean;
  /** Receives no email, token, password or SMTP error details. */
  onMailDeliveryError?: () => void;
}

export interface SystemRuntime {
  db: Database.Database;
  store: SystemStore;
  auth: ReturnType<typeof betterAuth>;
  baseUrl: string;
  trustedOrigins: string[];
  authenticate(request: FastifyRequest): Promise<SystemPrincipal>;
  /** Revalidate a retained task principal against live account/session state. */
  assertPrincipalCurrent(principal: { id: string; sessionId: string }): SystemPrincipal;
  requireAdmin(request: FastifyRequest, permission?: AdminPermission): Promise<SystemPrincipal>;
  assertRequestOrigin(request: FastifyRequest): void;
  close(): Promise<void>;
}

export async function createSystemRuntime(options: SystemRuntimeOptions): Promise<SystemRuntime> {
  if (options.secret.length < 32) throw new Error('SYSTEM_AUTH_SECRET must have at least 32 characters');
  const baseUrl = new URL(options.baseUrl);
  if (process.env.NODE_ENV === 'production' && (options.testMode || baseUrl.protocol !== 'https:')) throw new Error('Production system runtime requires HTTPS and enabled rate limiting');
  if (baseUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname)) {
    throw new Error('System authentication requires HTTPS except on loopback');
  }
  if (baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') {
    throw new Error('SYSTEM_BASE_URL must be an origin without credentials or path');
  }
  const trustedOrigins = [...new Set([baseUrl.origin, ...(options.trustedOrigins ?? []).map(origin => {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
      throw new Error('SYSTEM_TRUSTED_ORIGINS requires exact HTTPS or loopback origins');
    }
    return origin;
  })])];
  const db = openSystemDatabase(options.databasePath);
  const store = new SystemStore(db, options.now);
  const mailTasks = new Set<Promise<unknown>>();
  const deliverMail = async (type: 'verification' | 'reset', message: VerificationMail) => {
    try {
      if (type === 'verification') await options.mailer.sendVerification(message);
      else await options.mailer.sendPasswordReset(message);
    } catch {
      // Never pass SMTP errors, verification URLs or recipient data to auth logs/responses.
      if (options.onMailDeliveryError) options.onMailDeliveryError();
      else console.error('System email delivery failed');
    }
  };
  const authOptions: BetterAuthOptions = {
    appName: 'AI Studio System',
    baseURL: baseUrl.origin,
    basePath: '/api/auth',
    secret: options.secret,
    database: db,
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 8,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
        await deliverMail('reset', { to: user.email, name: user.name, url });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
        const verification = new URL(url);
        normalizeVerificationCallback(verification, baseUrl.origin);
        await deliverMail('verification', { to: user.email, name: user.name, url: verification.href });
      },
    },
    session: { expiresIn: 7 * 86400, updateAge: 86400, cookieCache: { enabled: false } },
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      backgroundTasks: { handler: task => {
        mailTasks.add(task);
        void task.finally(() => mailTasks.delete(task));
      } },
      // The Fastify bridge overwrites this from request.ip, whose proxy trust is deployment-controlled.
      ipAddress: { ipAddressHeaders: ['x-system-client-ip'] },
      cookiePrefix: 'aistudio-system',
      useSecureCookies: baseUrl.protocol === 'https:',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' as const },
    },
    rateLimit: { enabled: !options.testMode, window: 60, max: 30 },
    user: { deleteUser: { enabled: false }, changeEmail: { enabled: false } },
    account: { accountLinking: { enabled: false } },
    databaseHooks: {
      session: { create: { before: async (session: { userId: string }) => {
        const identity = store.getIdentity(session.userId);
        if (!identity || identity.disabled || !identity.emailVerified) throw new APIError('FORBIDDEN', { code: 'ACCOUNT_DISABLED', message: 'Account is unavailable' });
      } } },
    },
    logger: { level: 'error' as const },
  };
  try {
    // Official Better Auth schema planner; additive schema upgrades are explicit here.
    const migrations = await getMigrations(authOptions);
    if (migrations.schemaProblems.length) throw new Error(`Authentication schema mismatch: ${migrations.schemaProblems.join('; ')}`);
    await migrations.runMigrations();
    migrateSystemDatabase(db);
    const auth = betterAuth(authOptions);
    let closed = false;
    const assertPrincipalCurrent = (principal: { id: string; sessionId: string }): SystemPrincipal => {
      const session = db.prepare('SELECT userId,expiresAt FROM session WHERE id=?').get(principal.sessionId) as { userId: string; expiresAt: string | number } | undefined;
      const expiry = session ? new Date(session.expiresAt).getTime() : NaN;
      if (!session || session.userId !== principal.id || !Number.isFinite(expiry) || expiry <= Date.now()) {
        throw new SystemError(401, 'SESSION_REVOKED', 'Session is expired or revoked');
      }
      const identity = store.getIdentity(principal.id);
      if (!identity || identity.disabled) throw new SystemError(403, 'ACCOUNT_DISABLED', 'Account is unavailable');
      if (!identity.emailVerified) throw new SystemError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email before continuing');
      return { ...identity, sessionId: principal.sessionId, sharingEligible: store.sharingEligible(identity.id), adminRole: identity.role };
    };
    const authenticate = async (request: FastifyRequest): Promise<SystemPrincipal> => {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(request.headers), query: { disableCookieCache: true } });
      if (!session) throw new SystemError(401, 'UNAUTHORIZED', 'Sign in required');
      return assertPrincipalCurrent({ id: session.user.id, sessionId: session.session.id });
    };
    return {
      db, store, auth, baseUrl: baseUrl.origin, trustedOrigins, authenticate, assertPrincipalCurrent,
      assertRequestOrigin: request => assertSystemRequestOrigin(request, trustedOrigins),
      async requireAdmin(request: FastifyRequest, permission: AdminPermission = 'read') {
        const identity = await authenticate(request);
        assertAdmin(identity, permission);
        return identity;
      },
      async close() {
        if (closed) return;
        closed = true;
        await Promise.allSettled([...mailTasks]);
        options.mailer.close?.();
        if (db.open) db.close();
      },
    };
  } catch (error) { db.close(); throw error; }
}

export function systemOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): SystemRuntimeOptions {
  const required = (key: string) => {
    if (!env[key]) throw new Error(`${key} is required for the system runtime`);
    return env[key]!;
  };
  if (env.SYSTEM_MAIL_MODE !== 'smtp') throw new Error('SYSTEM_MAIL_MODE=smtp is required; tests inject MemorySystemMailer directly');
  const port = Number(env.SYSTEM_SMTP_PORT ?? '587');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid SYSTEM_SMTP_PORT');
  return {
    databasePath: required('SYSTEM_DATABASE_PATH'),
    secret: required('SYSTEM_AUTH_SECRET'),
    baseUrl: required('SYSTEM_BASE_URL'),
    trustedOrigins: env.SYSTEM_TRUSTED_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean),
    mailer: createSmtpMailer({ host: required('SYSTEM_SMTP_HOST'), port,
      secure: env.SYSTEM_SMTP_SECURE === 'true', from: required('SYSTEM_SMTP_FROM'),
      user: env.SYSTEM_SMTP_USER, password: env.SYSTEM_SMTP_PASSWORD }),
  };
}
