import { describe, expect, it, vi } from 'vitest';
import { DreamMakerCredentials, parseDreamMakerAccounts } from './dreammaker-accounts.js';

const ORIGIN = 'https://dreammaker.vobile.com.cn';

function jwt(sub: string, expiresInMs = 7 * 24 * 60 * 60_000, lifetimeMs = expiresInMs): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = Math.floor((Date.now() + expiresInMs) / 1000);
  const payload = Buffer.from(JSON.stringify({
    sub,
    iat: exp - Math.floor(lifetimeMs / 1000),
    exp
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

/** What `/api/auth/login` actually hands out: about 16 hours, not a week. */
const LOGIN_TOKEN_LIFETIME_MS = 16 * 60 * 60_000;

describe('parseDreamMakerAccounts', () => {
  it('reads both an access token and username:password, ignoring comments', () => {
    const token = jwt('21574');
    const parsed = parseDreamMakerAccounts(`# accounts\n\n${token}\n17012345678:secret\n`);

    expect(parsed.accounts).toEqual([
      { line: 3, key: 'dreammaker-21574', token },
      { line: 4, key: 'user:17012345678', username: '17012345678', password: 'secret' }
    ]);
    expect(parsed.invalid).toEqual([]);
  });

  it('accepts the ---- separator these account lists are usually pasted with', () => {
    const parsed = parseDreamMakerAccounts('13316786433----Qq147258\n18169957739----Qq147258\n');
    expect(parsed.accounts).toEqual([
      { line: 1, key: 'user:13316786433', username: '13316786433', password: 'Qq147258' },
      { line: 2, key: 'user:18169957739', username: '18169957739', password: 'Qq147258' }
    ]);
    expect(parsed.invalid).toEqual([]);
  });

  it('keeps a password that contains the other separator intact', () => {
    expect(parseDreamMakerAccounts('user:a:b:c\n').accounts[0])
      .toMatchObject({ username: 'user', password: 'a:b:c' });
    // `----` wins, so a colon in the password is not a split point.
    expect(parseDreamMakerAccounts('user----pa:ss\n').accounts[0])
      .toMatchObject({ username: 'user', password: 'pa:ss' });
    expect(parseDreamMakerAccounts('user----a----b\n').accounts[0])
      .toMatchObject({ username: 'user', password: 'a----b' });
  });

  it('reports a line that is neither shape', () => {
    const parsed = parseDreamMakerAccounts('not-a-token\n:no-username\nuser:\n----nope\nuser----\n');
    expect(parsed.accounts).toEqual([]);
    expect(parsed.invalid.map((entry) => entry.line)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps the first line naming an account and reports the rest as duplicates', () => {
    const parsed = parseDreamMakerAccounts(`${jwt('7')}\n${jwt('7', 1000)}\nu:p\nu:other\n`);
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.duplicates).toEqual([
      { key: 'dreammaker-7', line: 2 },
      { key: 'user:u', line: 4 }
    ]);
  });
});

describe('DreamMakerCredentials', () => {
  it('takes token lines as they stand and logs password lines in', async () => {
    const token = jwt('1');
    const login = vi.fn().mockResolvedValue(jwt('2'));
    const credentials = new DreamMakerCredentials(ORIGIN, { login });

    const { accounts, failures } = await credentials.resolve(
      parseDreamMakerAccounts(`${token}\nuser:secret\n`)
    );

    expect(failures).toEqual([]);
    expect(accounts.map((account) => ({ sessionId: account.sessionId, source: account.source }))).toEqual([
      { sessionId: 'dreammaker-1', source: 'token' },
      { sessionId: 'dreammaker-2', source: 'password' }
    ]);
    expect(login).toHaveBeenCalledWith(ORIGIN, { username: 'user', password: 'secret' });
  });

  it('reuses a token it already holds instead of logging in on every reload', async () => {
    const login = vi.fn().mockResolvedValue(jwt('2'));
    const credentials = new DreamMakerCredentials(ORIGIN, { login });
    const parsed = parseDreamMakerAccounts('user:secret\n');

    await credentials.resolve(parsed);
    await credentials.resolve(parsed);

    expect(login).toHaveBeenCalledOnce();
  });

  it('logs in again when the password changed', async () => {
    const login = vi.fn().mockResolvedValue(jwt('2'));
    const credentials = new DreamMakerCredentials(ORIGIN, { login });

    await credentials.resolve(parseDreamMakerAccounts('user:old\n'));
    await credentials.resolve(parseDreamMakerAccounts('user:new\n'));

    expect(login).toHaveBeenCalledTimes(2);
    expect(login.mock.calls[1]?.[1]).toEqual({ username: 'user', password: 'new' });
  });

  it('lets the other accounts through when one cannot log in', async () => {
    const token = jwt('1');
    const login = vi.fn().mockRejectedValue(new Error('401 wrong password'));
    const credentials = new DreamMakerCredentials(ORIGIN, { login });

    const { accounts, failures } = await credentials.resolve(
      parseDreamMakerAccounts(`${token}\nuser:secret\n`)
    );

    expect(accounts.map((account) => account.sessionId)).toEqual(['dreammaker-1']);
    expect(failures).toEqual([{ line: 2, username: 'user', message: '401 wrong password' }]);
  });

  it('renews a password token that is about to lapse, and leaves a fresh one alone', async () => {
    // A week-long token with a minute left on it.
    const login = vi.fn()
      .mockResolvedValueOnce(jwt('2', 60_000, 7 * 24 * 60 * 60_000))
      .mockResolvedValueOnce(jwt('2'));
    const credentials = new DreamMakerCredentials(ORIGIN, { login, refreshBeforeMs: 24 * 60 * 60_000 });

    await credentials.resolve(parseDreamMakerAccounts('user:secret\n'));
    const renewed = await credentials.refresh();
    expect(renewed.accounts.map((account) => account.sessionId)).toEqual(['dreammaker-2']);

    // Now the held token is a week out: nothing to do.
    expect((await credentials.refresh()).accounts).toEqual([]);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('does not re-login on every tick for the short tokens password login hands out', async () => {
    // `/api/auth/login` issues ~16h tokens; a flat "under 24h remaining" window
    // would renew every single check. A fresh one has to be left alone.
    const fresh = jwt('2', LOGIN_TOKEN_LIFETIME_MS, LOGIN_TOKEN_LIFETIME_MS);
    const login = vi.fn().mockResolvedValue(fresh);
    const credentials = new DreamMakerCredentials(ORIGIN, { login, refreshBeforeMs: 24 * 60 * 60_000 });

    await credentials.resolve(parseDreamMakerAccounts('13316786433----Qq147258\n'));
    expect((await credentials.refresh()).accounts).toEqual([]);
    expect((await credentials.refresh()).accounts).toEqual([]);
    expect(login).toHaveBeenCalledOnce();
  });

  it('renews a short token once it is down to its last hours', async () => {
    const login = vi.fn()
      // Issued for 16 hours, one hour left.
      .mockResolvedValueOnce(jwt('2', 60 * 60_000, LOGIN_TOKEN_LIFETIME_MS))
      .mockResolvedValueOnce(jwt('2', LOGIN_TOKEN_LIFETIME_MS, LOGIN_TOKEN_LIFETIME_MS));
    const credentials = new DreamMakerCredentials(ORIGIN, { login, refreshBeforeMs: 24 * 60 * 60_000 });

    await credentials.resolve(parseDreamMakerAccounts('13316786433----Qq147258\n'));
    expect((await credentials.refresh()).accounts.map((a) => a.sessionId)).toEqual(['dreammaker-2']);
    expect((await credentials.refresh()).accounts).toEqual([]);
    expect(login).toHaveBeenCalledTimes(2);
  });

  it('forgets the password of an account removed from the file', async () => {
    const login = vi.fn().mockResolvedValue(jwt('2'));
    const credentials = new DreamMakerCredentials(ORIGIN, { login });

    await credentials.resolve(parseDreamMakerAccounts('user:secret\n'));
    await credentials.resolve(parseDreamMakerAccounts('# nobody\n'));

    expect((await credentials.refresh()).accounts).toEqual([]);
  });
});
