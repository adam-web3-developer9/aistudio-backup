import { createHash, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  mioraSessionId,
  tokenExpiresAt,
  tokenIssuedAt,
  type MioraTokens
} from '../adapters/miora-api.js';
import { formatMioraAccount, parseMioraAccounts, withMioraAccountFileEdit } from './miora-accounts.js';

/**
 * Turns Miora "site-state" exports (the JSON the browser saves with cookies +
 * localStorage for https://miora.design) into lines of the account file.
 *
 * The export carries the authToken in two places, and they are not the same
 * age: the site rotates the token and writes the fresh one to localStorage,
 * while the cookie copy can be older and already revoked server-side (a revoked
 * token still shows a future `exp`). So the newest token wins — by issued-at,
 * then expiry — regardless of its `scopes` (an empty array still generates).
 *
 * Merging is idempotent: an account already in the file is only replaced by a
 * newer token, so re-scanning an old export never undoes a renewal the gateway
 * has since written back.
 */

export interface MioraImportedAccount {
  id: string;
  email?: string;
  tokens: MioraTokens;
}

const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const REFRESH = /def50200[A-Za-z0-9_+/=-]{80,}/g;

interface ExportCookie {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
}

/** Newer first: by issued-at, then expiry. */
function compareAge(a: string, b: string): number {
  return (tokenIssuedAt(b) ?? 0) - (tokenIssuedAt(a) ?? 0)
    || (tokenExpiresAt(b) ?? 0) - (tokenExpiresAt(a) ?? 0);
}

/** The account in one export, or undefined when it holds no Miora authToken. */
export function mioraAccountFromExport(state: unknown): MioraImportedAccount | undefined {
  if (!state || typeof state !== 'object') return undefined;
  const record = state as Record<string, unknown>;
  // A bare cookie-editor export is just the cookie array.
  const cookies = (Array.isArray(state) ? state : Array.isArray(record.cookies) ? record.cookies : []) as ExportCookie[];
  const ls = (!Array.isArray(state) && record.localStorage && typeof record.localStorage === 'object'
    ? record.localStorage
    : {}) as Record<string, unknown>;
  const cookieValue = (name: string) => {
    const value = cookies.find((cookie) => cookie?.name === name)?.value;
    return typeof value === 'string' ? value : undefined;
  };
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  const blob = JSON.stringify(state);

  const candidates = [text(ls.authToken), cookieValue('authToken'), ...(blob.match(JWT) ?? [])]
    .filter((token): token is string => Boolean(token));
  const authToken = [...new Set(candidates)].sort(compareAge)[0];
  if (!authToken) return undefined;

  const refreshToken = text(ls.refreshToken) ?? cookieValue('refreshToken') ?? (blob.match(REFRESH) ?? [])[0];

  let email: string | undefined;
  try {
    const info = JSON.parse(text(ls.miora__user_info) ?? '{}') as Record<string, unknown>;
    email = text(info.email);
  } catch {
    email = undefined;
  }
  email ??= blob.match(/[\w.+-]+@[\w-]+\.[A-Za-z]{2,}/)?.[0];

  // The whole miora.design cookie jar, as one header string. miora sits behind
  // Tencent T-Sec; without these risk cookies the API 401s even a valid Bearer.
  const cookie = cookies
    .filter((entry) => typeof entry?.name === 'string' && typeof entry.value === 'string'
      && /(^|\.)miora\.design$/.test(String(entry.domain ?? '')))
    .map((entry) => `${String(entry.name)}=${String(entry.value)}`)
    .join('; ');

  return {
    id: mioraSessionId(authToken),
    ...(email ? { email } : {}),
    tokens: {
      authToken,
      ...(refreshToken ? { refreshToken } : {}),
      ...(cookie ? { cookie } : {})
    }
  };
}

export type MioraMergeStatus = 'added' | 'updated' | 'unchanged' | 'stale';

export interface MioraMergeResult {
  sessionId: string;
  email?: string;
  status: MioraMergeStatus;
  tokens: MioraTokens;
  /** Where the account came from, for operator messages. */
  source?: string;
}

/**
 * Fold imported accounts into the account file's contents. A new account is
 * appended; a known one is replaced only when the import carries a newer
 * authToken (an older one is reported `stale`). With the same authToken, only
 * fields the line lacks (refresh token, cookie, email) are filled in.
 */
export function mergeMioraAccounts(
  contents: string,
  incoming: Array<MioraImportedAccount & { source?: string }>
): { contents: string; results: MioraMergeResult[] } {
  let next = contents;
  const results: MioraMergeResult[] = [];

  for (const account of incoming) {
    const existing = parseMioraAccounts(next).accounts.find((entry) => entry.sessionId === account.id);
    const report = (status: MioraMergeStatus, tokens: MioraTokens) => results.push({
      sessionId: account.id,
      ...(account.email ?? existing?.email ? { email: account.email ?? existing?.email } : {}),
      status,
      tokens,
      ...(account.source ? { source: account.source } : {})
    });

    if (!existing) {
      const line = formatMioraAccount(account);
      next = next && !/\r?\n$/.test(next) ? `${next}\n${line}\n` : `${next}${line}\n`;
      report('added', account.tokens);
      continue;
    }

    const current = existing.tokens;
    let tokens: MioraTokens;
    let status: MioraMergeStatus;
    if (current.authToken === account.tokens.authToken) {
      tokens = {
        authToken: current.authToken,
        ...(current.refreshToken ?? account.tokens.refreshToken
          ? { refreshToken: current.refreshToken ?? account.tokens.refreshToken }
          : {}),
        ...(current.cookie ?? account.tokens.cookie ? { cookie: current.cookie ?? account.tokens.cookie } : {})
      };
      const filled = tokens.refreshToken !== current.refreshToken
        || tokens.cookie !== current.cookie
        || (!existing.email && account.email !== undefined);
      status = filled ? 'updated' : 'unchanged';
    } else if (compareAge(account.tokens.authToken, current.authToken) < 0) {
      // The export's cookie jar is the one the site paired with this token.
      tokens = { ...account.tokens, ...(account.tokens.cookie ?? current.cookie ? { cookie: account.tokens.cookie ?? current.cookie } : {}) };
      status = 'updated';
    } else {
      report('stale', current);
      continue;
    }

    if (status === 'updated') {
      const lines = next.split(/(\r?\n)/);
      lines[(existing.line - 1) * 2] = formatMioraAccount({
        id: existing.sessionId,
        email: existing.email ?? account.email,
        tokens
      });
      next = lines.join('');
    }
    report(status, tokens);
  }

  return { contents: next, results };
}

export interface MioraImportReport {
  results: MioraMergeResult[];
  /** Files that were read but hold no importable account. */
  skipped: Array<{ file: string; reason: string }>;
  /** True when the account file was rewritten. */
  written: boolean;
}

/** Export files in a directory: `*.json`, not recursive, in name order. */
export async function listMioraExports(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => name.toLowerCase().endsWith('.json') && !name.startsWith('.'))
    .sort()
    .map((name) => path.join(dir, name));
}

/** Called inside the shared account-file edit queue, so import cannot resurrect a removed credential. */
export async function archiveMioraExports(
  dir: string, archiveDir: string, sessionId: string, expected: MioraTokens
): Promise<number> {
  const sourceRoot = path.resolve(dir);
  const destinationRoot = path.resolve(archiveDir);
  if (sourceRoot === destinationRoot) throw new Error('Miora archive must be outside the active import directory');
  let archived = 0;
  for (const file of await listMioraExports(dir)) {
    if (path.dirname(path.resolve(file)) !== sourceRoot) throw new Error('Miora export is outside its import directory');
    const contents = await readFile(file, 'utf8');
    let account: MioraImportedAccount | undefined;
    try { account = mioraAccountFromExport(JSON.parse(contents.replace(/^﻿/, ''))); }
    catch { continue; } // Unreadable exports were never verified and must remain untouched.
    if (!account || account.id !== sessionId) continue;
    const current = account.tokens;
    const same = current.authToken === expected.authToken
      && current.refreshToken === expected.refreshToken && current.cookie === expected.cookie;
    const issued = tokenIssuedAt(current.authToken);
    const expectedIssued = tokenIssuedAt(expected.authToken);
    const expires = tokenExpiresAt(current.authToken);
    const expectedExpires = tokenExpiresAt(expected.authToken);
    const older = issued !== undefined && expectedIssued !== undefined && (
      issued < expectedIssued || (issued === expectedIssued && expires !== undefined
        && expectedExpires !== undefined && expires < expectedExpires));
    if (!same && !older) continue;
    await mkdir(destinationRoot, { recursive: true });
    // Preserve a file replaced by an editor after the verified read.
    if (await readFile(file, 'utf8') !== contents) continue;
    await rename(file, path.join(destinationRoot, `${Date.now()}-${randomUUID()}-${path.basename(file)}`));
    archived += 1;
  }
  return archived;
}

/**
 * Import every `*.json` export in `dir` into the account file. The file is
 * replaced atomically, and only if nobody (say, a token renewal) changed it
 * while the import was merging.
 */
export async function importMioraExports(dir: string, accountFile: string): Promise<MioraImportReport> {
  return withMioraAccountFileEdit(accountFile, () => importMioraExportsUnlocked(dir, accountFile));
}

async function importMioraExportsUnlocked(dir: string, accountFile: string): Promise<MioraImportReport> {
  const files = await listMioraExports(dir);
  const incoming: Array<MioraImportedAccount & { source: string }> = [];
  const skipped: MioraImportReport['skipped'] = [];
  for (const file of files) {
    let state: unknown;
    try {
      state = JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
    } catch (error) {
      skipped.push({ file, reason: `not readable JSON: ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    const account = mioraAccountFromExport(state);
    if (!account) {
      skipped.push({ file, reason: 'no authToken found (is this a miora.design site-state export?)' });
      continue;
    }
    incoming.push({ ...account, source: file });
  }

  for (let attempt = 0; ; attempt += 1) {
    const before = await readOptional(accountFile);
    const merged = mergeMioraAccounts(before ?? '', incoming);
    if (merged.contents === (before ?? '')) return { results: merged.results, skipped, written: false };

    const temporary = path.join(path.dirname(accountFile), `.${path.basename(accountFile)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, merged.contents, { encoding: 'utf8', flag: 'wx' });
      // A renewal may have rewritten the file meanwhile; merge again on top of it.
      if (await readOptional(accountFile) === before) {
        await rename(temporary, accountFile);
        return { results: merged.results, skipped, written: true };
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
    if (attempt >= 4) throw new Error(`Miora account file kept changing during import: ${accountFile}`);
  }
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export interface MioraImportWatcherOptions {
  /** Fallback poll — `fs.watch` is unreliable on some file systems. */
  pollIntervalMs?: number;
  /** Quiet period after a change event, so a file still being written is read whole. */
  debounceMs?: number;
  onImport?: (report: MioraImportReport) => void;
  onError?: (error: unknown) => void;
}

/**
 * Watches a drop directory of Miora exports and imports into the account file
 * whenever its `*.json` files change. The account file's own watcher then picks
 * the new lines up, so this only ever writes the file.
 */
export class MioraImportWatcher {
  private watcher?: FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private debounceTimer?: NodeJS.Timeout;
  private lastFingerprint?: string;
  private running = false;
  private importing = false;
  private recheck = false;

  constructor(
    readonly dir: string,
    readonly accountFile: string,
    private readonly options: MioraImportWatcherOptions = {}
  ) {}

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    this.running = true;
    await this.check();
    try {
      this.watcher = watch(this.dir, () => this.schedule());
      this.watcher.on('error', (error) => this.options.onError?.(error));
    } catch (error) {
      this.options.onError?.(error);
    }
    this.pollTimer = setInterval(() => void this.check(), this.options.pollIntervalMs ?? 10_000);
    this.pollTimer.unref?.();
  }

  stop(): void {
    this.running = false;
    this.watcher?.close();
    this.watcher = undefined;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.pollTimer = undefined;
    this.debounceTimer = undefined;
  }

  /** Import now if the directory changed since the last import. */
  async check(): Promise<void> {
    if (!this.running) return;
    if (this.importing) {
      this.recheck = true;
      return;
    }
    this.importing = true;
    try {
      const current = await this.fingerprint();
      if (current === this.lastFingerprint) return;
      const report = await importMioraExports(this.dir, this.accountFile);
      this.lastFingerprint = current;
      this.options.onImport?.(report);
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.importing = false;
      if (this.recheck) {
        this.recheck = false;
        this.schedule();
      }
    }
  }

  private schedule(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.check(), this.options.debounceMs ?? 1_000);
  }

  private async fingerprint(): Promise<string> {
    const hash = createHash('sha256');
    for (const file of await listMioraExports(this.dir)) {
      const info = await stat(file).catch(() => undefined);
      if (info) hash.update(`${path.basename(file)}\0${info.size}\0${info.mtimeMs}\n`);
    }
    return hash.digest('hex');
  }
}
