import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { buildSystemWebApp } from './web-app.js';
import { MemorySystemMailer } from './mail.js';

test('real authenticated project writes exceed old minute budgets while origin, session, ACL and hashes stay enforced', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'system-no-business-budget-'));
  const origin = 'http://127.0.0.1:3001', mailer = new MemorySystemMailer();
  const state = await buildSystemWebApp({ databasePath: path.join(directory, 'system.sqlite'), mediaDirectory: path.join(directory, 'media'),
    secret: 'isolated-business-budget-test-secret-long-enough', baseUrl: origin, mailer, testMode: true });
  const { app, runtime } = state;
  try {
    const register = async (name: string) => {
      const email = `${name}@example.invalid`, password = 'isolated-budget-password';
      const signup = await app.inject({ method: 'POST', url: '/api/auth/sign-up/email', headers: { origin }, payload: { name, email, password } });
      expect(signup.statusCode, signup.body).toBe(200);
      const verification = new URL(mailer.messages.find(message => message.to === email)!.url);
      expect((await app.inject({ url: verification.pathname + verification.search })).statusCode).toBe(302);
      const login = await app.inject({ method: 'POST', url: '/api/auth/sign-in/email', headers: { origin }, payload: { email, password } });
      expect(login.statusCode, login.body).toBe(200);
      const id = signup.json().user.id as string;
      runtime.db.prepare('UPDATE system_accounts SET ever_activated=1,sharing_eligible=1,valid_until=? WHERE user_id=?').run(new Date(Date.now() + 86400000).toISOString(), id);
      return { id, cookie: login.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') };
    };
    const owner = await register('budget-owner'), outsider = await register('budget-outsider');
    const headers = { origin, cookie: owner.cookie };
    const share = await app.inject({ method: 'POST', url: '/api/system/projects/project/share', headers,
      payload: { snapshot: { entities: [{ type: 'asset', id: 'asset', fields: { label: 0 } }], collections: {} }, members: [] } });
    expect(share.statusCode, share.body).toBe(200);
    const bytes = Buffer.from([137,80,78,71,13,10,26,10]), hash = createHash('sha256').update(bytes).digest('hex');
    const payload = { generation: 1, entity: { type: 'asset', id: 'asset' }, hash, size: bytes.length, mime: 'image/png', data: bytes.toString('base64') };
    for (let index = 0; index < 13; index++) {
      const response = await app.inject({ method: 'POST', url: '/api/system/projects/project/media', headers, payload });
      expect(response.statusCode, response.body).toBe(200);expect(response.headers['cache-control']).toBe('no-store');expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
    for (let index = 1; index <= 121; index++) {
      const response = await app.inject({ method: 'POST', url: '/api/system/projects/project/commands', headers,
        payload: { commandId: `budget-command-${index}`, generation: 1, operations: [{ kind: 'update', type: 'asset', id: 'asset', set: { label: index }, expected: { label: index - 1 } }] } });
      expect(response.statusCode, response.body).toBe(200);
    }
    const snapshot = await app.inject({ url: '/api/system/projects/project/snapshot', headers });expect(snapshot.statusCode).toBe(200);expect(snapshot.json().entities[0].fields.label).toBe(121);
    const policy = await app.inject({ url: '/api/system/media-policy', headers });expect(policy.statusCode).toBe(200);
    expect(policy.json()).toMatchObject({ streaming: true, deprecatedQuotaPolicy: true, maxFileBytes: Number.MAX_SAFE_INTEGER });
    expect((await app.inject({ method: 'POST', url: '/api/system/projects/project/media', headers: { origin }, payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/system/projects/project/media', headers: { origin, cookie: outsider.cookie }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/system/projects/project/media', headers: { origin: 'https://untrusted.invalid', cookie: owner.cookie }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/system/projects/project/media', headers, payload: { ...payload, hash: '0'.repeat(64) } })).statusCode).toBe(400);
    runtime.db.prepare('DELETE FROM session WHERE userId=?').run(owner.id);
    expect((await app.inject({ method: 'POST', url: '/api/system/projects/project/media', headers, payload })).statusCode).toBe(401);
  } finally { await app.close(); await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
