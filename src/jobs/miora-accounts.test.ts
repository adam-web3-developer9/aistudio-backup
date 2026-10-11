import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MioraApiError, type MioraTokens } from '../adapters/miora-api.js';
import { MioraAccountPruner, MioraCredentials, formatMioraAccount, parseMioraAccounts, persistMioraRenewal } from './miora-accounts.js';

function makeToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.AAAA`;
}

const now = Math.floor(Date.now() / 1000);
const scopedToken = makeToken({ sub: 'user-1', iat: now, exp: now + 15 * 86400, scopes: ['*'] });
const refreshToken = `def50200${'a'.repeat(90)}`;

describe('low-balance account cleanup', () => {
  it('preserves comments and malformed lines while removing concurrent accounts and duplicates', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'miora-prune-'));
    try {
      const file = path.join(dir, 'accounts.txt');
      const tokens = { authToken: scopedToken, refreshToken };
      const first = formatMioraAccount({ id: 'first', tokens });
      const second = formatMioraAccount({ id: 'second', tokens });
      const kept = '# note\r\ninvalid line\r\n' + formatMioraAccount({ id: 'kept', tokens }) + '\r\n';
      await writeFile(file, kept + first + '\r\n' + first + '\r\n' + second + '\r\n');
      const pruner = new MioraAccountPruner(file);
      expect(await Promise.all([pruner.remove('first', tokens), pruner.remove('second', tokens)]))
        .toEqual([true, true]);
      expect(await readFile(file, 'utf8')).toBe(kept);
      expect(await pruner.remove('first', tokens)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not remove credentials replaced after the balance read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'miora-prune-changed-'));
    try {
      const file = path.join(dir, 'accounts.txt');
      const current = formatMioraAccount({ id: 'first', tokens: { authToken: scopedToken, refreshToken, cookie: 'new=1' } });
      await writeFile(file, current);
      expect(await new MioraAccountPruner(file).remove('first', { authToken: scopedToken, refreshToken, cookie: 'old=1' })).toBe(false);
      expect(await readFile(file, 'utf8')).toBe(current);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serializes cleanup with another account renewal without losing the renewed tokens', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'miora-prune-renew-'));
    try {
      const file = path.join(dir, 'accounts.txt');
      const tokens = { authToken: scopedToken, refreshToken };
      const renewed = { authToken: makeToken({ sub: 'user-2', exp: now + 20 * 86400 }), refreshToken };
      await writeFile(file, formatMioraAccount({ id: 'low', tokens }) + '\n'
        + formatMioraAccount({ id: 'renewed', tokens }) + '\n');
      expect(await Promise.all([
        new MioraAccountPruner(file).remove('low', tokens),
        persistMioraRenewal(file, 'renewed', tokens, renewed)
      ])).toEqual([true, true]);
      expect(parseMioraAccounts(await readFile(file, 'utf8')).accounts)
        .toMatchObject([{ sessionId: 'renewed', tokens: renewed }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('parseMioraAccounts', () => {
  it('parses a JSON line with both tokens', () => {
    const { accounts, invalid } = parseMioraAccounts(
      JSON.stringify({ authToken: scopedToken, refreshToken, email: 'a@b.com' })
    );
    expect(invalid).toEqual([]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      sessionId: 'miora-user-1',
      email: 'a@b.com',
      scoped: true,
      tokens: { authToken: scopedToken, refreshToken }
    });
  });

  it('accepts a bare authToken and an authToken----refreshToken line', () => {
    const bare = parseMioraAccounts(scopedToken);
    expect(bare.accounts[0]!.tokens).toEqual({ authToken: scopedToken });

    const paired = parseMioraAccounts(`备注----${scopedToken}----${refreshToken}`);
    expect(paired.accounts[0]!.tokens).toEqual({ authToken: scopedToken, refreshToken });
  });

  it('flags a scopeless token as unscoped but still parses it', () => {
    const { accounts } = parseMioraAccounts(
      JSON.stringify({ authToken: makeToken({ sub: 'user-2', scopes: [] }) })
    );
    expect(accounts[0]!.scoped).toBe(false);
  });

  it('skips comments, blanks, duplicates and junk', () => {
    const { accounts, duplicates, invalid } = parseMioraAccounts(
      ['# comment', '', scopedToken, scopedToken, 'not-a-token'].join('\n')
    );
    expect(accounts).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(invalid).toHaveLength(1);
  });

  it('round-trips through formatMioraAccount', () => {
    const line = formatMioraAccount({ id: 'miora-user-1', email: 'a@b.com', tokens: { authToken: scopedToken, refreshToken } });
    const { accounts } = parseMioraAccounts(line);
    expect(accounts[0]).toMatchObject({ sessionId: 'miora-user-1', email: 'a@b.com', scoped: true });
  });
});

describe('MioraCredentials', () => {
  it('renews a near-expiry token on resolve', async () => {
    const nearExpiry = makeToken({ sub: 'user-3', iat: now - 15 * 86400, exp: now + 60, scopes: ['*'] });
    const renewed: MioraTokens = { authToken: scopedToken, refreshToken: 'def50200-new' };
    const credentials = new MioraCredentials({ refresh: async (tokens) => ({ ...renewed, cookie: tokens.cookie }) });

    const { accounts, failures } = await credentials.resolve(
      parseMioraAccounts(JSON.stringify({ authToken: nearExpiry, refreshToken }))
    );
    expect(failures).toEqual([]);
    expect(accounts[0]!.tokens).toEqual(renewed);
  });

  it('uses a scopeless token as configured when it is not near expiry', async () => {
    const scopeless = makeToken({ sub: 'user-4', iat: now, exp: now + 15 * 86400, scopes: [] });
    let called = 0;
    const credentials = new MioraCredentials({
      refresh: async () => {
        called += 1;
        return { authToken: scopedToken, refreshToken };
      }
    });
    const { accounts } = await credentials.resolve(parseMioraAccounts(JSON.stringify({ authToken: scopeless, refreshToken })));
    expect(called).toBe(0);
    expect(accounts[0]!.tokens.authToken).toBe(scopeless);
  });

  it('keeps the configured token when renewal fails', async () => {
    const nearExpiry = makeToken({ sub: 'user-5', iat: now - 15 * 86400, exp: now + 60, scopes: [] });
    const credentials = new MioraCredentials({
      refresh: async () => {
        throw new Error('refresh token dead');
      }
    });
    const { accounts, failures } = await credentials.resolve(
      parseMioraAccounts(JSON.stringify({ authToken: nearExpiry, refreshToken }))
    );
    expect(failures).toHaveLength(1);
    expect(accounts[0]!.tokens.authToken).toBe(nearExpiry);
  });

  it('does not try to renew a token with no refresh token', async () => {
    const credentials = new MioraCredentials({
      refresh: async () => {
        throw new Error('should not be called');
      }
    });
    const { accounts, failures } = await credentials.resolve(parseMioraAccounts(scopedToken));
    expect(failures).toEqual([]);
    expect(accounts[0]!.tokens).toEqual({ authToken: scopedToken });
  });
});

describe('expired credential cleanup', () => {
  const dead = () => new MioraApiError(400, 'REFRESH_TOKEN_DEAD', '无效的刷新令牌或令牌已过期', '/api/auth/refresh-token');
  const expired = makeToken({ sub: 'expired', iat: now - 15 * 86400, exp: now - 60 });

  it('removes only expired irrecoverable credentials at startup using the existing safe pruner', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'miora-expired-'));
    try {
      const file = path.join(dir, 'accounts.txt');
      const rows = [
        { id: 'dead', tokens: { authToken: expired, refreshToken } },
        { id: 'no-refresh', tokens: { authToken: expired } },
        { id: 'temporary', tokens: { authToken: expired, refreshToken: 'temporary' } },
        { id: 'valid', tokens: { authToken: scopedToken, refreshToken } }
      ];
      await writeFile(file, rows.map(formatMioraAccount).join('\n'));
      const pruner = new MioraAccountPruner(file);
      const cleanup = vi.fn((id: string, tokens: MioraTokens, _reason: 'NO_REFRESH_TOKEN' | 'REFRESH_TOKEN_DEAD') => pruner.remove(id, tokens));
      const credentials = new MioraCredentials({
        onExpired: cleanup,
        refresh: async (tokens) => { throw tokens.refreshToken === 'temporary' ? new TypeError('fetch failed') : dead(); }
      });
      const result = await credentials.resolve(parseMioraAccounts(await readFile(file, 'utf8')));
      expect(result.removed).toEqual(['dead', 'no-refresh']);
      expect(result.accounts.map(a => a.sessionId)).toEqual(['temporary', 'valid']);
      expect(result.failures).toHaveLength(1);
      expect(parseMioraAccounts(await readFile(file, 'utf8')).accounts.map(a => a.sessionId)).toEqual(['temporary', 'valid']);
      expect(cleanup.mock.calls.map(call => call[2])).toEqual(['REFRESH_TOKEN_DEAD', 'NO_REFRESH_TOKEN']);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('keeps a rejected credential until expiry and clears it during the periodic check', async () => {
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now * 1000);
      const near = makeToken({ sub: 'near', iat: now - 15 * 86400, exp: now + 60 });
      const cleanup = vi.fn(async () => true);
      const credentials = new MioraCredentials({ onExpired: cleanup, refresh: async () => { throw dead(); } });
      const parsed = parseMioraAccounts([
        formatMioraAccount({ id: 'near', tokens: { authToken: near, refreshToken } }),
        formatMioraAccount({ id: 'no-refresh', tokens: { authToken: near } })
      ].join('\n'));
      expect((await credentials.resolve(parsed)).accounts).toHaveLength(2);
      expect(cleanup).not.toHaveBeenCalled();
      clock.mockReturnValue((now + 61) * 1000);
      expect((await credentials.refresh()).removed).toEqual(['near', 'no-refresh']);
      expect((await credentials.refresh()).removed).toEqual([]);
      expect(cleanup).toHaveBeenCalledTimes(2);
    } finally { clock.mockRestore(); }
  });

  it('preserves the credential when safe removal fails and retries cleanup later', async () => {
    const cleanup = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const credentials = new MioraCredentials({ onExpired: cleanup, refresh: async () => { throw dead(); } });
    const parsed = parseMioraAccounts(formatMioraAccount({ id: 'expired', tokens: { authToken: expired, refreshToken } }));
    expect((await credentials.resolve(parsed)).accounts).toHaveLength(1);
    expect((await credentials.refresh()).removed).toEqual(['expired']);
  });

  it.each(['resolve', 'refresh'] as const)('does not prune newer credentials when an old %s is rejected', async (check) => {
    const clock = vi.spyOn(Date, 'now');
    try {
      clock.mockReturnValue(now * 1000);
      let reject!: (error: Error) => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const cleanup = vi.fn(async () => true);
      const old = { authToken: scopedToken, refreshToken };
      const credentials = new MioraCredentials({ onExpired: cleanup,
        refresh: () => { entered(); return new Promise((_resolve, fail) => { reject = fail; }); } });
      const parsed = parseMioraAccounts(formatMioraAccount({ id: 'same', tokens: old }));
      await credentials.resolve(parsed);
      clock.mockReturnValue((now + 16 * 86400) * 1000);
      const pending = check === 'resolve' ? credentials.resolve(parsed) : credentials.refresh();
      await started;
      const newer = { authToken: makeToken({ sub: 'user-1', iat: now + 16 * 86400, exp: now + 30 * 86400 }), refreshToken: 'new-refresh' };
      credentials.acceptRenewal('same', old, newer);
      reject(dead());
      expect((await pending).removed).toEqual([]);
      expect(cleanup).not.toHaveBeenCalled();
      expect((await credentials.resolve(parsed)).accounts[0]?.tokens).toEqual(newer);
    } finally { clock.mockRestore(); }
  });

  it('preserves a replacement installed while the cleanup file check returns false', async () => {
    const old = { authToken: expired, refreshToken };
    const newer = { authToken: scopedToken, refreshToken: 'replacement' };
    let cleanupStarted!: () => void;
    let finishCleanup!: (removed: boolean) => void;
    const started = new Promise<void>(resolve => { cleanupStarted = resolve; });
    const cleanup = vi.fn(async () => false);
    const credentials = new MioraCredentials({ onExpired: cleanup, refresh: async () => { throw dead(); } });
    const parsed = parseMioraAccounts(formatMioraAccount({ id: 'same', tokens: old }));
    await credentials.resolve(parsed);
    cleanup.mockImplementation(() => { cleanupStarted(); return new Promise<boolean>(resolve => { finishCleanup = resolve; }); });
    const pending = credentials.resolve(parsed);
    await started;
    credentials.acceptRenewal('same', old, newer);
    finishCleanup(false);
    expect((await pending).accounts[0]?.tokens).toEqual(newer);
    expect((await credentials.resolve(parsed)).accounts[0]?.tokens).toEqual(newer);
  });
});


describe('renewed account persistence', () => {
  it('writes the rotated pair without losing another account or comments', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'miora-renewal-'));
    const file = path.join(dir, 'accounts.txt');
    const newer = makeToken({ sub: 'user-1', iat: now + 1, exp: now + 16 * 86400 });
    const another = makeToken({ sub: 'user-2', iat: now, exp: now + 15 * 86400 });
    const rotated = 'def50200' + 'b'.repeat(90);
    try {
      await writeFile(file, '# note\n' + JSON.stringify({ id: 'miora-user-1', authToken: scopedToken, refreshToken, cookie: 'risk=1' }) + '\n' + another + '\n');
      expect(await persistMioraRenewal(file, 'miora-user-1', { authToken: scopedToken, refreshToken }, {
        authToken: newer, refreshToken: rotated, cookie: 'risk=1'
      })).toBe(true);
      const saved = await readFile(file, 'utf8');
      expect(saved.startsWith('# note\n')).toBe(true);
      expect(saved.endsWith(another + '\n')).toBe(true);
      expect(parseMioraAccounts(saved).accounts[0]!.tokens).toMatchObject({ authToken: newer, refreshToken: rotated });
      expect(await persistMioraRenewal(file, 'miora-user-1', { authToken: scopedToken, refreshToken }, {
        authToken: 'obsolete', refreshToken: 'obsolete'
      })).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps an on-demand renewal across a watcher reload, but accepts a user edit', async () => {
    const credentials = new MioraCredentials();
    const line = JSON.stringify({ id: 'miora-user-1', authToken: scopedToken, refreshToken });
    await credentials.resolve(parseMioraAccounts(line));
    const newer = makeToken({ sub: 'user-1', iat: now + 1, exp: now + 16 * 86400 });
    const rotated = { authToken: newer, refreshToken: 'def50200' + 'b'.repeat(90) };
    expect(credentials.acceptRenewal('miora-user-1', { authToken: scopedToken, refreshToken }, rotated)?.tokens).toEqual(rotated);
    expect((await credentials.resolve(parseMioraAccounts(line))).accounts[0]!.tokens).toEqual(rotated);
    const edited = JSON.stringify({ id: 'miora-user-1', authToken: scopedToken, refreshToken: 'def50200' + 'c'.repeat(90) });
    expect((await credentials.resolve(parseMioraAccounts(edited))).accounts[0]!.tokens.refreshToken).toBe('def50200' + 'c'.repeat(90));
  });
});
