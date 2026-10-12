import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSystemApp, MemorySystemMailer, type AdminRole, type SystemRuntime } from './index.js';
import { bootstrapLocalTestAdmin, grantFirstSuperadminOffline } from './bootstrap.js';
import type { FastifyInstance } from 'fastify';

const origin = 'http://127.0.0.1:3001';
const secret = 'isolated-system-test-only-secret-which-is-long-enough';
const password = 'a-strong-local-test-password';
const emailNavigationHeaders = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
type User = { id: string; email: string; cookie: string };

describe('system identity, activation and administrator authorization', () => {
  let app: FastifyInstance;
  let runtime: SystemRuntime;
  let clock = new Date('2026-10-11T12:00:00Z');
  const mailer = new MemorySystemMailer();
  let superadmin: User, operator: User, readonly: User, user: User, second: User;
  const directory = mkdtempSync(path.join(tmpdir(), 'aistudio-system-test-'));
  const databasePath = path.join(directory, 'system.sqlite');

  async function request(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, as?: User, payload?: unknown) {
    return app.inject({ method, url, headers: { origin, ...(as ? { cookie: as.cookie } : {}), ...(method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
      ...(method !== 'GET' ? { payload: (payload ?? {}) as object } : {}) });
  }
  async function login(email: string, loginPassword = password) {
    const response = await request('POST', '/api/auth/sign-in/email', undefined, { email, password: loginPassword });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).not.toHaveProperty('token');
    return response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
  }
  async function register(label: string, role?: AdminRole): Promise<User> {
    const email = `${label}@example.invalid`;
    const response = await request('POST', '/api/auth/sign-up/email', undefined, { email, password, name: label, role: 'superadmin', sharingEligible: true, emailVerified: true });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).not.toHaveProperty('token');
    const id = response.json().user.id as string;
    const stored = runtime.store.getIdentity(id)!;
    expect(stored.role).toBeNull();
    expect(stored.emailVerified).toBe(false);
    expect(runtime.store.sharingEligible(id)).toBe(false);
    const message = mailer.messages.find(message => message.to === email)!;
    const verificationUrl = new URL(message.url);
    const verified = await request('GET', verificationUrl.pathname + verificationUrl.search);
    expect(verified.statusCode, verified.body).toBe(302);
    if (role) {
      const now = clock.toISOString();
      // Isolated fixture, not a public registration endpoint or a real administrator.
      runtime.db.prepare('INSERT INTO system_administrators(user_id,role,created_at,updated_at) VALUES(?,?,?,?)').run(id, role, now, now);
    }
    return { id, email, cookie: await login(email) };
  }

  beforeAll(async () => {
    ({ app, runtime } = await buildSystemApp({ databasePath, secret, baseUrl: origin, mailer, now: () => clock, testMode: true }));
    superadmin = await register('root', 'superadmin');
    operator = await register('operator', 'operator');
    readonly = await register('readonly', 'readonly');
    user = await register('user');
    second = await register('second');
  }, 20_000);
  afterAll(async () => { await app?.close(); rmSync(directory, { recursive: true, force: true }); });

  it('requires verified email before login and never turns signup fields into privileges', async () => {
    const email = 'unverified@example.invalid';
    const signup = await request('POST', '/api/auth/sign-up/email', undefined, { email, name: 'Not verified', password });
    expect(signup.statusCode).toBe(200);
    const response = await request('POST', '/api/auth/sign-in/email', undefined, { email, password });
    expect(response.statusCode).toBe(403);
    expect(response.cookies.some(cookie => cookie.name.endsWith('session_token'))).toBe(false);
    expect(runtime.store.getIdentityByEmail(email)?.emailVerified).toBe(false);
  });

  it('accepts eight-character registration passwords and rejects shorter ones', async () => {
    const email = 'eight-character-password@example.invalid';
    const shorter = await request('POST', '/api/auth/sign-up/email', undefined, { email, name: 'Password boundary', password: '1234567' });
    expect(shorter.statusCode).toBe(400);
    expect(runtime.store.getIdentityByEmail(email)).toBeNull();
    const signup = await request('POST', '/api/auth/sign-up/email', undefined, { email, name: 'Password boundary', password: '12345678' });
    expect(signup.statusCode).toBe(200);
    const verification = new URL(mailer.messages.find(message => message.to === email)!.url);
    expect((await app.inject({ method: 'GET', url: verification.pathname + verification.search, headers: emailNavigationHeaders })).statusCode).toBe(302);
    expect(await login(email, '12345678')).toContain('session_token');
  });

  it('returns safe unactivated identity and no channel credentials, credits, or session token', async () => {
    const response = await request('GET', '/api/system/me', user);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: user.id, role: null, everActivated: false, validUntil: null, cloudEligible: false, sharingEnabled: false, localExpiryPolicy: 'pending' });
    for (const key of ['cookies', 'credits', 'token', 'session', 'sessionId', 'sharingEligible', 'adminRole']) expect(response.json()).not.toHaveProperty(key);
  });

  it('verifies an email opened from webmail without Origin while enforcing tokens and callback origins', async () => {
    const email = 'email-navigation@example.invalid';
    const signup = await request('POST', '/api/auth/sign-up/email', undefined, { email, name: 'Email navigation', password });
    expect(signup.statusCode).toBe(200);
    const verification = new URL(mailer.messages.find(message => message.to === email)!.url);
    expect(verification.searchParams.get('callbackURL')).toBe(`${origin}/account/verified`);
    // Previously sent signup messages used the root path, which Nginx sends to /admin/.
    verification.searchParams.set('callbackURL', '/');
    const headers = { ...emailNavigationHeaders, cookie: user.cookie };
    const forgedCallback = new URL(verification);
    forgedCallback.searchParams.set('callbackURL', 'https://evil.invalid/account/verified');
    const denied = await app.inject({ method: 'GET', url: forgedCallback.pathname + forgedCallback.search, headers });
    expect(denied.statusCode).toBe(403);
    expect(runtime.store.getIdentityByEmail(email)?.emailVerified).toBe(false);
    const invalidToken = new URL(verification);
    invalidToken.searchParams.set('token', 'invalid-token');
    const invalid = await app.inject({ method: 'GET', url: invalidToken.pathname + invalidToken.search, headers });
    expect(invalid.statusCode).toBe(302);
    expect(new URL(invalid.headers.location as string).searchParams.has('error')).toBe(true);
    const failedTarget = new URL(invalid.headers.location as string, origin);
    const failurePage = await app.inject({ method: 'GET', url: failedTarget.pathname + failedTarget.search, headers });
    expect(failurePage.body).toContain('邮箱验证未完成');
    expect(runtime.store.getIdentityByEmail(email)?.emailVerified).toBe(false);
    const verified = await app.inject({ method: 'GET', url: verification.pathname + verification.search, headers });
    expect(verified.statusCode).toBe(302);
    expect(verified.headers.location).toBe(`${origin}/account/verified`);
    expect(runtime.store.getIdentityByEmail(email)?.emailVerified).toBe(true);
    expect(verified.cookies.some(cookie => cookie.name.endsWith('session_token'))).toBe(false);
    const successPage = await app.inject({ method: 'GET', url: '/account/verified', headers });
    expect(successPage.statusCode).toBe(200);
    expect(successPage.body).toContain('邮箱验证成功');
    expect((await request('GET', '/api/system/me', user)).json().id).toBe(user.id);
  });

  it('projects real session HTTP responses while retaining cookie login and the native internal auth API', async () => {
    const session = await request('GET', '/api/auth/get-session', user);
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ user: { id: user.id }, session: { id: expect.any(String) } });
    const assertNoCredentials = (value: unknown): void => {
      if (Array.isArray(value)) { for (const item of value) assertNoCredentials(item); return; }
      if (!value || typeof value !== 'object') return;
      for (const [key, item] of Object.entries(value)) {
        expect(['token', 'ipAddress', 'userAgent', 'accessToken', 'refreshToken', 'idToken']).not.toContain(key);
        assertNoCredentials(item);
      }
    };
    assertNoCredentials(session.json());
    const list = await request('GET', '/api/auth/list-sessions', user);
    expect(list.statusCode).toBe(200);
    assertNoCredentials(list.json());
    const internal = await runtime.auth.api.getSession({ headers: new Headers({ cookie: user.cookie }), query: { disableCookieCache: true } });
    expect(internal?.session.token).toEqual(expect.any(String));
    expect(session.body).not.toContain(internal!.session.token);
    expect(list.body).not.toContain(internal!.session.token);
    expect((await request('GET', '/api/system/me', user)).statusCode).toBe(200);
  });

  it('revalidates retained task principals after qualification changes, revocation and expiry', async () => {
    const fixture = await register('retained-principal');
    const storedSession = runtime.db.prepare('SELECT id,expiresAt FROM session WHERE userId=?').get(fixture.id) as { id: string; expiresAt: string | number };
    const reference = { id: fixture.id, sessionId: storedSession.id };
    runtime.db.prepare('UPDATE system_accounts SET ever_activated=1,valid_until=?,sharing_eligible=1 WHERE user_id=?')
      .run('2027-12-01T00:00:00.000Z', fixture.id);
    const old = runtime.assertPrincipalCurrent(reference);
    expect(old).toMatchObject({ cloudEligible: true, sharingEligible: true });
    runtime.db.prepare('UPDATE system_accounts SET sharing_eligible=0,valid_until=? WHERE user_id=?')
      .run('2026-01-01T00:00:00.000Z', fixture.id);
    expect(runtime.assertPrincipalCurrent(old)).toMatchObject({ cloudEligible: false, sharingEligible: false });
    runtime.db.prepare('UPDATE system_accounts SET disabled=1 WHERE user_id=?').run(fixture.id);
    expect(() => runtime.assertPrincipalCurrent(old)).toThrow('Account is unavailable');
    runtime.db.prepare('UPDATE system_accounts SET disabled=0 WHERE user_id=?').run(fixture.id);
    expect(() => runtime.assertPrincipalCurrent({ id: user.id, sessionId: storedSession.id })).toThrow('Session is expired or revoked');
    runtime.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(Date.now() - 1, storedSession.id);
    expect(() => runtime.assertPrincipalCurrent(old)).toThrow('Session is expired or revoked');
    runtime.db.prepare('UPDATE session SET expiresAt=? WHERE id=?').run(storedSession.expiresAt, storedSession.id);
    runtime.store.revokeSessions(runtime.store.getIdentity(superadmin.id)!, fixture.id);
    expect(() => runtime.assertPrincipalCurrent(old)).toThrow('Session is expired or revoked');
  });

  it('rejects anonymous and ordinary users on every administrative family', async () => {
    for (const url of ['/api/admin/me', '/api/admin/users', '/api/admin/admins', '/api/admin/activation-codes', '/api/admin/audit', '/api/admin/sharing-whitelist']) {
      expect((await request('GET', url)).statusCode).toBe(401);
      expect((await request('GET', url, user)).statusCode).toBe(403);
    }
    expect((await request('PUT', `/api/admin/admins/${user.id}`, user, { role: 'superadmin' })).statusCode).toBe(403);
  });

  it('blocks privilege escalation, readonly writes, and operator changes to administrator accounts', async () => {
    expect((await request('GET', '/api/admin/users', readonly)).statusCode).toBe(200);
    expect((await request('POST', '/api/admin/activation-codes', readonly, {})).statusCode).toBe(403);
    expect((await request('PUT', `/api/admin/admins/${user.id}`, operator, { role: 'superadmin' })).statusCode).toBe(403);
    expect((await request('GET', '/api/admin/admins', operator)).statusCode).toBe(403);
    expect((await request('PATCH', `/api/admin/users/${superadmin.id}`, operator, { disabled: true })).statusCode).toBe(403);
    expect((await request('POST', `/api/admin/users/${readonly.id}/revoke-sessions`, operator, {})).statusCode).toBe(403);
    expect((await request('PATCH', `/api/admin/users/${user.id}`, operator, { role: 'superadmin' })).statusCode).toBe(400);
    expect(runtime.store.getIdentity(user.id)?.role).toBeNull();
  });

  it('protects the last enabled superadmin', async () => {
    expect((await request('DELETE', `/api/admin/admins/${superadmin.id}`, superadmin)).statusCode).toBe(409);
    expect((await request('PATCH', `/api/admin/users/${superadmin.id}`, superadmin, { disabled: true })).statusCode).toBe(409);
  });

  it('rejects forged Origin, missing Origin with cookies, and form submissions', async () => {
    const url = '/api/admin/activation-codes';
    const forged = await app.inject({ method: 'POST', url, headers: { origin: 'https://evil.invalid', cookie: operator.cookie }, payload: {} });
    expect(forged.statusCode).toBe(403);
    const missing = await app.inject({ method: 'POST', url, headers: { cookie: operator.cookie }, payload: {} });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().code).toBe('ORIGIN_REQUIRED');
    const form = await app.inject({ method: 'POST', url, headers: { origin, cookie: operator.cookie, 'content-type': 'text/plain' }, payload: '{}' });
    expect(form.statusCode).toBe(415);
    const options = await app.inject({ method: 'OPTIONS', url, headers: { origin: 'https://evil.invalid' } });
    expect(options.statusCode).toBe(403);
    const navigationWithOrigin = await app.inject({ method: 'GET', url: '/account/verified', headers: { ...emailNavigationHeaders, origin: 'https://evil.invalid' } });
    expect(navigationWithOrigin.statusCode).toBe(403);
    for (const headers of [
      { 'sec-fetch-site': 'cross-site' },
      { ...emailNavigationHeaders, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      { ...emailNavigationHeaders, 'sec-fetch-dest': 'iframe' },
    ]) {
      const crossSiteRead = await app.inject({ method: 'GET', url: '/api/system/me', headers: { ...headers, cookie: user.cookie } });
      expect(crossSiteRead.statusCode).toBe(403);
      expect(crossSiteRead.json().code).toBe('UNTRUSTED_ORIGIN');
    }
    const crossSiteWrite = await app.inject({ method: 'POST', url, headers: emailNavigationHeaders, payload: {} });
    expect(crossSiteWrite.statusCode).toBe(403);
    expect(crossSiteWrite.json().code).toBe('UNTRUSTED_ORIGIN');
  });

  it('returns Refine data+total, defaults validity to 365 days, and persists only a digest', async () => {
    const result = await request('POST', '/api/admin/activation-codes', operator, {});
    expect(result.statusCode).toBe(201);
    const created = result.json().data[0];
    expect(created.validityDays).toBe(365);
    expect(created.code).toMatch(/^ACT-[A-Za-z0-9_-]{43}$/);
    const persisted = runtime.db.prepare('SELECT * FROM system_activation_codes WHERE id=?').get(created.id);
    expect(JSON.stringify(persisted)).not.toContain(created.code);
    expect(persisted).toHaveProperty('digest');
    const list = await request('GET', '/api/admin/activation-codes?page=1&pageSize=1', readonly);
    expect(list.json()).toMatchObject({ data: expect.any(Array), total: expect.any(Number) });
    expect(list.json().data).toHaveLength(1);
    expect(list.body).not.toContain(created.code);
    expect(list.body).not.toContain('digest');
  });

  it('redeems once across racing accounts and commits receipt, entitlement and audit together', async () => {
    const created = (await request('POST', '/api/admin/activation-codes', operator, { note: 'concurrency fixture' })).json().data[0];
    const responses = await Promise.all([request('POST', '/api/system/activate', user, { code: created.code }), request('POST', '/api/system/activate', second, { code: created.code })]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const winnerIndex = responses.findIndex(response => response.statusCode === 200);
    const winner = winnerIndex === 0 ? user : second;
    const success = responses[winnerIndex]!.json();
    expect(success.receipt.validUntil).toBe(new Date(clock.getTime() + 365 * 86400_000).toISOString());
    expect(success.identity).toMatchObject({ everActivated: true, cloudEligible: true, sharingEnabled: false, localExpiryPolicy: 'pending' });
    expect((runtime.db.prepare('SELECT COUNT(*) AS n FROM system_activation_receipts WHERE code_id=?').get(created.id) as { n: number }).n).toBe(1);
    expect((runtime.db.prepare("SELECT COUNT(*) AS n FROM system_audit WHERE action='activation.redeem' AND target_id=?").get(created.id) as { n: number }).n).toBe(1);
    const retry = await request('POST', '/api/system/activate', winner, { code: created.code });
    expect(retry.statusCode).toBe(200);
    expect(retry.json()).toMatchObject({ alreadyRedeemed: true, receipt: success.receipt });
  });

  it('keeps the independent redemption deadline separate from validity duration', async () => {
    const created = (await request('POST', '/api/admin/activation-codes', operator, { validityDays: 365, redeemBefore: '2026-10-12T12:00:00Z' })).json().data[0];
    clock = new Date('2026-10-11T18:00:00Z');
    const redeemed = await request('POST', '/api/system/activate', user, { code: created.code });
    expect(redeemed.statusCode).toBe(200);
    expect(redeemed.json().receipt.validUntil).toBe('2027-10-11T18:00:00.000Z');
    const expired = (await request('POST', '/api/admin/activation-codes', operator, { redeemBefore: '2026-10-12T12:00:00Z' })).json().data[0];
    clock = new Date('2026-10-12T12:00:00Z');
    expect((await request('POST', '/api/system/activate', user, { code: expired.code })).statusCode).toBe(409);
    expect(runtime.store.listCodes({ page: 1, pageSize: 100 }).data.find(code => code.id === expired.id)?.status).toBe('expired');
  });

  it('rolls the claim and entitlement back if audit persistence fails', async () => {
    const created = (await request('POST', '/api/admin/activation-codes', operator, {})).json().data[0];
    const before = runtime.store.getIdentity(user.id);
    runtime.db.exec("CREATE TRIGGER fail_test_redemption_audit BEFORE INSERT ON system_audit WHEN NEW.action='activation.redeem' BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
    try { expect((await request('POST', '/api/system/activate', user, { code: created.code })).statusCode).toBe(500); }
    finally { runtime.db.exec('DROP TRIGGER fail_test_redemption_audit'); }
    expect(runtime.store.getIdentity(user.id)).toEqual(before);
    expect((runtime.db.prepare('SELECT redeemed_at FROM system_activation_codes WHERE id=?').get(created.id) as { redeemed_at: null }).redeemed_at).toBeNull();
    expect((runtime.db.prepare('SELECT COUNT(*) AS n FROM system_activation_receipts WHERE code_id=?').get(created.id) as { n: number }).n).toBe(0);
  });

  it('revokes unredeemed codes and keeps audit/list output free of plaintext codes', async () => {
    const created = (await request('POST', '/api/admin/activation-codes', operator, {})).json().data[0];
    const revoked = await request('POST', `/api/admin/activation-codes/${created.id}/revoke`, operator, {});
    expect(revoked.json().status).toBe('revoked');
    expect((await request('POST', '/api/system/activate', user, { code: created.code })).statusCode).toBe(409);
    const audit = await request('GET', '/api/admin/audit', readonly);
    expect(audit.body).not.toContain(created.code);
    expect(audit.body).not.toContain('digest');
  });

  it('requires an explicit independent sharing whitelist entry', async () => {
    expect(runtime.store.sharingEligible(user.id)).toBe(false);
    expect((await request('PUT', `/api/admin/sharing-whitelist/${user.id}`, operator, {})).statusCode).toBe(200);
    expect((await request('GET', '/api/system/me', user)).json().sharingEnabled).toBe(true);
    const list = await request('GET', '/api/admin/users?sharingEligible=true', readonly);
    expect(list.json().data.map((entry: { id: string }) => entry.id)).toContain(user.id);
    expect((await request('DELETE', `/api/admin/sharing-whitelist/${user.id}`, operator)).statusCode).toBe(200);
    expect((await request('GET', '/api/system/me', user)).json().sharingEnabled).toBe(false);
  });

  it('applies live role changes and session revocation immediately', async () => {
    const grant = await request('PUT', `/api/admin/admins/${readonly.id}`, superadmin, { role: 'operator' });
    expect(grant.statusCode).toBe(200);
    expect((await request('GET', '/api/admin/me', readonly)).statusCode).toBe(401);
    readonly.cookie = await login(readonly.email);
    expect((await request('GET', '/api/admin/me', readonly)).json().role).toBe('operator');
    const revoke = await request('POST', `/api/admin/users/${second.id}/revoke-sessions`, operator, {});
    expect(revoke.statusCode).toBe(200);
    expect((await request('GET', '/api/system/me', second)).statusCode).toBe(401);
    second.cookie = await login(second.email);
    expect((await request('PATCH', `/api/admin/users/${second.id}`, operator, { disabled: true })).statusCode).toBe(200);
    expect((await request('GET', '/api/system/me', second)).statusCode).toBe(401);
    const deniedLogin = await request('POST', '/api/auth/sign-in/email', undefined, { email: second.email, password });
    expect(deniedLogin.statusCode).toBe(403);
    expect(deniedLogin.cookies.some(cookie => cookie.name.endsWith('session_token'))).toBe(false);
  });

  it('offers working verification/reset landing pages and a fake reset mail flow', async () => {
    const page = await app.inject({ method: 'GET', url: '/account/reset-password', headers: emailNavigationHeaders });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.body).toContain('minlength="8"');
    expect((await request('GET', '/account/verified')).statusCode).toBe(200);
    const reset = await request('POST', '/api/auth/request-password-reset', undefined, { email: user.email, redirectTo: `${origin}/account/reset-password` });
    expect(reset.statusCode).toBe(200);
    const message = mailer.passwordResets.find(message => message.to === user.email)!;
    expect(message.url).toContain('/api/auth/reset-password/');
    const url = new URL(message.url);
    const redirect = await app.inject({ method: 'GET', url: url.pathname + url.search, headers: emailNavigationHeaders });
    expect(redirect.statusCode).toBe(302);
    const target = new URL(redirect.headers.location as string);
    const token = target.searchParams.get('token');
    expect(token).toBeTruthy();
    expect((await app.inject({ method: 'GET', url: target.pathname + target.search, headers: emailNavigationHeaders })).statusCode).toBe(200);
    const shorter = await request('POST', '/api/auth/reset-password', undefined, { token, newPassword: '1234567' });
    expect(shorter.statusCode).toBe(400);
    const changed = await request('POST', '/api/auth/reset-password', undefined, { token, newPassword: '87654321' });
    expect(changed.statusCode, changed.body).toBe(200);
    expect((await request('GET', '/api/system/me', user)).statusCode).toBe(401);
    user.cookie = await login(user.email, '87654321');
    expect((await request('POST', '/api/auth/reset-password', undefined, { token, newPassword: password })).statusCode).toBe(400);
  });

  it('persists activation across restart and keeps local activation history after expiry', async () => {
    const before = runtime.store.getIdentity(user.id)!;
    expect(before.everActivated).toBe(true);
    await app.close();
    clock = new Date('2028-01-01T00:00:00Z');
    ({ app, runtime } = await buildSystemApp({ databasePath, secret, baseUrl: origin, mailer, now: () => clock, testMode: true }));
    const persisted = runtime.store.getIdentity(user.id)!;
    expect(persisted.validUntil).toBe(before.validUntil);
    expect(persisted).toMatchObject({ everActivated: true, cloudEligible: false, sharingEnabled: false, localExpiryPolicy: 'pending' });
    // No new local/offline lock is introduced by the account service.
    expect(persisted).not.toHaveProperty('offlineLeaseUntil');
    expect(persisted).not.toHaveProperty('localBlocked');
  });
});

describe('isolated bootstrap and secure cookies', () => {
  it('enforces auth rate limiting without trusting a client-supplied IP header', async () => {
    const { app } = await buildSystemApp({ databasePath: ':memory:', secret, baseUrl: origin, mailer: new MemorySystemMailer() });
    try {
      const statuses: number[] = [];
      for (let index = 0; index < 4; index++) {
        const response = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email',
          headers: { origin, 'x-forwarded-for': `10.0.0.${index + 1}`, 'x-system-client-ip': `10.0.1.${index + 1}` },
          payload: { email: 'not-registered@example.invalid', password } });
        statuses.push(response.statusCode);
      }
      expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
      expect(statuses[3]).toBe(429);
    } finally { await app.close(); }
  });

  it('caps authentication bodies before parsing or hashing', async () => {
    const { app } = await buildSystemApp({ databasePath: ':memory:', secret, baseUrl: origin, mailer: new MemorySystemMailer(), testMode: true }, { bodyLimit: 2 * 1024 * 1024 });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: { origin },
        payload: { email: 'oversized@example.invalid', name: 'x'.repeat(20_000), password } });
      expect(response.statusCode).toBe(413);
    } finally { await app.close(); }
  });

  it('grants only one existing verified enabled account through the explicit offline CLI operation', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aistudio-offline-grant-test-'));
    const databasePath = path.join(directory, 'system.sqlite');
    const mailer = new MemorySystemMailer();
    const { app, runtime } = await buildSystemApp({ databasePath, secret, baseUrl: origin, mailer, testMode: true });
    try {
      const signup = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: { origin }, payload: { email: 'offline@example.invalid', name: 'Offline test', password } });
      const id = signup.json().user.id as string;
      expect(() => grantFirstSuperadminOffline({ databasePath, email: 'offline@example.invalid', confirmation: '' })).toThrow('explicit');
      expect(() => grantFirstSuperadminOffline({ databasePath, email: 'offline@example.invalid', confirmation: 'GRANT_FIRST_SUPERADMIN' })).toThrow('verified enabled');
      const url = new URL(mailer.messages[0]!.url);
      await app.inject({ method: 'GET', url: url.pathname + url.search });
      const result = grantFirstSuperadminOffline({ databasePath, userId: id, confirmation: 'GRANT_FIRST_SUPERADMIN' });
      expect(result).toMatchObject({ id, role: 'superadmin' });
      expect(runtime.store.getIdentity(id)?.role).toBe('superadmin');
      expect(() => grantFirstSuperadminOffline({ databasePath, userId: id, confirmation: 'GRANT_FIRST_SUPERADMIN' })).toThrow('once a superadmin exists');
      expect(runtime.store.listAudit({ page: 1, pageSize: 20 }).data).toContainEqual(expect.objectContaining({ action: 'admin.bootstrap-offline' }));
      expect((runtime.db.prepare('SELECT COUNT(*) AS n FROM user').get() as { n: number }).n).toBe(1);
      expect(mailer.messages).toHaveLength(1);
    } finally { await app.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('never bootstraps in a live database or with a real email address', async () => {
    await expect(bootstrapLocalTestAdmin({ enabled: false, databasePath: '/tmp/unused.sqlite', email: 'root@example.invalid', password })).rejects.toThrow('explicitly enabled');
    await expect(bootstrapLocalTestAdmin({ enabled: true, databasePath: '/tmp/unused.sqlite', email: 'real@example.com', password })).rejects.toThrow('reserved');
    await expect(bootstrapLocalTestAdmin({ enabled: true, databasePath: '/workspace/production.sqlite', email: 'root@example.invalid', password })).rejects.toThrow('temporary');
  });

  it('creates only an explicitly requested new temporary test fixture', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aistudio-bootstrap-test-'));
    try {
      const databasePath = path.join(directory, 'system.sqlite');
      const result = await bootstrapLocalTestAdmin({ enabled: true, databasePath, email: 'root@example.invalid', password });
      expect(result.role).toBe('superadmin');
      await expect(bootstrapLocalTestAdmin({ enabled: true, databasePath, email: 'root@example.invalid', password })).rejects.toThrow('new empty database');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('uses HttpOnly Secure SameSite cookies on HTTPS', async () => {
    const mailer = new MemorySystemMailer();
    const { app } = await buildSystemApp({ databasePath: ':memory:', secret, baseUrl: 'https://studio.example.invalid', mailer, testMode: true });
    try {
      const headers = { origin: 'https://studio.example.invalid' };
      await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers, payload: { email: 'secure@example.invalid', name: 'Secure', password } });
      const url = new URL(mailer.messages[0]!.url);
      await app.inject({ method: 'GET', url: url.pathname + url.search });
      const signedIn = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email: 'secure@example.invalid', password } });
      expect(signedIn.statusCode).toBe(200);
      const cookie = signedIn.cookies.find(cookie => cookie.name.endsWith('session_token'))!;
      expect(cookie.httpOnly).toBe(true);
      expect(cookie.secure).toBe(true);
      expect(cookie.sameSite).toBe('Lax');
    } finally { await app.close(); }
  });
});
