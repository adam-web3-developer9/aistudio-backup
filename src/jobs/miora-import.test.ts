import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MioraAccountPruner, parseMioraAccounts } from './miora-accounts.js';
import { archiveMioraExports, importMioraExports, mergeMioraAccounts, mioraAccountFromExport } from './miora-import.js';

function makeToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.AAAA`;
}

const now = Math.floor(Date.now() / 1000);
const older = makeToken({ sub: 'user-1', iat: now - 3 * 86400, exp: now + 12 * 86400, scopes: ['*'] });
const newer = makeToken({ sub: 'user-1', iat: now, exp: now + 15 * 86400, scopes: [] });
const other = makeToken({ sub: 'user-2', iat: now, exp: now + 15 * 86400 });
const refreshToken = `def50200${'a'.repeat(90)}`;

function siteState(authToken: string, extra: { cookieToken?: string; email?: string } = {}) {
  return {
    cookies: [
      { name: 'authToken', value: extra.cookieToken ?? authToken, domain: 'miora.design' },
      { name: 'TDID', value: 'risk', domain: '.miora.design' },
      { name: 'other', value: 'x', domain: 'example.com' }
    ],
    localStorage: {
      authToken,
      refreshToken,
      miora__user_info: JSON.stringify({ email: extra.email ?? 'a@b.com' })
    }
  };
}

describe('mioraAccountFromExport', () => {
  it('picks the newest token, not the scoped cookie copy, and keeps the miora cookies', () => {
    const account = mioraAccountFromExport(siteState(newer, { cookieToken: older }));
    expect(account).toEqual({
      id: 'miora-user-1',
      email: 'a@b.com',
      tokens: { authToken: newer, refreshToken, cookie: `authToken=${older}; TDID=risk` }
    });
  });

  it('returns undefined for a file with no authToken', () => {
    expect(mioraAccountFromExport({ cookies: [], localStorage: {} })).toBeUndefined();
  });
});

describe('removed account export archival', () => {
  it('archives the verified credential and older exports while retaining new replacements and unrelated files', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'miora-archive-'));
    try {
      const imports = path.join(dir, 'imports');
      const archive = path.join(dir, 'archive');
      await mkdir(imports);
      const latest = makeToken({ sub: 'user-1', iat: now + 1, exp: now + 16 * 86400 });
      const sameAccessNewRefresh = siteState(newer);
      sameAccessNewRefresh.localStorage.refreshToken = 'replacement-refresh';
      const contents = { 'verified.json': siteState(newer), 'older.json': siteState(older),
        'replacement.json': siteState(latest), 'rotated.json': sameAccessNewRefresh,
        'unrelated.json': siteState(other) };
      for (const [name, state] of Object.entries(contents)) await writeFile(path.join(imports, name), JSON.stringify(state));
      await writeFile(path.join(imports, 'malformed.json'), 'not-json');
      const expected = mioraAccountFromExport(siteState(newer))!;
      expect(await archiveMioraExports(imports, archive, expected.id, expected.tokens)).toBe(2);
      expect((await readdir(imports)).sort()).toEqual(['malformed.json', 'replacement.json', 'rotated.json', 'unrelated.json']);
      expect(await readdir(archive)).toHaveLength(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('shares the removal lock with re-import so cleaned exports cannot recreate the account', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'miora-archive-lock-'));
    try {
      const imports = path.join(dir, 'imports');
      const accountFile = path.join(dir, 'accounts.txt');
      await mkdir(imports);
      await writeFile(path.join(imports, 'account.json'), JSON.stringify(siteState(newer)));
      await importMioraExports(imports, accountFile);
      const expected = parseMioraAccounts(await readFile(accountFile, 'utf8')).accounts[0]!;
      const pruner = new MioraAccountPruner(accountFile, async (id, tokens) => {
        await archiveMioraExports(imports, path.join(dir, 'archive'), id, tokens);
      });
      const [removed] = await Promise.all([
        pruner.remove(expected.sessionId, expected.tokens), importMioraExports(imports, accountFile)
      ]);
      expect(removed).toBe(true);
      expect(parseMioraAccounts(await readFile(accountFile, 'utf8')).accounts).toEqual([]);
      expect(await readdir(imports)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('mergeMioraAccounts', () => {
  const account = (authToken: string, id = 'miora-user-1') => ({ id, email: 'a@b.com', tokens: { authToken, refreshToken } });

  it('appends new accounts and leaves the same token unchanged', () => {
    const first = mergeMioraAccounts('# comment', [account(newer)]);
    expect(first.results.map((r) => r.status)).toEqual(['added']);
    expect(first.contents.startsWith('# comment\n')).toBe(true);

    const again = mergeMioraAccounts(first.contents, [account(newer)]);
    expect(again.results.map((r) => r.status)).toEqual(['unchanged']);
    expect(again.contents).toBe(first.contents);
  });

  it('replaces a line only with a newer token', () => {
    const base = mergeMioraAccounts('', [account(older), account(other, 'miora-user-2')]).contents;

    const stale = mergeMioraAccounts(mergeMioraAccounts(base, [account(newer)]).contents, [account(older)]);
    expect(stale.results[0]!.status).toBe('stale');

    const updated = mergeMioraAccounts(base, [account(newer)]);
    expect(updated.results[0]!.status).toBe('updated');
    const parsed = parseMioraAccounts(updated.contents);
    expect(parsed.accounts).toHaveLength(2);
    expect(parsed.accounts[0]!.tokens.authToken).toBe(newer);
    expect(parsed.accounts[1]!.sessionId).toBe('miora-user-2');
  });

  it('fills in a cookie the line lacks for the same token', () => {
    const base = mergeMioraAccounts('', [account(newer)]).contents;
    const merged = mergeMioraAccounts(base, [{ ...account(newer), tokens: { authToken: newer, cookie: 'TDID=risk' } }]);
    expect(merged.results[0]!.status).toBe('updated');
    expect(parseMioraAccounts(merged.contents).accounts[0]!.tokens).toEqual({
      authToken: newer,
      refreshToken,
      cookie: 'TDID=risk'
    });
  });
});

describe('importMioraExports', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'miora-import-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('imports a directory, dedupes by account, and is a no-op on re-run', async () => {
    const imports = path.join(dir, 'imports');
    const accountFile = path.join(dir, 'accounts.txt');
    await mkdir(imports);
    await writeFile(path.join(imports, 'a-old.json'), JSON.stringify(siteState(older)));
    await writeFile(path.join(imports, 'b-new.json'), `﻿${JSON.stringify(siteState(newer))}`);
    await writeFile(path.join(imports, 'c-other.json'), JSON.stringify(siteState(other, { email: 'c@d.com' })));
    await writeFile(path.join(imports, 'junk.json'), '{not json');
    await writeFile(path.join(imports, 'notes.txt'), 'ignored');

    const first = await importMioraExports(imports, accountFile);
    expect(first.written).toBe(true);
    expect(first.skipped.map((s) => path.basename(s.file))).toEqual(['junk.json']);
    const parsed = parseMioraAccounts(await readFile(accountFile, 'utf8'));
    expect(parsed.accounts.map((a) => [a.sessionId, a.tokens.authToken])).toEqual([
      ['miora-user-1', newer],
      ['miora-user-2', other]
    ]);

    const second = await importMioraExports(imports, accountFile);
    expect(second.written).toBe(false);
    expect(second.results.map((r) => r.status)).toEqual(['stale', 'unchanged', 'unchanged']);
  });
});
