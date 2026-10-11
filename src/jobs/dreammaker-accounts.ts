import { createHash } from 'node:crypto';
import {
  describeDreamMakerToken,
  dreamMakerSessionId,
  loginWithPassword,
  tokenExpiresAt,
  tokenLifetimeMs
} from '../adapters/dreammaker-api.js';

/**
 * One line of the DreamMaker account file. A line is either a raw access token
 * (what the browser keeps in `localStorage.access_token`) or a credential pair
 * written `username----password` or `username:password`, which this service
 * exchanges for a token itself and renews before it expires.
 */
export interface DreamMakerAccountLine {
  /** 1-based line in the file, for operator messages. */
  line: number;
  /** De-duplication key within the file: the account id, or the username. */
  key: string;
  token?: string;
  username?: string;
  password?: string;
}

export interface ParsedDreamMakerAccounts {
  accounts: DreamMakerAccountLine[];
  /** Lines skipped because an earlier line already names the same account. */
  duplicates: Array<{ key: string; line: number }>;
  /** Lines that are neither a token nor `username:password`. */
  invalid: Array<{ line: number; reason: string }>;
}

/** A JWT has three dot-separated base64url parts; nothing else in this file does. */
function looksLikeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Split a credential line into username and password.
 *
 * Two separators are accepted: `----` (how these account lists are usually
 * pasted around) and `:`. `----` is looked for first, so a password containing
 * a colon survives; either way only the first occurrence splits, so the
 * password keeps whatever separators it contains.
 */
function splitCredentials(value: string): { username: string; password: string } | undefined {
  for (const separator of ['----', ':']) {
    const at = value.indexOf(separator);
    if (at <= 0) continue;
    const username = value.slice(0, at).trim();
    const password = value.slice(at + separator.length);
    if (username && password) return { username, password };
  }
  return undefined;
}

export function parseDreamMakerAccounts(contents: string): ParsedDreamMakerAccounts {
  const accounts: DreamMakerAccountLine[] = [];
  const duplicates: ParsedDreamMakerAccounts['duplicates'] = [];
  const invalid: ParsedDreamMakerAccounts['invalid'] = [];
  const seen = new Set<string>();

  contents.split(/\r?\n/).forEach((raw, index) => {
    const value = raw.trim();
    const line = index + 1;
    if (!value || value.startsWith('#')) return;

    let account: DreamMakerAccountLine;
    if (looksLikeToken(value)) {
      account = { line, key: dreamMakerSessionId(value), token: value };
    } else {
      const credentials = splitCredentials(value);
      if (!credentials) {
        invalid.push({ line, reason: 'expected an access token, username----password or username:password' });
        return;
      }
      account = { line, key: `user:${credentials.username}`, ...credentials };
    }

    if (seen.has(account.key)) {
      duplicates.push({ key: account.key, line });
      return;
    }
    seen.add(account.key);
    accounts.push(account);
  });

  return { accounts, duplicates, invalid };
}

export interface ResolvedDreamMakerAccount {
  sessionId: string;
  token: string;
  source: 'token' | 'password';
  username?: string;
  expiresAt?: string;
}

export interface DreamMakerAccountFailure {
  line: number;
  username?: string;
  message: string;
}

export interface DreamMakerCredentialsOptions {
  /** Re-login this long before the token expires. Default: one day. */
  refreshBeforeMs?: number;
  /** How a password is exchanged for a token; the platform call by default. */
  login?: (origin: string, credentials: { username: string; password: string }) => Promise<string>;
}

/**
 * Turns configured lines into usable access tokens and keeps the
 * password-backed ones alive.
 *
 * A DreamMaker JWT lasts a week, so a token line has to be replaced by hand
 * before it lapses; a `username:password` line is renewed here instead, both
 * on a timer and whenever the file is re-read. Passwords stay in this object —
 * the adapter only ever sees the token.
 */
export class DreamMakerCredentials {
  private readonly passwords = new Map<string, { username: string; password: string; token?: string }>();

  constructor(
    private readonly origin: string,
    private readonly options: DreamMakerCredentialsOptions = {}
  ) {}

  private get refreshBeforeMs(): number {
    return this.options.refreshBeforeMs ?? 24 * 60 * 60_000;
  }

  private get login() {
    return this.options.login ?? loginWithPassword;
  }

  /**
   * Resolve every line to a token: token lines as they stand, password lines by
   * reusing the token this object already holds, or by logging in. One account
   * failing to log in does not stop the others.
   */
  async resolve(parsed: ParsedDreamMakerAccounts): Promise<{
    accounts: ResolvedDreamMakerAccount[];
    failures: DreamMakerAccountFailure[];
  }> {
    const accounts: ResolvedDreamMakerAccount[] = [];
    const failures: DreamMakerAccountFailure[] = [];
    const keptPasswords = new Set<string>();

    for (const line of parsed.accounts) {
      if (line.token) {
        accounts.push(describe(dreamMakerSessionId(line.token), line.token, 'token'));
        continue;
      }
      const username = line.username!;
      const cacheKey = passwordKey(username);
      const cached = this.passwords.get(cacheKey);
      const password = line.password!;
      // A changed password invalidates the token that came from the old one.
      const token = cached?.password === password && cached.token && !this.needsRefresh(cached.token)
        ? cached.token
        : await this.login(this.origin, { username, password })
          .catch((error: unknown) => {
            failures.push({
              line: line.line,
              username,
              message: error instanceof Error ? error.message : String(error)
            });
            return undefined;
          });
      if (!token) continue;

      this.passwords.set(cacheKey, { username, password, token });
      keptPasswords.add(cacheKey);
      accounts.push(describe(dreamMakerSessionId(token), token, 'password', username));
    }

    for (const key of [...this.passwords.keys()]) {
      if (!keptPasswords.has(key)) this.passwords.delete(key);
    }
    return { accounts, failures };
  }

  /**
   * Log in again for every password account whose token is about to lapse.
   * Returns only the accounts that actually got a new token.
   */
  async refresh(): Promise<{
    accounts: ResolvedDreamMakerAccount[];
    failures: DreamMakerAccountFailure[];
  }> {
    const accounts: ResolvedDreamMakerAccount[] = [];
    const failures: DreamMakerAccountFailure[] = [];

    for (const [key, entry] of this.passwords) {
      if (entry.token && !this.needsRefresh(entry.token)) continue;
      try {
        const token = await this.login(this.origin, entry);
        this.passwords.set(key, { ...entry, token });
        accounts.push(describe(dreamMakerSessionId(token), token, 'password', entry.username));
      } catch (error) {
        failures.push({
          line: 0,
          username: entry.username,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return { accounts, failures };
  }

  /**
   * A token with no readable expiry is taken at face value rather than renewed
   * on every tick.
   *
   * The threshold scales with the token's own lifetime: a browser token lasts a
   * week, but `/api/auth/login` hands out ~16 hour ones, and a flat "renew when
   * under a day remains" would re-login on every single check for those. So it
   * is the smaller of the configured window and a quarter of the lifetime.
   */
  private needsRefresh(token: string): boolean {
    const expiresAt = tokenExpiresAt(token);
    if (expiresAt === undefined) return false;
    const lifetime = tokenLifetimeMs(token);
    const threshold = lifetime === undefined
      ? this.refreshBeforeMs
      : Math.min(this.refreshBeforeMs, Math.round(lifetime / 4));
    return expiresAt - Date.now() < threshold;
  }
}

function describe(
  sessionId: string,
  token: string,
  source: 'token' | 'password',
  username?: string
): ResolvedDreamMakerAccount {
  return {
    sessionId,
    token,
    source,
    username,
    expiresAt: describeDreamMakerToken(token)?.expiresAt
  };
}

function passwordKey(username: string): string {
  return createHash('sha256').update(username).digest('hex').slice(0, 16);
}
