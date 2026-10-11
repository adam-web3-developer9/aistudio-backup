import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySystemMailer, type VerificationMail } from './mail.js';
import { buildSystemWebApp } from './web-app.js';

const reservedEmail = (email: string) => /^[^\s@]+@[^\s@]+\.(test|invalid)$/i.test(email);
const loopback = (address: string | undefined) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

export interface LocalAcceptanceOptions {
  /** Exact explicit opt-in; not a truthy flag. */
  enabled: string | undefined;
  directory?: string;
  port?: number;
  adminDirectory?: string;
}

class LocalAcceptanceMailer extends MemorySystemMailer {
  private validate(message: VerificationMail): VerificationMail {
    if (!reservedEmail(message.to)) throw new Error('Local test mailbox only accepts reserved email domains');
    if (message.url.length > 4096) throw new Error('Local test verification link is too long');
    return { ...message, name: message.name.slice(0, 200) };
  }
  override async sendVerification(message: VerificationMail): Promise<void> {
    if (this.messages.length >= 100) this.messages.shift();
    await super.sendVerification(this.validate(message));
  }
  override async sendPasswordReset(message: VerificationMail): Promise<void> {
    if (this.passwordResets.length >= 100) this.passwordResets.shift();
    await super.sendPasswordReset(this.validate(message));
  }
}

function createEmptyDirectory(input?: string): string {
  const temporaryRoot = realpathSync(tmpdir());
  if (!input) return mkdtempSync(path.join(temporaryRoot, 'aistudio-local-acceptance-'));
  if (!path.isAbsolute(input)) throw new Error('Local test directory must be an explicit absolute temporary path');
  const directory = path.resolve(input);
  if (!directory.startsWith(`${temporaryRoot}${path.sep}`) || !/^aistudio-local-acceptance[-.]/.test(path.basename(directory))) {
    throw new Error('Local test directory must be a dedicated aistudio-local-acceptance temporary directory');
  }
  let existing = directory;
  while (!existsSync(existing)) existing = path.dirname(existing);
  const ancestor = realpathSync(existing);
  if (ancestor !== temporaryRoot && !ancestor.startsWith(`${temporaryRoot}${path.sep}`)) throw new Error('Local test directory cannot follow symlinks outside temporary storage');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory || readdirSync(directory).length !== 0) throw new Error('Local test directory must be new, empty and without symlink indirection');
  return directory;
}

/**
 * Explicit isolated acceptance service, adding a loopback-only fake mailbox and
 * signup restrictions to the original application before it becomes ready.
 * It never calls production environment configuration or enables legacy workers.
 */
export async function buildLocalAcceptanceApp(options: LocalAcceptanceOptions) {
  if (options.enabled !== '1') throw new Error('SYSTEM_LOCAL_TEST=1 is required for local acceptance');
  if (process.env.NODE_ENV === 'production') throw new Error('Local acceptance is forbidden in production');
  const port = options.port ?? 3001;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Local test port must be between 1024 and 65535');
  const directory = createEmptyDirectory(options.directory);
  const baseUrl = `http://127.0.0.1:${port}`;
  const databasePath = path.join(directory, 'system.sqlite');
  const markerPath = path.join(directory, 'local-test-access.json');
  const marker = randomBytes(32).toString('base64url');
  const markerDigest = createHash('sha256').update(marker).digest();
  const mailer = new LocalAcceptanceMailer();
  const service = await buildSystemWebApp({
    databasePath, baseUrl, secret: randomBytes(48).toString('base64url'), mailer,
    mediaDirectory: path.join(directory, 'private-media'),
    adminDirectory: options.adminDirectory ?? path.resolve('apps/admin/dist'),
    credentialKey: randomBytes(32).toString('base64'),
    // No legacy app/browser import or upstream account worker. Environment cannot override this.
    channelsEnabled: false, trustProxy: false, testMode: false,
    beforeReady(app) {
      app.addHook('onRequest', async (request, reply) => {
        reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer');
        if (!loopback(request.socket.remoteAddress)) return reply.code(403).send({ code: 'LOCAL_ONLY', message: 'Loopback connection required' });
        let host: URL;
        try { host = new URL(`http://${request.headers.host}`); }
        catch { return reply.code(403).send({ code: 'LOCAL_ONLY', message: 'Loopback host required' }); }
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return reply.code(403).send({ code: 'LOCAL_ONLY', message: 'Loopback host required' });
        if (request.headers.origin && request.headers.origin !== baseUrl) return reply.code(403).send({ code: 'LOCAL_ONLY', message: 'Local test origin required' });
      });
      app.addHook('preValidation', async (request, reply) => {
        const pathname = request.url.split('?')[0];
        if (request.method !== 'POST' || !['/api/auth/sign-up/email', '/api/auth/send-verification-email', '/api/auth/request-password-reset'].includes(pathname!)) return;
        const body = request.body as { email?: unknown } | null;
        if (!body || typeof body.email !== 'string' || body.email.length > 254 || !reservedEmail(body.email)) {
          return reply.code(400).send({ code: 'RESERVED_TEST_EMAIL_REQUIRED', message: 'Use a .test or .invalid email in local acceptance' });
        }
      });
      app.get('/__local-test/mailbox', async (request, reply) => {
        const supplied = request.headers['x-local-test-marker'];
        const actual = createHash('sha256').update(typeof supplied === 'string' ? supplied : '').digest();
        if (!timingSafeEqual(actual, markerDigest)) return reply.code(401).send({ code: 'LOCAL_TEST_MARKER_REQUIRED', message: 'Local test marker required' });
        const query = request.query as { email?: unknown; kind?: unknown };
        if (typeof query.email !== 'string' || query.email.length > 254 || !reservedEmail(query.email)
          || (query.kind !== undefined && !['verification', 'reset'].includes(String(query.kind)))) {
          return reply.code(400).send({ code: 'INVALID_TEST_MAILBOX', message: 'Reserved test email and valid message kind required' });
        }
        const messages = query.kind === 'reset' ? mailer.passwordResets : mailer.messages;
        const matching = messages.filter(message => message.to.toLowerCase() === (query.email as string).toLowerCase());
        return { data: matching.slice(-20).reverse().map(message => ({ to: message.to, url: message.url })), total: matching.length };
      });
    },
  });
  const app = service.app;
  try {
    await app.ready();
    writeFileSync(markerPath, JSON.stringify({ baseUrl, databasePath, marker }), { mode: 0o600, flag: 'wx' });
    return { app, directory, databasePath, markerPath, baseUrl, port };
  } catch (error) { await app.close(); throw error; }
}
