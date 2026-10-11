import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { createSystemRuntime } from './runtime.js';
import { MemorySystemMailer } from './mail.js';
import { SystemStore } from './store.js';

/** Creates an isolated test fixture, never an administrator in a live database. */
export async function bootstrapLocalTestAdmin(input: { databasePath: string; email: string; password: string; enabled: boolean }) {
  if (!input.enabled || process.env.NODE_ENV === 'production') throw new Error('Local test bootstrap must be explicitly enabled outside production');
  if (!/^[^\s@]+@[^\s@]+\.(test|invalid)$/i.test(input.email)) throw new Error('Local bootstrap only accepts reserved .test or .invalid email domains');
  if (input.password.length < 12 || input.password.length > 128) throw new Error('Local test password must be between 12 and 128 characters');
  const databasePath = path.resolve(input.databasePath);
  const tempRoot = realpathSync(tmpdir());
  const insideTemp = (candidate: string) => candidate.startsWith(`${tempRoot}${path.sep}`);
  if (!insideTemp(databasePath)) throw new Error('Local bootstrap database must be in the OS temporary directory');
  if (existsSync(databasePath)) throw new Error('Local bootstrap requires a new empty database path');
  // Resolve existing ancestors before creating directories, rejecting symlink escapes.
  let ancestor = path.dirname(databasePath);
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const resolvedAncestor = realpathSync(ancestor);
  if (resolvedAncestor !== tempRoot && !insideTemp(resolvedAncestor)) throw new Error('Local bootstrap cannot follow a symlink outside the temporary directory');
  mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  const mailer = new MemorySystemMailer();
  const runtime = await createSystemRuntime({ databasePath, secret: randomBytes(48).toString('base64url'),
    baseUrl: 'http://127.0.0.1:3001', mailer, testMode: true });
  try {
    const registered = await runtime.auth.api.signUpEmail({ body: { email: input.email, password: input.password, name: 'Local test administrator' } });
    const message = mailer.messages[0];
    if (!message) throw new Error('Verification fixture was not generated');
    const verified = await runtime.auth.handler(new Request(message.url));
    if (verified.status >= 400) throw new Error('Local test email verification failed');
    const identity = runtime.store.getIdentity(registered.user.id);
    if (!identity?.emailVerified) throw new Error('Local test account was not verified');
    runtime.db.transaction(() => {
      const now = new Date().toISOString();
      runtime.db.prepare('INSERT INTO system_administrators(user_id,role,created_at,updated_at) VALUES(?,?,?,?)')
        .run(identity.id, 'superadmin', now, now);
      runtime.store.audit({ actorId: null, action: 'admin.bootstrap-local-test', targetType: 'user', targetId: identity.id });
    }).immediate();
    return { id: identity.id, email: identity.email, role: 'superadmin' as const, databasePath };
  } finally { await runtime.close(); }
}

/**
 * Deployment bootstrap is an offline operation on an existing verified account.
 * It never starts an HTTP listener, creates a user, generates a secret or sends mail.
 */
export function grantFirstSuperadminOffline(input: {
  databasePath: string;
  email?: string;
  userId?: string;
  confirmation: string;
}) {
  if (input.confirmation !== 'GRANT_FIRST_SUPERADMIN') throw new Error('Offline grant requires the explicit GRANT_FIRST_SUPERADMIN confirmation');
  if (!path.isAbsolute(input.databasePath) || !existsSync(input.databasePath)) throw new Error('Offline grant requires an explicit absolute path to an existing system database');
  if (Boolean(input.email) === Boolean(input.userId)) throw new Error('Specify exactly one existing verified email or userId');
  const db = new Database(input.databasePath, { fileMustExist: true });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  try {
    const store = new SystemStore(db);
    return db.transaction(() => {
      const existing = (db.prepare("SELECT COUNT(*) AS n FROM system_administrators WHERE role='superadmin'").get() as { n: number }).n;
      if (existing !== 0) throw new Error('Offline first-superadmin grant is disabled once a superadmin exists');
      const identity = input.userId ? store.getIdentity(input.userId) : store.getIdentityByEmail(input.email!);
      if (!identity || !identity.emailVerified || identity.disabled) throw new Error('Target must be an existing verified enabled account');
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO system_administrators(user_id,role,created_at,updated_at) VALUES(?,'superadmin',?,?)
        ON CONFLICT(user_id) DO UPDATE SET role='superadmin',updated_at=excluded.updated_at`).run(identity.id, now, now);
      db.prepare('DELETE FROM session WHERE userId=?').run(identity.id);
      store.audit({ actorId: null, action: 'admin.bootstrap-offline', targetType: 'user', targetId: identity.id,
        metadata: { role: 'superadmin', source: 'offline-cli' } });
      return { id: identity.id, email: identity.email, role: 'superadmin' as const };
    }).immediate();
  } finally { db.close(); }
}
