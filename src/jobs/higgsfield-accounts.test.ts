import { describe, expect, it } from 'vitest';
import {
  formatHiggsfieldAccount,
  higgsfieldAccountId,
  parseHiggsfieldAccounts
} from './higgsfield-accounts.js';

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  return `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

const access = jwt({ sub: 'user_aaa', email: 'a@example.com', exp: 2_000_000_000 });

function line(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ clientId: 'client_a', refreshToken: 'rt_a', ...overrides });
}

describe('parseHiggsfieldAccounts', () => {
  it('reads one JSON credential per line, ignoring blanks and comments', () => {
    const parsed = parseHiggsfieldAccounts([
      '# added 2026-09-22',
      line({ id: 'higgsfield-user_aaa', email: 'a@example.com' }),
      '',
      line({ id: 'higgsfield-user_bbb', clientId: 'client_b', refreshToken: 'rt_b' })
    ].join('\n'));

    expect(parsed.invalid).toEqual([]);
    expect(parsed.accounts).toEqual([
      {
        line: 2,
        sessionId: 'higgsfield-user_aaa',
        email: 'a@example.com',
        tokens: { clientId: 'client_a', refreshToken: 'rt_a' }
      },
      {
        line: 4,
        sessionId: 'higgsfield-user_bbb',
        tokens: { clientId: 'client_b', refreshToken: 'rt_b' }
      }
    ]);
  });

  // 身份只在 id token 里：access token 是不透明串，什么都读不出来。
  it('derives the account id from the id token when the line carries none', () => {
    const parsed = parseHiggsfieldAccounts(line({ idToken: access, accessToken: 'opaque' }));
    expect(parsed.accounts[0]).toMatchObject({
      sessionId: 'higgsfield-user_aaa',
      email: 'a@example.com'
    });
  });

  it('keeps the first line naming an account and reports the rest as duplicates', () => {
    const parsed = parseHiggsfieldAccounts([
      line({ id: 'higgsfield-user_aaa' }),
      line({ id: 'higgsfield-user_aaa', refreshToken: 'rt_newer' })
    ].join('\n'));

    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0]!.tokens.refreshToken).toBe('rt_a');
    expect(parsed.duplicates).toEqual([{ sessionId: 'higgsfield-user_aaa', line: 2 }]);
  });

  it('names the remedy for a credential from the old gateway path', () => {
    for (const legacy of [`__client=${access}`, `client:${access}`, access]) {
      const parsed = parseHiggsfieldAccounts(legacy);
      expect(parsed.accounts).toEqual([]);
      expect(parsed.invalid[0]!.reason).toMatch(/higgsfield:login/);
    }
  });

  it('reports a line that is not JSON, and one that is missing a credential', () => {
    const parsed = parseHiggsfieldAccounts(['not json at all', JSON.stringify({ clientId: 'client_a' })].join('\n'));
    expect(parsed.accounts).toEqual([]);
    expect(parsed.invalid).toEqual([
      { line: 1, reason: expect.stringContaining('JSON object') },
      { line: 2, reason: expect.stringContaining('refreshToken') }
    ]);
  });

  it('takes an account with only an access token, which lapses within the day', () => {
    const parsed = parseHiggsfieldAccounts(JSON.stringify({ clientId: 'client_a', accessToken: access }));
    expect(parsed.accounts[0]!.tokens).toEqual({ clientId: 'client_a', accessToken: access });
  });
});

describe('higgsfieldAccountId', () => {
  it('names the platform user when it knows it', () => {
    expect(higgsfieldAccountId({ userId: 'user_aaa', clientId: 'client_a' })).toBe('higgsfield-user_aaa');
    expect(higgsfieldAccountId({ email: 'a@example.com', clientId: 'client_a' })).toBe('higgsfield-a@example.com');
  });

  it('falls back to a stable hash of the client, so the id never depends on a network call', () => {
    const id = higgsfieldAccountId({ clientId: 'client_a' });
    expect(id).toMatch(/^higgsfield-[0-9a-f]{12}$/);
    expect(higgsfieldAccountId({ clientId: 'client_a' })).toBe(id);
  });
});

describe('formatHiggsfieldAccount', () => {
  it('writes a line this parser reads back unchanged', () => {
    const written = formatHiggsfieldAccount({
      id: 'higgsfield-user_aaa',
      email: 'a@example.com',
      tokens: { clientId: 'client_a', refreshToken: 'rt_a', accessToken: access, expiresAt: 123 }
    });
    const parsed = parseHiggsfieldAccounts(written);
    expect(parsed.accounts[0]).toMatchObject({
      sessionId: 'higgsfield-user_aaa',
      email: 'a@example.com',
      tokens: { clientId: 'client_a', refreshToken: 'rt_a', accessToken: access, expiresAt: 123 }
    });
  });
});
