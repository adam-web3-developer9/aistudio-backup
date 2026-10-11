import { createHash } from 'node:crypto';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import type { BrowserCookie, CreditBalance, ProviderAccount } from '../types.js';

/**
 * Higgsfield (higgsfield.ai) speaks a plain REST API behind one gateway —
 * `https://fnf-api-gw.higgsfield.ai/fnf` — with JSON in and out and no request
 * signature. What makes it different from the other channels is the credential:
 * authentication is Clerk, and the bearer token the gateway wants (the web
 * app's `__session` cookie) is a JWT that lives about a minute.
 *
 * So an account is stored as its **`__client` cookie**, Clerk's long-lived
 * client credential, and a short-lived `__session` JWT is minted from it on
 * demand. A raw `__session` JWT is also accepted, for a one-off run — it will
 * stop working within the minute.
 */
export const HIGGSFIELD_CLIENT_COOKIE = '__client';
export const HIGGSFIELD_SESSION_COOKIE = '__session';

export const WALLET_API_PATH = '/workspaces/wallet';
export const USER_API_PATH = '/user';
export const COSTS_API_PATH = '/job-sets/costs';
export const MEDIA_BATCH_API_PATH = '/media/batch';
export const JOB_STATUS_BATCH_API_PATH = '/jobs/status-batch';

/**
 * Credits cross the wire in hundredths. The web app divides by 100 everywhere
 * it shows a number, and so does this service: `CreditBalance.totalCredits` and
 * every estimate are whole credits, the unit an operator reads on the site.
 */
export const CREDIT_UNITS_PER_CREDIT = 100;

/** The clerk-js build higgsfield.ai ships; Clerk's FAPI wants it on every call. */
export const CLERK_JS_VERSION = '6.25.10';

/**
 * Higgsfield is reachable from most places, so direct by default. The hook is
 * here for parity with the other channels, for the case where this service runs
 * somewhere that needs a way out. It covers the gateway and Clerk; the media
 * bytes go straight to object storage under a presigned URL and stay direct,
 * the same reasoning as Hailuo's and DreamMaker's uploads.
 */
let higgsfieldDispatcher: Dispatcher | undefined;

export function useHiggsfieldProxy(proxyUrl?: string): void {
  higgsfieldDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

export function higgsfieldDispatcherFor(): Dispatcher | undefined {
  return higgsfieldDispatcher;
}

/** A gateway error: FastAPI's `{detail}`, which is a string, an issue list or `{code, message}`. */
export class HiggsfieldApiError extends Error {
  constructor(
    readonly status: number,
    readonly apiCode: string | undefined,
    readonly apiMessage: string,
    readonly path: string
  ) {
    super(`Higgsfield ${path} failed (${apiCode ?? status}): ${apiMessage}`);
  }
}

/** Clerk refused to mint a session token: the stored `__client` cookie is dead. */
export class HiggsfieldAuthError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(`Higgsfield Clerk auth failed (${status}): ${detail}`);
  }
}

export interface HiggsfieldRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Team scope; omitted means the personal workspace the account belongs to. */
  workspaceId?: string;
  /** Sent as `hf-surface`; the web app labels every call with the page it came from. */
  surface?: string;
  signal?: AbortSignal;
}

/** One call against the Higgsfield gateway. Returns the parsed body (`undefined` on 204). */
export async function higgsfieldRequest<T = unknown>(
  origin: string,
  token: string,
  path: string,
  options: HiggsfieldRequestOptions = {}
): Promise<T> {
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.workspaceId ? { 'hf-workspace-id': options.workspaceId } : {}),
      ...(options.surface ? { 'hf-surface': options.surface } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    dispatcher: higgsfieldDispatcher,
    signal: options.signal
  });

  const text = await response.text();
  if (!response.ok) throw toApiError(response.status, text, path);
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function toApiError(status: number, text: string, path: string): HiggsfieldApiError {
  let code: string | undefined;
  let message = text.slice(0, 500);
  try {
    const payload = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown };
    const detail = payload.detail ?? payload.error ?? payload.message;
    if (typeof detail === 'string') {
      message = detail;
    } else if (Array.isArray(detail)) {
      // FastAPI validation issues: one line per offending field.
      message = detail
        .map((issue) => {
          const record = issue as { loc?: unknown[]; msg?: unknown };
          return `${(record.loc ?? []).join('.')}: ${String(record.msg ?? '')}`;
        })
        .join('; ');
    } else if (detail && typeof detail === 'object') {
      const record = detail as { code?: unknown; message?: unknown; detail?: unknown };
      if (typeof record.code === 'string') code = record.code;
      const inner = record.message ?? record.detail;
      if (typeof inner === 'string') message = inner;
    }
  } catch {
    // Not JSON — keep the raw text.
  }
  return new HiggsfieldApiError(status, code, message, path);
}

/* -------------------------------------------------------------------------- */
/* Clerk                                                                       */
/* -------------------------------------------------------------------------- */

export interface ClerkSession {
  /** Clerk session id, `sess_…` — what a token is minted against. */
  sessionId: string;
  userId?: string;
  status?: string;
}

function clerkUrl(clerkOrigin: string, path: string): string {
  return `${clerkOrigin}${path}?_clerk_js_version=${encodeURIComponent(CLERK_JS_VERSION)}`;
}

async function clerkFetch(
  clerkOrigin: string,
  path: string,
  clientToken: string,
  init: { method: 'GET' | 'POST'; signal?: AbortSignal }
): Promise<unknown> {
  const response = await fetch(clerkUrl(clerkOrigin, path), {
    method: init.method,
    headers: {
      // Clerk's FAPI takes the client credential from the cookie, not a header.
      cookie: `${HIGGSFIELD_CLIENT_COOKIE}=${clientToken}`,
      'content-type': 'application/x-www-form-urlencoded'
    },
    dispatcher: higgsfieldDispatcher,
    signal: init.signal
  });

  const text = await response.text();
  if (!response.ok) throw new HiggsfieldAuthError(response.status, clerkDetail(text) || `HTTP ${response.status}`);
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw new HiggsfieldAuthError(response.status, 'Clerk returned a body that is not JSON');
  }
}

function clerkDetail(text: string): string {
  try {
    const payload = JSON.parse(text) as { errors?: Array<{ message?: unknown; long_message?: unknown }> };
    const first = payload.errors?.[0];
    const message = first?.long_message ?? first?.message;
    if (typeof message === 'string') return message;
  } catch {
    // Not Clerk's error envelope — fall through to the raw text.
  }
  return text.slice(0, 300);
}

/**
 * The sessions this `__client` cookie carries. Clerk answers
 * `{response: {sessions: [...], last_active_session_id}}`; a cookie that has
 * been signed out answers the same shape with no active session.
 */
export async function fetchClerkSessions(
  clerkOrigin: string,
  clientToken: string,
  signal?: AbortSignal
): Promise<{ sessions: ClerkSession[]; lastActiveSessionId?: string }> {
  const payload = await clerkFetch(clerkOrigin, '/v1/client', clientToken, { method: 'GET', signal });
  const body = unwrapClerk(payload) as {
    sessions?: unknown;
    last_active_session_id?: unknown;
  } | undefined;

  const sessions: ClerkSession[] = Array.isArray(body?.sessions)
    ? body.sessions.flatMap((entry) => {
      const record = entry as { id?: unknown; status?: unknown; user?: { id?: unknown } };
      if (typeof record?.id !== 'string') return [];
      return [{
        sessionId: record.id,
        userId: typeof record.user?.id === 'string' ? record.user.id : undefined,
        status: typeof record.status === 'string' ? record.status : undefined
      }];
    })
    : [];

  return {
    sessions,
    lastActiveSessionId: typeof body?.last_active_session_id === 'string'
      ? body.last_active_session_id
      : undefined
  };
}

/** Mint a fresh `__session` JWT for one Clerk session. Lives about a minute. */
export async function mintSessionToken(
  clerkOrigin: string,
  clientToken: string,
  clerkSessionId: string,
  signal?: AbortSignal
): Promise<string> {
  const payload = await clerkFetch(
    clerkOrigin,
    `/v1/client/sessions/${encodeURIComponent(clerkSessionId)}/tokens`,
    clientToken,
    { method: 'POST', signal }
  );
  const body = unwrapClerk(payload) as { jwt?: unknown } | undefined;
  if (typeof body?.jwt !== 'string' || !body.jwt) {
    throw new HiggsfieldAuthError(200, 'Clerk minted no session token for this client cookie');
  }
  return body.jwt;
}

/** Clerk's FAPI wraps everything in `{response, client}`; older shapes are flat. */
function unwrapClerk(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const record = payload as { response?: unknown };
  return record.response !== undefined && record.response !== null ? record.response : payload;
}

/**
 * Turns a `__client` cookie into short-lived bearer tokens.
 *
 * Every gateway call needs a JWT that expires in about a minute, so one is
 * minted and reused until it is nearly spent. Which Clerk session to mint
 * against is looked up once and remembered; if that session goes away, the next
 * mint fails and the lookup is redone.
 */
export class HiggsfieldSessionTokens {
  private clerkSessionId?: string;
  private cached?: { token: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(
    private readonly clerkOrigin: string,
    private readonly clientToken: string,
    /** Refresh this long before the JWT lapses; the default leaves a call's worth of room. */
    private readonly refreshBeforeMs = 15_000
  ) {}

  /** A usable bearer token, minted or reused. Concurrent callers share one mint. */
  async token(signal?: AbortSignal): Promise<string> {
    const cached = this.cached;
    if (cached && cached.expiresAt - Date.now() > this.refreshBeforeMs) return cached.token;
    this.pending ??= this.mint(signal).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  /** Drop the cached token so the next call mints a new one (after a 401). */
  invalidate(): void {
    this.cached = undefined;
  }

  private async mint(signal?: AbortSignal): Promise<string> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const clerkSessionId = this.clerkSessionId ?? await this.resolveSessionId(signal);
      try {
        const token = await mintSessionToken(this.clerkOrigin, this.clientToken, clerkSessionId, signal);
        const expiresAt = tokenExpiresAt(token);
        this.cached = {
          token,
          // A token with no readable `exp` is trusted for the shortest lifetime
          // Clerk hands out rather than forever.
          expiresAt: expiresAt ?? Date.now() + 60_000
        };
        this.clerkSessionId = clerkSessionId;
        return token;
      } catch (error) {
        // The remembered session may have been replaced (a sign-in elsewhere).
        // Look it up once more before giving up.
        this.clerkSessionId = undefined;
        if (attempt === 2) throw error;
      }
    }
    /* c8 ignore next */
    throw new HiggsfieldAuthError(0, 'unreachable');
  }

  private async resolveSessionId(signal?: AbortSignal): Promise<string> {
    const { sessions, lastActiveSessionId } = await fetchClerkSessions(this.clerkOrigin, this.clientToken, signal);
    const active = sessions.find((session) => session.sessionId === lastActiveSessionId)
      ?? sessions.find((session) => session.status === 'active')
      ?? sessions[0];
    if (!active) {
      throw new HiggsfieldAuthError(401, 'The stored __client cookie carries no signed-in session');
    }
    return active.sessionId;
  }
}

/* -------------------------------------------------------------------------- */
/* Credentials as cookies                                                      */
/* -------------------------------------------------------------------------- */

/** Turn a raw credential into the cookie set a session record carries. */
export function higgsfieldTokenCookies(
  credential: { clientToken?: string; sessionToken?: string },
  origin: string
): BrowserCookie[] {
  const hostname = new URL(origin).hostname;
  const cookies: BrowserCookie[] = [];
  if (credential.clientToken) {
    cookies.push({
      name: HIGGSFIELD_CLIENT_COOKIE,
      value: credential.clientToken,
      domain: hostname,
      path: '/',
      secure: true,
      sameSite: 'Lax'
    });
  }
  if (credential.sessionToken) {
    cookies.push({
      name: HIGGSFIELD_SESSION_COOKIE,
      value: credential.sessionToken,
      domain: hostname,
      path: '/',
      secure: true,
      sameSite: 'Lax'
    });
  }
  return cookies;
}

export function readHiggsfieldClientToken(cookies: readonly BrowserCookie[]): string | undefined {
  return cookies.find((cookie) => cookie.name === HIGGSFIELD_CLIENT_COOKIE)?.value || undefined;
}

export function readHiggsfieldSessionToken(cookies: readonly BrowserCookie[]): string | undefined {
  return cookies.find((cookie) => cookie.name === HIGGSFIELD_SESSION_COOKIE)?.value || undefined;
}

/** A JWT payload, or undefined when the value is not one. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
      ? decoded as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Which kind of Clerk token this is.
 *
 * Both cookies are JWTs, so the payload decides: a `__session` token names the
 * user and the session it belongs to (`sub` plus `sid`), a `__client` token
 * names the client (`id` is a `client_…`, and it carries a rotating token).
 */
export function classifyClerkToken(token: string): 'client' | 'session' | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  if (typeof payload.sub === 'string' && payload.sub.startsWith('user_')) return 'session';
  if (typeof payload.id === 'string' && payload.id.startsWith('client_')) return 'client';
  if ('rotating_token' in payload) return 'client';
  if (typeof payload.sid === 'string') return 'session';
  return undefined;
}

/** When the token stops being usable, or undefined when it carries no expiry. */
export function tokenExpiresAt(token: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === 'number' ? exp * 1000 : undefined;
}

/** Best-effort account identity from whichever credential the session carries. */
export function describeHiggsfieldToken(token: string): ProviderAccount | undefined {
  const payload = decodeJwtPayload(token);
  if (!payload) return undefined;
  const userId = [payload.sub, payload.id].find(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  return {
    userId,
    expiresAt: typeof payload.exp === 'number' ? new Date(payload.exp * 1000).toISOString() : undefined
  };
}

/**
 * Stable per-account id.
 *
 * Derived from the credential alone, with no network call, so the id an
 * account gets at boot never depends on whether Clerk answered: a `__session`
 * token names the Clerk user, a `__client` token names the Clerk client, and
 * anything unreadable falls back to a hash. Changing a line in the account file
 * to a fresh cookie for the same browser keeps the same id.
 */
export function higgsfieldSessionId(token: string): string {
  const payload = decodeJwtPayload(token);
  const identity = [payload?.sub, payload?.id].find(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  if (identity) return `higgsfield-${identity}`;
  return `higgsfield-${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

/* -------------------------------------------------------------------------- */
/* Wallet                                                                      */
/* -------------------------------------------------------------------------- */

export interface HiggsfieldWallet {
  /** Whole credits left on the subscription this period. */
  subscriptionCredits: number;
  /** Whole credits bought outright. */
  purchasedCredits: number;
  /** Whole credits on the on-demand meter. */
  onDemandCredits: number;
  workspaceId?: string;
  nextAllocationAt?: string;
}

function creditUnits(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

/**
 * `GET /workspaces/wallet`. The web app reads both snake_case and camelCase off
 * this object and divides every number by 100 before showing it, so the same is
 * done here: the balance this service reports is whole credits.
 */
export function parseWallet(payload: unknown): HiggsfieldWallet {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Higgsfield wallet API returned an invalid response');
  }
  const raw = payload as Record<string, unknown>;
  const subscription = creditUnits(pick(raw, 'subscription_balance', 'subscriptionBalance'));
  const purchased = creditUnits(pick(raw, 'credits_balance', 'creditsBalance'));
  const onDemand = creditUnits(pick(raw, 'on_demand_credits', 'onDemandCredits'));
  const workspaceId = pick(raw, 'workspace_id', 'workspaceId', 'id');
  const nextAllocation = pick(raw, 'next_credit_allocation_date', 'nextPaymentDate');

  return {
    subscriptionCredits: subscription / CREDIT_UNITS_PER_CREDIT,
    purchasedCredits: purchased / CREDIT_UNITS_PER_CREDIT,
    onDemandCredits: onDemand / CREDIT_UNITS_PER_CREDIT,
    workspaceId: typeof workspaceId === 'string' ? workspaceId : undefined,
    nextAllocationAt: typeof nextAllocation === 'string' ? nextAllocation : undefined
  };
}

/**
 * What the pool spends from.
 *
 * On-demand credits are a metered overdraft rather than a balance, so they are
 * reported in the breakdown but not counted as spendable: counting them would
 * make an empty account look fundable and send every job to it.
 */
export function walletToCreditBalance(wallet: HiggsfieldWallet): CreditBalance {
  return {
    totalCredits: wallet.subscriptionCredits + wallet.purchasedCredits,
    breakdown: [
      { creditType: 0, credits: wallet.subscriptionCredits, record: { source: 'subscription' } },
      { creditType: 1, credits: wallet.purchasedCredits, record: { source: 'purchased' } },
      { creditType: 2, credits: wallet.onDemandCredits, record: { source: 'on_demand', spendable: false } }
    ]
  };
}

/* -------------------------------------------------------------------------- */
/* Pricing                                                                     */
/* -------------------------------------------------------------------------- */

/** `job set type -> whole credits`, from `GET /job-sets/costs`. */
export type HiggsfieldCostTable = Record<string, number>;

/**
 * The cost table is the platform's, and its shape is not contractual: the web
 * app accepts either a bare array or `{data: [...]}`, and the entries have been
 * seen keyed several ways. Anything unrecognised is skipped rather than
 * guessed at, so an unfamiliar table yields no estimate instead of a wrong one.
 */
export function parseCostTable(payload: unknown): HiggsfieldCostTable {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? (payload as { data: unknown[] }).data
      : [];

  const table: HiggsfieldCostTable = {};
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const key = pick(record, 'job_set_type', 'jobSetType', 'type', 'name');
    const cost = pick(record, 'cost', 'credits', 'credit_units', 'creditUnits', 'price');
    if (typeof key !== 'string' || !key) continue;
    const units = Number(cost);
    if (!Number.isFinite(units)) continue;
    table[key] = units / CREDIT_UNITS_PER_CREDIT;
  }
  return table;
}
