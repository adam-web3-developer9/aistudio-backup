import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildLocalAcceptanceApp } from './local-dev.js';
import { createSystemRuntime, systemOptionsFromEnv } from './runtime.js';
import { MemorySystemMailer } from './mail.js';
import { grantFirstSuperadminOffline } from './bootstrap.js';

afterEach(() => vi.unstubAllEnvs());
describe('explicit isolated local acceptance', () => {
  it('preserves missing SMTP failclosed and rejects production test mode', async () => {
    expect(() => systemOptionsFromEnv({})).toThrow('SYSTEM_MAIL_MODE=smtp');
    expect(() => systemOptionsFromEnv({ SYSTEM_MAIL_MODE: 'smtp', SYSTEM_DATABASE_PATH: ':memory:',
      SYSTEM_AUTH_SECRET: 'isolated-test-only-secret-long-enough', SYSTEM_BASE_URL: 'http://127.0.0.1:3001', SYSTEM_SMTP_FROM: 'test@example.invalid' })).toThrow('SYSTEM_SMTP_HOST');
    vi.stubEnv('NODE_ENV', 'production');
    await expect(createSystemRuntime({ databasePath: ':memory:', secret: 'isolated-test-only-secret-long-enough',
      baseUrl: 'https://studio.example.invalid', mailer: new MemorySystemMailer(), testMode: true })).rejects.toThrow('enabled rate limiting');
    await expect(buildLocalAcceptanceApp({ enabled: '1' })).rejects.toThrow('forbidden in production');
  });

  it('requires the exact opt-in and new temporary test data', async () => {
    await expect(buildLocalAcceptanceApp({ enabled: undefined })).rejects.toThrow('SYSTEM_LOCAL_TEST=1');
    await expect(buildLocalAcceptanceApp({ enabled: 'true' })).rejects.toThrow('SYSTEM_LOCAL_TEST=1');
    await expect(buildLocalAcceptanceApp({ enabled: '1', directory: '/workspace/data' })).rejects.toThrow('dedicated');
    await expect(buildLocalAcceptanceApp({ enabled: '1', port: 80 })).rejects.toThrow('port');
    const directory = mkdtempSync(path.join(tmpdir(), 'aistudio-local-acceptance-existing-'));
    try {
      writeFileSync(path.join(directory, 'unrelated.txt'), 'must remain');
      await expect(buildLocalAcceptanceApp({ enabled: '1', directory })).rejects.toThrow('new, empty');
      expect(readFileSync(path.join(directory, 'unrelated.txt'), 'utf8')).toBe('must remain');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('offers a bounded read-only test mailbox solely to loopback and the private marker', async () => {
    const local = await buildLocalAcceptanceApp({ enabled: '1' });
    const access = JSON.parse(readFileSync(local.markerPath, 'utf8')) as { marker: string };
    const headers = { host: new URL(local.baseUrl).host, origin: local.baseUrl };
    try {
      expect(statSync(local.markerPath).mode & 0o777).toBe(0o600);
      expect((await local.app.inject({ method: 'GET', url: '/__local-test/mailbox?email=test@example.invalid', headers })).statusCode).toBe(401);
      expect((await local.app.inject({ method: 'GET', url: '/__local-test/mailbox?email=test@example.invalid', headers: { ...headers, 'x-local-test-marker': 'wrong' } })).statusCode).toBe(401);
      const markerHeaders = { ...headers, 'x-local-test-marker': access.marker };
      const mailbox = await local.app.inject({ method: 'GET', url: '/__local-test/mailbox?email=test@example.invalid', headers: markerHeaders });
      expect(mailbox.json()).toEqual({ data: [], total: 0 });
      expect(mailbox.headers['cache-control']).toBe('no-store');
      expect((await local.app.inject({ method: 'GET', url: '/__local-test/mailbox?email=test@example.invalid', headers: markerHeaders, remoteAddress: '198.51.100.1' })).statusCode).toBe(403);
      expect((await local.app.inject({ method: 'GET', url: '/__local-test/mailbox?email=test@example.invalid', headers: { ...markerHeaders, host: 'rebinding.example.invalid:3001' } })).statusCode).toBe(403);
      expect((await local.app.inject({ method: 'GET', url: '/__local-test/mailbox?email=test@example.invalid', headers: { ...markerHeaders, origin: 'https://evil.invalid' } })).statusCode).toBe(403);
      expect((await local.app.inject({ method: 'GET', url: '/__local-test/mailbox?email=real@example.com', headers: markerHeaders })).statusCode).toBe(400);
      expect((await local.app.inject({ method: 'POST', url: '/__local-test/mailbox', headers: markerHeaders, payload: {} })).statusCode).toBe(404);
      const signup = await local.app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers,
        payload: { email: 'real@example.com', name: 'Rejected', password: 'not-a-production-password' } });
      expect(signup.statusCode).toBe(400);
      expect(signup.json().code).toBe('RESERVED_TEST_EMAIL_REQUIRED');
      expect((await local.app.inject({ method: 'GET', url: '/health', headers })).json()).toMatchObject({ channelsEnabled: false });
    } finally { await local.app.close(); rmSync(local.directory, { recursive: true, force: true }); }
  });

  it('completes signup, fake mail verification, offline first-admin grant, codes and explicit sharing', async () => {
    const local = await buildLocalAcceptanceApp({ enabled: '1' });
    const marker = JSON.parse(readFileSync(local.markerPath, 'utf8')).marker as string;
    const headers = { host: new URL(local.baseUrl).host, origin: local.baseUrl };
    const email = 'admin@example.invalid';
    const password = 'Local-Acceptance-Password-Only';
    try {
      const signup = await local.app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers, payload: { email, name: 'Local admin', password } });
      expect(signup.statusCode, signup.body).toBe(200);
      expect(signup.json()).not.toHaveProperty('token');
      const id = signup.json().user.id as string;
      const earlyLogin = await local.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email, password } });
      expect(earlyLogin.statusCode).toBe(403);
      expect(() => grantFirstSuperadminOffline({ databasePath: local.databasePath, email, confirmation: 'GRANT_FIRST_SUPERADMIN' })).toThrow('verified enabled');
      const mailbox = await local.app.inject({ method: 'GET', url: `/__local-test/mailbox?email=${email}`, headers: { ...headers, 'x-local-test-marker': marker } });
      const verification = new URL(mailbox.json().data[0].url);
      expect((await local.app.inject({ method: 'GET', url: verification.pathname + verification.search, headers })).statusCode).toBe(302);
      expect(grantFirstSuperadminOffline({ databasePath: local.databasePath, email, confirmation: 'GRANT_FIRST_SUPERADMIN' })).toMatchObject({ id, role: 'superadmin' });
      const login = await local.app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers, payload: { email, password } });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = login.cookies.map(value => `${value.name}=${value.value}`).join('; ');
      const authenticated = { ...headers, cookie };
      const identity = await local.app.inject({ method: 'GET', url: '/api/system/me', headers: authenticated });
      expect(identity.json()).toMatchObject({ role: 'superadmin', everActivated: false, cloudEligible: false, sharingEnabled: false });
      const codes = await local.app.inject({ method: 'POST', url: '/api/admin/activation-codes', headers: authenticated, payload: {} });
      expect(codes.statusCode, codes.body).toBe(201);
      const created = codes.json().data[0];
      expect(created.validityDays).toBe(365);
      const activated = await local.app.inject({ method: 'POST', url: '/api/system/activate', headers: authenticated, payload: { code: created.code } });
      expect(activated.statusCode, activated.body).toBe(200);
      expect(activated.json().identity).toMatchObject({ everActivated: true, cloudEligible: true, sharingEnabled: false });
      const sharing = await local.app.inject({ method: 'PUT', url: `/api/admin/sharing-whitelist/${id}`, headers: authenticated, payload: {} });
      expect(sharing.statusCode).toBe(200);
      expect((await local.app.inject({ method: 'GET', url: '/api/system/me', headers: authenticated })).json().sharingEnabled).toBe(true);
    } finally { await local.app.close(); rmSync(local.directory, { recursive: true, force: true }); }
  });
});
