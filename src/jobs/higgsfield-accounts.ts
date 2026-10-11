import { createHash } from 'node:crypto';
import { describeMcpToken, type HiggsfieldOAuthTokens } from '../adapters/higgsfield-mcp.js';

/**
 * One line of the Higgsfield account file.
 *
 * An account here is an **OAuth credential for Higgsfield's MCP server**, which
 * is how this channel talks to the platform: a `client_id` from dynamic
 * registration plus the refresh token that authorization produced. Access
 * tokens live about a day and are minted from the refresh token as needed, so
 * only the refresh token really has to survive a restart.
 *
 * The file is JSON, one object per line, written by `npm run higgsfield:login`:
 *
 *   {"id":"higgsfield-user_…","email":"…","clientId":"…","refreshToken":"…"}
 *
 * Earlier versions stored a Clerk `__client` cookie for the web app's own
 * gateway. That path is gone — the platform refuses trial accounts there and
 * puts DataDome in front of `/jobs/*` — so such a line is reported as invalid
 * with the remedy rather than silently ignored.
 */
export interface HiggsfieldAccountLine {
  /** 1-based line in the file, for operator messages. */
  line: number;
  /** De-duplication key within the file, and the account's id in the pool. */
  sessionId: string;
  email?: string;
  tokens: HiggsfieldOAuthTokens;
}

export interface ParsedHiggsfieldAccounts {
  accounts: HiggsfieldAccountLine[];
  /** Lines skipped because an earlier line already names the same account. */
  duplicates: Array<{ sessionId: string; line: number }>;
  /** Lines that are not a credential this service can use. */
  invalid: Array<{ line: number; reason: string }>;
}

const LEGACY_COOKIE = /^(?:__client|__session|client|session)\s*[=:]|^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** Stable per-account id, derived without a network call. */
export function higgsfieldAccountId(input: { userId?: string; email?: string; clientId: string }): string {
  const identity = input.userId ?? input.email;
  if (identity) return `higgsfield-${identity}`;
  return `higgsfield-${createHash('sha256').update(input.clientId).digest('hex').slice(0, 12)}`;
}

export function parseHiggsfieldAccounts(contents: string): ParsedHiggsfieldAccounts {
  const accounts: HiggsfieldAccountLine[] = [];
  const duplicates: ParsedHiggsfieldAccounts['duplicates'] = [];
  const invalid: ParsedHiggsfieldAccounts['invalid'] = [];
  const seen = new Set<string>();

  contents.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const value = raw.trim();
    if (!value || value.startsWith('#')) return;

    if (LEGACY_COOKIE.test(value)) {
      invalid.push({
        line,
        reason: 'this is a Clerk cookie from the old gateway path; run `npm run higgsfield:login` to sign the account in again'
      });
      return;
    }

    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      record = parsed as Record<string, unknown>;
    } catch {
      invalid.push({ line, reason: 'expected one JSON object per line, as `npm run higgsfield:login` writes' });
      return;
    }

    const clientId = typeof record.clientId === 'string' ? record.clientId : undefined;
    const refreshToken = typeof record.refreshToken === 'string' ? record.refreshToken : undefined;
    const accessToken = typeof record.accessToken === 'string' ? record.accessToken : undefined;
    const idToken = typeof record.idToken === 'string' ? record.idToken : undefined;
    if (!clientId || !(refreshToken || accessToken)) {
      invalid.push({ line, reason: 'needs clientId and refreshToken (sign the account in again)' });
      return;
    }

    // The access token is opaque; who the account belongs to is in the id token.
    const claims = idToken ? describeMcpToken(idToken) : {};
    const email = typeof record.email === 'string' ? record.email : claims.email;
    const sessionId = typeof record.id === 'string' && record.id
      ? record.id
      : higgsfieldAccountId({ userId: claims.userId, email, clientId });

    if (seen.has(sessionId)) {
      duplicates.push({ sessionId, line });
      return;
    }
    seen.add(sessionId);
    accounts.push({
      line,
      sessionId,
      ...(email ? { email } : {}),
      tokens: {
        clientId,
        ...(accessToken ? { accessToken } : {}),
        ...(refreshToken ? { refreshToken } : {}),
        ...(idToken ? { idToken } : {}),
        ...(typeof record.expiresAt === 'number' ? { expiresAt: record.expiresAt } : {})
      }
    });
  });

  return { accounts, duplicates, invalid };
}

/** The line this service writes for an account; the login script uses it too. */
export function formatHiggsfieldAccount(account: {
  id: string;
  email?: string;
  tokens: HiggsfieldOAuthTokens;
}): string {
  return JSON.stringify({
    id: account.id,
    ...(account.email ? { email: account.email } : {}),
    clientId: account.tokens.clientId,
    ...(account.tokens.refreshToken ? { refreshToken: account.tokens.refreshToken } : {}),
    ...(account.tokens.accessToken ? { accessToken: account.tokens.accessToken } : {}),
    ...(account.tokens.idToken ? { idToken: account.tokens.idToken } : {}),
    ...(account.tokens.expiresAt ? { expiresAt: account.tokens.expiresAt } : {})
  });
}
