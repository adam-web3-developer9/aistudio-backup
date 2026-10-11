import { createHash } from 'node:crypto';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import type { BrowserCookie, CreditBalance, HailuoAccount } from '../types.js';

/**
 * DreamMaker (dreammaker.vobile.com.cn) speaks a plain REST API: a JWT in
 * `Authorization: Bearer`, JSON in and out, no request signature and no device
 * identity. The web app keeps that JWT in `localStorage.access_token`; we keep
 * it in a session cookie of the same name so one `SessionRecord` still carries
 * everything an account needs.
 */
export const DREAMMAKER_TOKEN_COOKIE = 'access_token';
export const CREDIT_API_PATH = '/api/credits/balances';
export const PRICING_API_PATH = '/api/billing/canvas-pricing';
export const LOGIN_API_PATH = '/api/auth/login';
export const GENERATE_VIDEO_PATH = '/api/video/generate';

/**
 * DreamMaker is a mainland-China host and its uploads go straight to Aliyun OSS,
 * so the default is a direct exit. The hook exists for parity with Hailuo, for
 * the case where this service runs somewhere that needs a way out.
 */
let dreamMakerDispatcher: Dispatcher | undefined;

export function useDreamMakerProxy(proxyUrl?: string): void {
  dreamMakerDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

export function dreamMakerDispatcherFor(): Dispatcher | undefined {
  return dreamMakerDispatcher;
}

/**
 * A DreamMaker error response: FastAPI's `{detail}`, which is either a string,
 * a validation issue list, or `{code, message}` for the app's own failures.
 */
export class DreamMakerApiError extends Error {
  constructor(
    readonly status: number,
    readonly apiCode: string | undefined,
    readonly apiMessage: string,
    readonly path: string
  ) {
    super(`DreamMaker ${path} failed (${apiCode ?? status}): ${apiMessage}`);
  }
}

export interface DreamMakerRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Team scope; omitted means the personal account the token belongs to. */
  accountId?: string;
  signal?: AbortSignal;
}

/** One call against the DreamMaker API. Returns the parsed body (`undefined` on 204). */
export async function dreamMakerRequest<T = unknown>(
  origin: string,
  token: string,
  path: string,
  options: DreamMakerRequestOptions = {}
): Promise<T> {
  const method = options.method ?? 'GET';
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.accountId ? { 'x-account-id': options.accountId } : {})
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    dispatcher: dreamMakerDispatcher,
    signal: options.signal
  });

  const text = await response.text();
  if (!response.ok) throw toApiError(response.status, text, path);
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

function toApiError(status: number, text: string, path: string): DreamMakerApiError {
  let code: string | undefined;
  let message = text.slice(0, 500);
  try {
    const detail = (JSON.parse(text) as { detail?: unknown }).detail;
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
      const record = detail as { code?: unknown; message?: unknown };
      if (typeof record.code === 'string') code = record.code;
      if (typeof record.message === 'string') message = record.message;
    }
  } catch {
    // Not JSON — keep the raw text.
  }
  return new DreamMakerApiError(status, code, message, path);
}

/** Exchange a username and password for an access token. */
export async function loginWithPassword(
  origin: string,
  credentials: { username: string; password: string },
  signal?: AbortSignal
): Promise<string> {
  const response = await fetch(`${origin}${LOGIN_API_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
    dispatcher: dreamMakerDispatcher,
    signal
  });

  const text = await response.text();
  if (!response.ok) throw toApiError(response.status, text, LOGIN_API_PATH);

  // The login response has only ever been observed through the web app, which
  // reads `access_token`; the other spellings are cheap insurance.
  const payload = (text ? JSON.parse(text) : {}) as {
    access_token?: unknown;
    token?: unknown;
    data?: { access_token?: unknown; token?: unknown };
  };
  const token = [payload.access_token, payload.token, payload.data?.access_token, payload.data?.token]
    .find((value): value is string => typeof value === 'string' && value.length > 0);
  if (!token) {
    throw new DreamMakerApiError(response.status, 'LOGIN_NO_TOKEN', 'Login response carried no access token', LOGIN_API_PATH);
  }
  return token;
}

export interface DreamMakerBalancePayload {
  total?: unknown;
  scope?: unknown;
  buckets?: Array<{ credit_class?: unknown; balance?: unknown }>;
}

export function parseCreditBalance(payload: unknown): CreditBalance {
  if (!payload || typeof payload !== 'object') {
    throw new Error('DreamMaker credit API returned an invalid response');
  }
  const raw = payload as DreamMakerBalancePayload;
  const total = Number(raw.total);
  if (!Number.isFinite(total)) {
    throw new Error('DreamMaker credit API response is missing total');
  }
  return {
    totalCredits: total,
    // Credits are one pool split by how they were granted (free, recharge,
    // subscription, model_card). `creditType` is the index: the API names the
    // classes with strings and the shared shape wants a number.
    breakdown: (raw.buckets ?? []).map((bucket, index) => ({
      creditType: index,
      credits: Number(bucket?.balance) || 0,
      record: bucket
    }))
  };
}

export async function fetchCreditsWithToken(origin: string, token: string): Promise<CreditBalance> {
  return parseCreditBalance(await dreamMakerRequest(origin, token, CREDIT_API_PATH));
}

/** `GET /api/billing/canvas-pricing`, one capability per key. */
export interface DreamMakerPricing {
  /** `per_second` for video, `per_image` for stills, `per_char` for text and speech. */
  unit: string;
  models: Record<string, number>;
}

export type DreamMakerPricingTable = Record<string, DreamMakerPricing>;

export async function fetchPricing(origin: string, token: string): Promise<DreamMakerPricingTable> {
  const payload = await dreamMakerRequest<Record<string, unknown>>(origin, token, PRICING_API_PATH);
  const table: DreamMakerPricingTable = {};
  for (const [capability, value] of Object.entries(payload ?? {})) {
    const entry = value as { unit?: unknown; models?: unknown };
    if (typeof entry?.unit !== 'string' || !entry.models || typeof entry.models !== 'object') continue;
    const models: Record<string, number> = {};
    for (const [model, price] of Object.entries(entry.models as Record<string, unknown>)) {
      if (typeof price === 'number' && Number.isFinite(price)) models[model] = price;
    }
    table[capability] = { unit: entry.unit, models };
  }
  return table;
}

export const QUOTE_API_PATH = '/api/billing/quote/aigc';

export interface DreamMakerQuote {
  /** Credits per second at list price. */
  listAmount: number;
  /** What this account would actually pay — vouchers can make it lower. */
  payableAmount: number;
  /** e.g. `CP_AIGC_VIDEO_SEEDANCE25_480P` — the tier the price came from. */
  chargingPointCode?: string;
}

/**
 * The per-second price for one model at one resolution.
 *
 * This is the only accurate source: `canvas-pricing` lists a single number per
 * model, which turns out to be just one of its tiers (Seedance 2.5 is 672 at
 * 480p, 1512 at 720p, 3750 at 1080p, and the table says 1512). The quote is
 * read-only and charges nothing; it ignores duration and answers a unit price.
 */
export async function fetchQuote(
  origin: string,
  token: string,
  input: { capability?: string; model: string; options?: Record<string, unknown>; quantity?: number },
  signal?: AbortSignal
): Promise<DreamMakerQuote> {
  const payload = await dreamMakerRequest<{
    list_amount?: unknown;
    payable_amount?: unknown;
    charging_point_code?: unknown;
  }>(origin, token, QUOTE_API_PATH, {
    method: 'POST',
    body: {
      capability: input.capability ?? 'video',
      model: input.model,
      quantity: input.quantity ?? 1,
      voucher_grant_id: null,
      no_discount: false,
      no_voucher: false,
      options: input.options ?? {}
    },
    signal
  });

  const listAmount = Number(payload?.list_amount);
  const payableAmount = Number(payload?.payable_amount);
  if (!Number.isFinite(listAmount)) {
    throw new DreamMakerApiError(200, 'QUOTE_UNREADABLE', 'Quote response carried no list amount', QUOTE_API_PATH);
  }
  return {
    listAmount,
    payableAmount: Number.isFinite(payableAmount) ? payableAmount : listAmount,
    chargingPointCode: typeof payload?.charging_point_code === 'string' ? payload.charging_point_code : undefined
  };
}

/**
 * Fallback price when a quote cannot be had: `canvas-pricing` knows one number
 * per model, so it is right only at that model's listed tier. Undefined when
 * the model is not listed — the caller then has no opinion rather than a wrong one.
 */
export function estimateVideoCost(
  pricing: DreamMakerPricingTable | undefined,
  options: { modelId: string; durationSeconds: number; quantity?: number }
): number | undefined {
  const video = pricing?.video;
  const unitPrice = video?.models[options.modelId];
  if (!video || unitPrice === undefined) return undefined;
  const quantity = options.quantity ?? 1;
  if (video.unit !== 'per_second') return unitPrice * quantity;
  if (!Number.isFinite(options.durationSeconds) || options.durationSeconds <= 0) return undefined;
  return Math.ceil(unitPrice * options.durationSeconds) * quantity;
}

/** Turn a raw access token into the cookie set a session record carries. */
export function dreamMakerTokenCookies(token: string, origin: string): BrowserCookie[] {
  return [
    {
      name: DREAMMAKER_TOKEN_COOKIE,
      value: token,
      domain: new URL(origin).hostname,
      path: '/',
      secure: true,
      sameSite: 'Lax'
    }
  ];
}

export function readDreamMakerToken(cookies: readonly BrowserCookie[]): string | undefined {
  return cookies.find((cookie) => cookie.name === DREAMMAKER_TOKEN_COOKIE)?.value;
}

/** Stable per-account id from the JWT subject, or a hash when it cannot be decoded. */
export function dreamMakerSessionId(token: string): string {
  const userId = describeDreamMakerToken(token)?.userId;
  if (userId) return `dreammaker-${userId}`;
  return `dreammaker-${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
}

/** Best-effort decode of the JWT payload (`sub`, `exp`) so accounts can be told apart. */
export function describeDreamMakerToken(token: string): HailuoAccount | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      sub?: unknown;
      exp?: unknown;
    };
    const userId = typeof decoded.sub === 'string'
      ? decoded.sub
      : typeof decoded.sub === 'number' ? String(decoded.sub) : undefined;
    return {
      userId,
      expiresAt: typeof decoded.exp === 'number' ? new Date(decoded.exp * 1000).toISOString() : undefined
    };
  } catch {
    return undefined;
  }
}

/** When the token stops being usable, or undefined when it carries no expiry. */
export function tokenExpiresAt(token: string): number | undefined {
  const expiresAt = describeDreamMakerToken(token)?.expiresAt;
  return expiresAt === undefined ? undefined : Date.parse(expiresAt);
}

/**
 * How long this token was issued for (`exp - iat`).
 *
 * It is not one value: a token lifted out of a browser session lasts a week,
 * while one obtained from `/api/auth/login` lasts about 16 hours. Renewal has
 * to scale with the lifetime instead of assuming either.
 */
export function tokenLifetimeMs(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      iat?: unknown;
      exp?: unknown;
    };
    if (typeof decoded.iat !== 'number' || typeof decoded.exp !== 'number') return undefined;
    const lifetime = (decoded.exp - decoded.iat) * 1000;
    return lifetime > 0 ? lifetime : undefined;
  } catch {
    return undefined;
  }
}
