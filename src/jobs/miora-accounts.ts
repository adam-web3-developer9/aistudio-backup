import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MioraApiError,
  describeMioraToken,
  hasUsableScopes,
  mioraSessionId,
  refreshAuthToken,
  tokenExpiresAt,
  tokenLifetimeMs,
  type MioraTokens
} from '../adapters/miora-api.js';

const accountFileEdits = new Map<string, Promise<unknown>>();

/** All in-process Miora import, renewal and cleanup edits share one file queue. */
export async function withMioraAccountFileEdit<T>(filePath: string, edit: () => Promise<T>): Promise<T> {
  const key = path.resolve(filePath).toLowerCase();
  const previous = accountFileEdits.get(key) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(edit);
  accountFileEdits.set(key, operation);
  try {
    return await operation;
  } finally {
    if (accountFileEdits.get(key) === operation) accountFileEdits.delete(key);
  }
}

/**
 * One line of the Miora account file.
 *
 * An account is the pair the web app keeps in `localStorage`: an `authToken`
 * (a JWT, ~15 days) and, ideally, a `refreshToken` (`def50200…`) this service
 * swaps for a fresh authToken before the old one lapses.
 *
 * The file is JSON, one object per line, as `npm run miora:import` writes it:
 *
 *   {"id":"miora-…","email":"…","authToken":"eyJ…","refreshToken":"def50200…"}
 *
 * A bare `authToken` or an `authToken----refreshToken` line pasted by hand is
 * accepted too.
 */
export interface MioraAccountLine {
  /** 1-based line in the file, for operator messages. */
  line: number;
  /** De-duplication key within the file, and the account's id in the pool. */
  sessionId: string;
  email?: string;
  tokens: MioraTokens;
  /** Diagnostic only; an empty scopes array is not grounds to reject the account. */
  scoped: boolean;
}

export interface ParsedMioraAccounts {
  accounts: MioraAccountLine[];
  duplicates: Array<{ sessionId: string; line: number }>;
  invalid: Array<{ line: number; reason: string }>;
}

/** A JWT: three dot-separated base64url parts. Miora authTokens are JWTs. */
const JWT = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** Miora refresh tokens start with this marker. */
const REFRESH = /^def50200[A-Za-z0-9_+/=-]+$/;

function tokensFromParts(parts: string[]): MioraTokens | undefined {
  const authToken = parts.find((part) => JWT.test(part));
  if (!authToken) return undefined;
  const refreshToken = parts.find((part) => REFRESH.test(part));
  return { authToken, ...(refreshToken ? { refreshToken } : {}) };
}

export function parseMioraAccounts(contents: string): ParsedMioraAccounts {
  const accounts: MioraAccountLine[] = [];
  const duplicates: ParsedMioraAccounts['duplicates'] = [];
  const invalid: ParsedMioraAccounts['invalid'] = [];
  const seen = new Set<string>();

  contents.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const value = raw.trim();
    if (!value || value.startsWith('#')) return;

    let tokens: MioraTokens | undefined;
    let email: string | undefined;
    let explicitId: string | undefined;

    if (value.startsWith('{')) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(value) as Record<string, unknown>;
      } catch {
        invalid.push({ line, reason: 'expected one JSON object per line, as `npm run miora:import` writes' });
        return;
      }
      const authToken = typeof record.authToken === 'string' ? record.authToken : undefined;
      if (!authToken) {
        invalid.push({ line, reason: 'JSON line needs an authToken' });
        return;
      }
      tokens = {
        authToken,
        ...(typeof record.refreshToken === 'string' && record.refreshToken
          ? { refreshToken: record.refreshToken }
          : {}),
        ...(typeof record.cookie === 'string' && record.cookie ? { cookie: record.cookie } : {})
      };
      if (typeof record.email === 'string') email = record.email;
      if (typeof record.id === 'string' && record.id) explicitId = record.id;
    } else {
      // Hand-pasted: `authToken`, `authToken----refreshToken`, or `name----authToken----refreshToken`.
      tokens = tokensFromParts(value.split(/-{2,}/).map((part) => part.trim()).filter(Boolean));
      if (!tokens) {
        invalid.push({ line, reason: 'expected an authToken (eyJ…) optionally followed by ----refreshToken' });
        return;
      }
    }

    const sessionId = explicitId ?? mioraSessionId(tokens.authToken);
    if (seen.has(sessionId)) {
      duplicates.push({ sessionId, line });
      return;
    }
    seen.add(sessionId);
    accounts.push({
      line,
      sessionId,
      ...(email ? { email } : {}),
      tokens,
      scoped: hasUsableScopes(tokens.authToken)
    });
  });

  return { accounts, duplicates, invalid };
}

/** The line this service writes for an account; the import script uses it too. */
export function formatMioraAccount(account: {
  id: string;
  email?: string;
  tokens: MioraTokens;
}): string {
  return JSON.stringify({
    id: account.id,
    ...(account.email ? { email: account.email } : {}),
    authToken: account.tokens.authToken,
    ...(account.tokens.refreshToken ? { refreshToken: account.tokens.refreshToken } : {}),
    ...(account.tokens.cookie ? { cookie: account.tokens.cookie } : {})
  });
}

/** Serialize verified balance or expired-credential removals with other account edits. */
export class MioraAccountPruner {
  constructor(private readonly filePath: string,
    private readonly onRemoved?: (sessionId: string, expected: MioraTokens) => Promise<void>) {}

  remove(sessionId: string, expected: MioraTokens): Promise<boolean> {
    return withMioraAccountFileEdit(this.filePath, async () => {
      const removed = await removeMioraAccount(this.filePath, sessionId, expected);
      if (removed) await this.onRemoved?.(sessionId, expected);
      return removed;
    });
  }
}

/** Remove only the credential that was verified; preserve replacements and other lines. */
async function removeMioraAccount(filePath: string, sessionId: string, expected: MioraTokens): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let contents: string;
    try {
      contents = await readFile(filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    const lines = contents.split(/(?<=\n)/);
    const retained = lines.filter((line) => {
      const account = parseMioraAccounts(line).accounts[0];
      return !account || account.sessionId !== sessionId
        || account.tokens.authToken !== expected.authToken
        || account.tokens.refreshToken !== expected.refreshToken
        || account.tokens.cookie !== expected.cookie;
    });
    if (retained.length === lines.length) return false;
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, retained.join(''), { encoding: 'utf8', flag: 'wx' });
      if (await readFile(filePath, 'utf8') !== contents) continue;
      await rename(temporary, filePath);
      return true;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  throw new Error('Miora account file kept changing during account cleanup');
}

/** Replace only the unchanged credential line, keeping other accounts and comments intact. */
export async function persistMioraRenewal(
  filePath: string,
  sessionId: string,
  previous: MioraTokens,
  renewed: MioraTokens
): Promise<boolean> {
  return withMioraAccountFileEdit(filePath, () => persistMioraRenewalUnlocked(filePath, sessionId, previous, renewed));
}

async function persistMioraRenewalUnlocked(
  filePath: string, sessionId: string, previous: MioraTokens, renewed: MioraTokens
): Promise<boolean> {
  const contents = await readFile(filePath, 'utf8');
  const parsed = parseMioraAccounts(contents);
  const entry = parsed.accounts.find((account) => account.sessionId === sessionId);
  if (!entry) return false;
  if (entry.tokens.authToken === renewed.authToken && entry.tokens.refreshToken === renewed.refreshToken) return true;
  if (entry.tokens.authToken !== previous.authToken || entry.tokens.refreshToken !== previous.refreshToken) return false;

  const lines = contents.split(/(\r?\n)/);
  const index = (entry.line - 1) * 2;
  const raw = lines[index]!;
  if (raw.trim().startsWith('{')) {
    const record = JSON.parse(raw) as Record<string, unknown>;
    record.authToken = renewed.authToken;
    if (renewed.refreshToken) record.refreshToken = renewed.refreshToken;
    if (renewed.cookie) record.cookie = renewed.cookie;
    lines[index] = JSON.stringify(record);
  } else {
    let updated = raw.replace(previous.authToken, renewed.authToken);
    if (previous.refreshToken && renewed.refreshToken) {
      updated = updated.replace(previous.refreshToken, renewed.refreshToken);
    }
    lines[index] = updated;
  }
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, lines.join(''), { encoding: 'utf8', flag: 'wx' });
    // Recheck immediately before replacing the file, so an editor's update is not overwritten.
    if (await readFile(filePath, 'utf8') !== contents) return false;
    await rename(temporary, filePath);
    return true;
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

export interface ResolvedMioraAccount {
  sessionId: string;
  tokens: MioraTokens;
  email?: string;
  expiresAt?: string;
  scoped: boolean;
}

export interface MioraAccountFailure {
  line: number;
  sessionId?: string;
  message: string;
}

export interface MioraCredentialsOptions {
  /** Renew this long before the authToken expires. Default: two days. */
  refreshBeforeMs?: number;
  /** How the tokens are renewed; the platform call by default. Gets the current tokens (for its cookie). */
  refresh?: (tokens: MioraTokens) => Promise<MioraTokens>;
  /** Remove only an expired credential with no recovery path; false preserves it for another check. */
  onExpired?: (sessionId: string, expected: MioraTokens, reason: 'NO_REFRESH_TOKEN' | 'REFRESH_TOKEN_DEAD') => Promise<boolean>;
}

/**
 * Keeps each account's authToken fresh from its refresh token.
 *
 * A Miora authToken lasts ~15 days; a line without a refresh token has to be
 * re-imported by hand before it lapses. `resolve` returns the current token for
 * every line (renewing on import when one is already near expiry), and
 * `refresh` renews the ones that are about to lapse on a timer. Rotated refresh
 * tokens are kept in memory until the caller persists them to the account file.
 * The watcher keeps in-memory renewals across unchanged file reloads.
 */
export class MioraCredentials {
  private readonly held = new Map<string, ResolvedMioraAccount>();
  private readonly sources = new Map<string, string>();

  constructor(private readonly options: MioraCredentialsOptions = {}) {}

  private get refreshBeforeMs(): number {
    return this.options.refreshBeforeMs ?? 2 * 24 * 60 * 60_000;
  }

  private get refresh_(): (tokens: MioraTokens) => Promise<MioraTokens> {
    return this.options.refresh
      ?? (async (tokens) => {
        const renewed = await refreshAuthToken(tokens.refreshToken!, { cookie: tokens.cookie });
        // The site cookie is not reissued by the refresh call; carry it forward.
        return { ...renewed, ...(tokens.cookie ? { cookie: tokens.cookie } : {}) };
      });
  }

  /**
   * Resolve every parsed line to a usable token. A token already near expiry (or
   * one with no scopes) is renewed on the spot when a refresh token is present;
   * one account failing to renew does not stop the others.
   */
  async resolve(parsed: ParsedMioraAccounts): Promise<{
    accounts: ResolvedMioraAccount[];
    failures: MioraAccountFailure[];
    removed: string[];
  }> {
    const accounts: ResolvedMioraAccount[] = [];
    const failures: MioraAccountFailure[] = [];
    const removed: string[] = [];
    const kept = new Set<string>();

    for (const line of parsed.accounts) {
      const source = JSON.stringify(line.tokens);
      const held = this.held.get(line.sessionId);
      let tokens = held && this.sources.get(line.sessionId) === source ? held.tokens : line.tokens;
      let renewalFailed = false;
      let renewalError: unknown;
      // Only renew a token that is about to lapse; nothing else about it is judged here.
      const needsRenew = tokens.refreshToken !== undefined && this.needsRefresh(tokens.authToken);
      if (needsRenew) {
        try {
          tokens = await this.refresh_(tokens);
        } catch (error) {
          renewalFailed = true;
          renewalError = error;
        }
      }
      const updated = this.held.get(line.sessionId);
      if (updated && updated !== held) {
        tokens = updated.tokens;
        renewalFailed = false;
      } else if (!tokens.refreshToken || renewalFailed) {
        const didRemove = await this.removeExpired(line.sessionId, tokens, renewalError);
        const replacement = this.held.get(line.sessionId);
        if (replacement && replacement !== held) {
          tokens = replacement.tokens;
          renewalFailed = false;
        } else if (didRemove) {
          removed.push(line.sessionId);
          continue;
        }
      }
      if (renewalFailed) {
        failures.push({ line: line.line, sessionId: line.sessionId,
          message: renewalError instanceof Error ? renewalError.message : String(renewalError) });
      }
      const resolved = describe(line.sessionId, tokens, line.email);
      this.held.set(line.sessionId, resolved);
      this.sources.set(line.sessionId, source);
      kept.add(line.sessionId);
      accounts.push(resolved);
    }

    for (const key of [...this.held.keys()]) {
      if (!kept.has(key)) {
        this.held.delete(key);
        this.sources.delete(key);
      }
    }
    return { accounts, failures, removed };
  }

  /** Keep an on-demand HTTP 401 renewal in step with the account watcher. */
  acceptRenewal(sessionId: string, previous: MioraTokens, tokens: MioraTokens): ResolvedMioraAccount | undefined {
    const held = this.held.get(sessionId);
    if (!held) return undefined;
    if (held.tokens.authToken === tokens.authToken
      && held.tokens.refreshToken === tokens.refreshToken) return held;
    if (held.tokens.authToken !== previous.authToken
      || held.tokens.refreshToken !== previous.refreshToken) return undefined;
    const resolved = describe(sessionId, tokens, held.email);
    this.held.set(sessionId, resolved);
    return resolved;
  }

  /** Renew every held account whose authToken is about to lapse. */
  async refresh(): Promise<{
    accounts: ResolvedMioraAccount[];
    failures: MioraAccountFailure[];
    removed: string[];
  }> {
    const accounts: ResolvedMioraAccount[] = [];
    const failures: MioraAccountFailure[] = [];
    const removed: string[] = [];

    for (const [sessionId, held] of this.held) {
      if (!held.tokens.refreshToken) {
        if (await this.removeExpired(sessionId, held.tokens)) removed.push(sessionId);
        continue;
      }
      if (!this.needsRefresh(held.tokens.authToken)) continue;
      try {
        const tokens = await this.refresh_(held.tokens);
        // A concurrent on-demand refresh can win while this request is in flight.
        if (this.held.get(sessionId)?.tokens !== held.tokens) continue;
        const resolved = describe(sessionId, tokens, held.email);
        this.held.set(sessionId, resolved);
        accounts.push(resolved);
      } catch (error) {
        if (this.held.get(sessionId)?.tokens !== held.tokens) continue;
        if (await this.removeExpired(sessionId, held.tokens, error)) {
          removed.push(sessionId);
          continue;
        }
        failures.push({
          line: 0,
          sessionId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { accounts, failures, removed };
  }

  private async removeExpired(sessionId: string, tokens: MioraTokens, error?: unknown): Promise<boolean> {
    const expiresAt = tokenExpiresAt(tokens.authToken);
    if (expiresAt === undefined || !Number.isFinite(expiresAt) || expiresAt > Date.now()) return false;
    const reason = !tokens.refreshToken ? 'NO_REFRESH_TOKEN'
      : error instanceof MioraApiError && error.apiCode === 'REFRESH_TOKEN_DEAD'
        && error.path === '/api/auth/refresh-token' ? 'REFRESH_TOKEN_DEAD' : undefined;
    if (!reason || !await this.options.onExpired?.(sessionId, tokens, reason)) return false;
    if (this.held.get(sessionId)?.tokens === tokens) {
      this.held.delete(sessionId);
      this.sources.delete(sessionId);
    }
    return true;
  }

  private needsRefresh(authToken: string): boolean {
    const expiresAt = tokenExpiresAt(authToken);
    if (expiresAt === undefined) return false;
    const lifetime = tokenLifetimeMs(authToken);
    const threshold = lifetime === undefined
      ? this.refreshBeforeMs
      : Math.min(this.refreshBeforeMs, Math.round(lifetime / 4));
    return expiresAt - Date.now() < threshold;
  }
}

function describe(sessionId: string, tokens: MioraTokens, email?: string): ResolvedMioraAccount {
  return {
    sessionId,
    tokens,
    ...(email ? { email } : {}),
    expiresAt: describeMioraToken(tokens.authToken)?.expiresAt,
    scoped: hasUsableScopes(tokens.authToken)
  };
}
