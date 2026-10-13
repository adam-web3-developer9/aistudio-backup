import { createHash, createHmac, randomUUID } from 'node:crypto';
import { fetch, type Dispatcher } from 'undici';
import type { BrowserCookie, CreditBalance, ProviderAccount } from '../types.js';
import { isNetworkError } from './provider-retry.js';
import { createMioraProxyAgent } from './miora-proxy.js';
import { createSystemProxyResolver } from './system-proxy.js';
import { mioraDiagnostic, mioraNetworkCode, withMioraDiagnosticContext } from './miora-diagnostics.js';

/**
 * Miora (miora.design) is a video/image generation aggregator that speaks a
 * plain REST API under `/api/ai`: a JWT in `Authorization: Bearer`, JSON in and
 * out, no request signature and no mandatory device identity (the web app sends
 * an `X-Risk-Device-Token`, but the generation endpoints do not require it).
 *
 * The web app keeps two credentials in `localStorage`: a short-lived
 * `authToken` (a JWT, ~15 days) and a `refreshToken` (an opaque `def50200…`
 * blob) it swaps for a fresh authToken. We carry both in session cookies of the
 * same names so one `SessionRecord` holds everything an account needs.
 *
 * This module is the wire layer — one request helper, the COS upload signing,
 * token renewal and the JWT/cookie plumbing. The higher-level calls live in
 * `miora-client.ts`.
 */
export const MIORA_ORIGIN = 'https://miora.design';
/** `/api/ai` is the generation API; `/api/auth` (token renewal) sits beside it. */
export const MIORA_API_BASE = `${MIORA_ORIGIN}/api/ai`;

export const CREDIT_API_PATH = '/quota/credit';
export const MODELS_API_PATH = '/cloud-agent/media-models?lang=zh-CN';
export const STS_TOKENS_PATH = '/cos/sts-tokens';
export const GENERATE_VIDEO_PATH = '/media-generate/video';
export const GENERATE_IMAGE_PATH = '/media-generate/image';
export const PROGRESS_PATH = '/media-generate/progress';
export const CDN_SIGN_PATH = '/cos/cdn-sign-url';
/** Not under `/api/ai`: token renewal is on the site's own auth service. */
export const REFRESH_TOKEN_URL = `${MIORA_ORIGIN}/api/auth/refresh-token`;

/** The web app's own UA; sent verbatim so our calls look like the site's. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36 Edg/153.0.0.0';

export const MIORA_AT_COOKIE = 'authToken';
export const MIORA_RT_COOKIE = 'refreshToken';

/**
 * Credits, generation submissions and task progress reads share the proxy routes.
 * Other API calls (including COS grants) and Tencent COS uploads stay direct.
 */
type MioraRoute = { name: string; dispatcher?: Dispatcher };
function proxyState(proxyUrl?: string, localProxyUrl = 'auto', proxyAddress?: string, requireProxy = false) {
  if (requireProxy && !proxyUrl) throw new Error('The online Miora gateway requires MIORA_PROXY_URL');
  return {
    proxyUrl, localProxyUrl, requireProxy,
    primary: proxyUrl ? createMioraProxyAgent(proxyUrl, proxyAddress) : undefined,
    resolveLocal: createSystemProxyResolver(),
    locals: new Map<string, Dispatcher>(),
    activeLocal: undefined as string | undefined,
    users: 0, retired: false
  };
}
let mioraProxy = proxyState(undefined, '');

function releaseUnusedAgents(state: typeof mioraProxy): void {
  if (state.users) return;
  if (state.retired && state.primary) void state.primary.close().catch(() => {});
  for (const [url, dispatcher] of state.locals) {
    if (state.retired || url !== state.activeLocal) {
      state.locals.delete(url);
      void dispatcher.close().catch(() => {});
    }
  }
}

export function useMioraProxy(proxyUrl?: string, localProxyUrl = 'auto', proxyAddress?: string, requireProxy = false): void {
  const next = proxyState(proxyUrl, localProxyUrl, proxyAddress, requireProxy);
  mioraProxy.retired = true;
  releaseUnusedAgents(mioraProxy);
  mioraProxy = next;
}

async function acquireMioraRoutes(): Promise<{ routes: MioraRoute[]; release: () => void }> {
  const state = mioraProxy;
  state.users++;
  const release = () => { state.users--; releaseUnusedAgents(state); };
  try {
    // A server gateway must keep generation and polling on its configured exit.
    if (state.requireProxy) return { routes: [{ name: 'Configured proxy', dispatcher: state.primary! }], release };
    const local = state.localProxyUrl.toLowerCase() === 'auto'
      ? await state.resolveLocal() : state.localProxyUrl;
    state.activeLocal = local || undefined;
    if (local && local !== state.proxyUrl && !state.locals.has(local)) {
      state.locals.set(local, createMioraProxyAgent(local));
    }
    return { routes: [
      ...(state.primary ? [{ name: '主代理', dispatcher: state.primary }] : []),
      ...(local && local !== state.proxyUrl ? [{ name: '本地代理', dispatcher: state.locals.get(local) }] : []),
      { name: '直连' }
    ], release };
  } catch (error) { release(); throw error; }
}

export function mioraDispatcherFor(): Dispatcher | undefined {
  return mioraProxy.primary;
}

/** An account's credentials, as carried through the session store. */
export interface MioraTokens {
  authToken: string;
  refreshToken?: string;
  /**
   * The account's miora.design cookies as one `name=value; …` string. miora is
   * behind Tencent T-Sec, whose risk cookies (`TDID`, `4bbe2d16…`) a bare Node
   * request lacks — without them the API answers 401 even with a valid Bearer.
   * The web app sends them, so we do too.
   */
  cookie?: string;
}

/** A Miora API error: `{code, message}` or `{data:{message}}` in the body. */
export class MioraApiError extends Error {
  constructor(
    readonly status: number,
    readonly apiCode: string | undefined,
    readonly apiMessage: string,
    readonly path: string
  ) {
    super(`Miora ${path} failed (${apiCode ?? status}): ${apiMessage}`);
    this.name = 'MioraApiError';
  }
}

/** The account is not signed in: the token expired or was revoked. */
export class MioraAuthError extends MioraApiError {
  constructor(path: string, message = 'HTTP 401') {
    super(401, 'UNAUTHORIZED', message, path);
    this.name = 'MioraAuthError';
  }
}

function accHeaders(token: string, json: boolean, cookie?: string): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'x-product': 'miora',
    'x-source': 'web',
    'x-requested-with': 'XMLHttpRequest',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    origin: MIORA_ORIGIN,
    referer: `${MIORA_ORIGIN}/`,
    'user-agent': UA
  };
  if (json) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  return headers;
}

export interface MioraRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** The account's miora.design cookies, sent so T-Sec does not 401 the call. */
  cookie?: string;
  /** Trusted execution fence, checked after route preparation and before each actual fetch. */
  beforeRequest?: () => Promise<void>;
}

export interface MioraResponse<T = unknown> {
  status: number;
  text: string;
  json: T | undefined;
}

const CONNECTION_FAILURE_CODES = new Set([
  'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ENETUNREACH', 'EHOSTUNREACH'
]);

/** Only connection failures prove a non-idempotent request never reached Miora. */
function failedBeforeSending(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: string; cause?: unknown; errors?: unknown[] };
  if (value.errors?.length) return value.errors.every(failedBeforeSending);
  return !!(value.code && CONNECTION_FAILURE_CODES.has(value.code)) ||
    (value.cause !== undefined && failedBeforeSending(value.cause));
}

async function requestViaMioraRoutes(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  options: { signal?: AbortSignal; timeoutMs?: number; safeToReplay: boolean; path: string; useProxy?: boolean; beforeRequest?: () => Promise<void> }
): Promise<{ status: number; text: string }> {
  return withMioraDiagnosticContext({ apiRequestId:randomUUID() }, async () => {
  // Snapshot routes for this request; concurrent requests never change each other's exit.
  const snapshot = options.useProxy ? await acquireMioraRoutes() : undefined;
  try {
    return await requestViaRouteSnapshot(url, init, options, snapshot?.routes ?? [{ name: '直连' }]);
  } finally { snapshot?.release(); }
  });
}

async function requestViaRouteSnapshot(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  options: { signal?: AbortSignal; timeoutMs?: number; safeToReplay: boolean; path: string; beforeRequest?: () => Promise<void> },
  routes: MioraRoute[]
): Promise<{ status: number; text: string }> {
  const failures: string[] = [];
  let attempt = 0;
  let lastError: unknown;
  for (const route of routes) {
    attempt++;
    options.signal?.throwIfAborted();
    await options.beforeRequest?.();
    options.signal?.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = options.timeoutMs ?? (options.safeToReplay ? 20_000 : undefined);
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    const routeLabel = route.dispatcher ? 'proxy' : 'direct';
    mioraDiagnostic('miora.api.attempt', { outcome:'started', path:options.path, method:init.method, route:routeLabel, attempt });
    try {
      const response = await fetch(url, { ...init, dispatcher: route.dispatcher, signal: controller.signal });
      const text = await response.text();
      let providerCode: string | undefined;
      try {
        const data = JSON.parse(text) as { code?:unknown; data?:{code?:unknown} };
        const code = data?.code ?? data?.data?.code;
        if (typeof code === 'string' || typeof code === 'number') providerCode = String(code);
      } catch { /* Bodies are never included in diagnostic records. */ }
      mioraDiagnostic('miora.api.attempt', { outcome:'response', path:options.path, method:init.method, route:routeLabel, attempt, httpStatus:response.status, providerCode, elapsedMs:performance.now() - started });
      if (options.safeToReplay && (response.status === 408 || response.status === 429 || response.status >= 500)) {
        let json: unknown;
        try { json = JSON.parse(text); } catch { /* Keep the original HTTP response. */ }
        lastError = toApiError({ status: response.status, text, json }, options.path);
        failures.push(`${route.name}: HTTP ${response.status}`);
        mioraDiagnostic('miora.api.route_retry', { path:options.path, attempt, httpStatus:response.status });
        continue;
      }
      return { status: response.status, text };
    } catch (error) {
      mioraDiagnostic('miora.api.attempt', { outcome:options.signal?.aborted ? 'cancelled' : controller.signal.aborted ? 'timeout' : 'failed', path:options.path, method:init.method, route:routeLabel, attempt, networkCode:mioraNetworkCode(error), elapsedMs:performance.now() - started });
      if (options.signal?.aborted) throw error;
      const canFallback = options.safeToReplay
        ? controller.signal.aborted || isNetworkError(error)
        : failedBeforeSending(error);
      if (!canFallback) throw error;
      lastError = error;
      const cause = (error as { cause?: { code?: string }; code?: string }).cause;
      failures.push(`${route.name}: ${controller.signal.aborted ? '请求超时' : cause?.code ?? (error as { code?: string }).code ?? '网络连接失败'}`);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }
  const detail = failures.join('; ');
  if (lastError instanceof MioraApiError) {
    throw new MioraApiError(lastError.status, lastError.apiCode, `${lastError.apiMessage} (${detail})`, options.path);
  }
  throw new Error(`Miora network request failed (${detail})`, { cause: lastError });
}

/**
 * One call against `/api/ai`. Returns the parsed body without throwing on a
 * non-2xx — Miora reports application errors with a 200 and an error field as
 * often as with an HTTP status, so classification is left to the caller. A 401
 * is the exception: it is thrown as `MioraAuthError` so a renewal can be tried.
 */
export async function mioraRequest<T = unknown>(
  token: string,
  path: string,
  options: MioraRequestOptions = {}
): Promise<MioraResponse<T>> {
  const method = options.method ?? 'GET';
  const response = await requestViaMioraRoutes(`${MIORA_API_BASE}${path}`, {
      method,
      headers: accHeaders(token, options.body !== undefined, options.cookie),
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    }, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      safeToReplay: method === 'GET' ||
        (method === 'POST' && (path === PROGRESS_PATH || path === CDN_SIGN_PATH)),
      useProxy: (method === 'GET' && path === CREDIT_API_PATH) || (method === 'POST' &&
        (path === GENERATE_VIDEO_PATH || path === GENERATE_IMAGE_PATH || path === PROGRESS_PATH)),
      beforeRequest: options.beforeRequest,
      path
    });
  const text = response.text;
  if (response.status === 401) throw new MioraAuthError(path, text.slice(0, 120) || 'HTTP 401');
  let json: T | undefined;
  try {
    json = JSON.parse(text) as T;
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
}

/** Turn a `/api/ai` response into a `MioraApiError` from whatever it carried. */
export function toApiError(response: MioraResponse, path: string): MioraApiError {
  const data = (response.json ?? {}) as {
    code?: unknown;
    message?: unknown;
    data?: { code?: unknown; message?: unknown; msg?: unknown };
  };
  const code =
    typeof data.code === 'string' || typeof data.code === 'number'
      ? String(data.code)
      : typeof data.data?.code === 'string' || typeof data.data?.code === 'number'
        ? String(data.data.code)
        : undefined;
  const message =
    (typeof data.message === 'string' && data.message) ||
    (typeof data.data?.message === 'string' && data.data.message) ||
    (typeof data.data?.msg === 'string' && data.data.msg) ||
    response.text.slice(0, 300) ||
    `HTTP ${response.status}`;
  return new MioraApiError(response.status, code, message, path);
}

/* -------------------------------------------------------------------------- */
/* Token renewal                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Swap a refresh token for a fresh authToken. The service rotates refresh
 * tokens, so a new one is returned when the response carries it; otherwise the
 * old one stays valid.
 */
export async function refreshAuthToken(
  refreshToken: string,
  options: { cookie?: string; signal?: AbortSignal } = {}
): Promise<MioraTokens> {
  const response = await requestViaMioraRoutes(REFRESH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: MIORA_ORIGIN,
      referer: `${MIORA_ORIGIN}/`,
      'user-agent': UA,
      ...(options.cookie ? { cookie: options.cookie } : {})
    },
    body: JSON.stringify({ refresh_token: refreshToken })
  }, { signal: options.signal, safeToReplay: false, path: '/api/auth/refresh-token' });
  const text = response.text;
  if (response.status < 200 || response.status >= 300) {
    let message: unknown;
    try { message = (JSON.parse(text) as { message?: unknown })?.message; } catch { /* Preserve unclassified responses. */ }
    const rejected = (response.status === 400 || response.status === 401)
      && message === '无效的刷新令牌或令牌已过期';
    throw new MioraApiError(
      response.status,
      rejected ? 'REFRESH_TOKEN_DEAD' : undefined,
      typeof message === 'string' ? message.slice(0, 120) : text.slice(0, 120),
      '/api/auth/refresh-token'
    );
  }
  const payload = (text ? JSON.parse(text) : {}) as {
    access_token?: unknown;
    refresh_token?: unknown;
  };
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : undefined;
  if (!accessToken) {
    throw new MioraApiError(response.status, 'REFRESH_NO_TOKEN', 'refresh response carried no access_token', '/api/auth/refresh-token');
  }
  return {
    authToken: accessToken,
    refreshToken:
      typeof payload.refresh_token === 'string' && payload.refresh_token
        ? payload.refresh_token
        : refreshToken
  };
}

export const MIORA_COOKIE_COOKIE = 'mioraSiteCookie';

/* -------------------------------------------------------------------------- */
/* Credits                                                                     */
/* -------------------------------------------------------------------------- */

interface MioraCreditPayload {
  total_amount?: unknown;
  used_amount?: unknown;
  nextExpiring?: { credit?: unknown };
}

/**
 * `/quota/credit` reports a total, a used amount and the next batch to expire.
 * "Left" is what the account can actually spend: the next-expiring figure when
 * present, else total minus used.
 */
export function parseCreditBalance(payload: unknown, status = 200): CreditBalance {
  const data = ((payload as { data?: unknown })?.data ?? payload) as MioraCreditPayload;
  const invalid = () => toApiError({
    status,
    json: payload,
    text: 'Miora credit API returned an invalid response'
  }, CREDIT_API_PATH);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
  const amount = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  const total = amount(data.total_amount);
  const used = amount(data.used_amount);
  if (total === undefined || used === undefined) throw invalid();
  const nextExpiring = data.nextExpiring?.credit;
  const left = nextExpiring == null ? total - used : amount(nextExpiring);
  if (left === undefined || !Number.isFinite(left) || left < 0) throw invalid();
  return {
    totalCredits: left,
    breakdown: [{ creditType: 0, credits: left, record: data }]
  };
}

/* -------------------------------------------------------------------------- */
/* COS upload (Tencent Cloud, self-signed PUT)                                 */
/* -------------------------------------------------------------------------- */

/** An STS grant from `/cos/sts-tokens`: temporary keys for a PUT to one prefix. */
export interface MioraCosGrant {
  prefix: string;
  bucket: string;
  region: string;
  token: string;
  secret_id: string;
  secret_key: string;
}

export interface MioraCosUploadRequest {
  key: string;
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}

export interface MioraCosHeadRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * The COS request signature (`q-sign-algorithm=sha1`), ported from the web app.
 * Header names are lower-cased and sorted; only the headers passed here are
 * signed, so the caller must send exactly this set.
 */
export function cosAuth(input: {
  secretId: string;
  secretKey: string;
  method: string;
  pathname: string;
  headers: Record<string, string>;
  keyTime: string;
}): string {
  const sha1 = (value: string) => createHash('sha1').update(value, 'utf8').digest('hex');
  const hmac = (key: string, value: string) => createHmac('sha1', key).update(value, 'utf8').digest('hex');
  const signKey = hmac(input.secretKey, input.keyTime);
  const headerKeys = Object.keys(input.headers).map((key) => key.toLowerCase()).sort();
  const headerList = headerKeys
    .map((key) => `${key}=${encodeURIComponent(String(input.headers[key]))}`)
    .join('&');
  const httpString = [input.method.toLowerCase(), input.pathname, '', headerList, ''].join('\n');
  const stringToSign = ['sha1', input.keyTime, sha1(httpString), ''].join('\n');
  const signature = hmac(signKey, stringToSign);
  return (
    `q-sign-algorithm=sha1&q-ak=${input.secretId}` +
    `&q-sign-time=${input.keyTime}&q-key-time=${input.keyTime}` +
    `&q-header-list=${headerKeys.join(';')}&q-url-param-list=&q-signature=${signature}`
  );
}

/** One short-lived PUT signed for one exact object, type and byte length. */
export function prepareCosUpload(
  grant: MioraCosGrant,
  fileName: string,
  contentType: string,
  contentLength: number,
  nowSeconds = Math.floor(Date.now() / 1000)
): MioraCosUploadRequest {
  const key = `${grant.prefix}/${fileName}`;
  const host = `${grant.bucket}.cos.${grant.region}.myqcloud.com`;
  const keyTime = `${nowSeconds};${nowSeconds + 600}`;
  const signedHeaders: Record<string, string> = {
    host,
    'x-cos-security-token': grant.token,
    'content-type': contentType || 'application/octet-stream',
    'content-length': String(contentLength)
  };
  return {
    key,
    url: `https://${host}/${key}`,
    headers: {
      'x-cos-security-token': grant.token,
      'content-type': signedHeaders['content-type']!,
      'content-length': signedHeaders['content-length']!,
      authorization: cosAuth({
        secretId: grant.secret_id,
        secretKey: grant.secret_key,
        method: 'put',
        pathname: `/${key}`,
        headers: signedHeaders,
        keyTime
      })
    },
    expiresAt: new Date((nowSeconds + 600) * 1000).toISOString()
  };
}

/** A short-lived signed HEAD used to verify a client PUT before accepting it. */
export function prepareCosHead(grant: MioraCosGrant, key: string, nowSeconds = Math.floor(Date.now() / 1000)): MioraCosHeadRequest {
  if (!key.startsWith(`${grant.prefix}/`)) throw new Error('COS object is outside the current Miora upload prefix');
  const host = `${grant.bucket}.cos.${grant.region}.myqcloud.com`;
  const keyTime = `${nowSeconds};${nowSeconds + 600}`;
  const signedHeaders: Record<string, string> = { host, 'x-cos-security-token': grant.token };
  return {
    url: `https://${host}/${key}`,
    headers: {
      'x-cos-security-token': grant.token,
      authorization: cosAuth({ secretId: grant.secret_id, secretKey: grant.secret_key, method: 'head', pathname: `/${key}`, headers: signedHeaders, keyTime })
    }
  };
}

/**
 * Upload one file to Miora's COS bucket and return its object key — the value
 * the generation endpoints take in `referenceImageFileKeys` and friends.
 *
 * Two steps: ask `/cos/sts-tokens` for temporary keys, then PUT the bytes
 * straight to `*.myqcloud.com` with a signature we compute. No credits are
 * spent; it only uses the account's storage.
 */
export async function uploadToCos(
  grant: MioraCosGrant,
  buffer: Buffer,
  fileName: string,
  contentType: string,
  signal?: AbortSignal
): Promise<string> {
  const key = `${grant.prefix}/${fileName}`;
  const host = `${grant.bucket}.cos.${grant.region}.myqcloud.com`;
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + 600}`;
  const headers: Record<string, string> = {
    host,
    'x-cos-security-token': grant.token,
    'content-type': contentType || 'application/octet-stream',
    'content-length': String(buffer.length)
  };
  const authorization = cosAuth({
    secretId: grant.secret_id,
    secretKey: grant.secret_key,
    method: 'put',
    pathname: `/${key}`,
    headers,
    keyTime
  });
  // Direct to Tencent COS: no proxy, the same reasoning as the other channels'
  // object-storage uploads — a signed PUT with no token to expose.
  const response = await fetch(`https://${host}/${key}`, {
    method: 'PUT',
    headers: { ...headers, authorization },
    body: buffer,
    signal
  });
  if (response.status !== 200) {
    const detail = await response.text().catch(() => '');
    throw new Error(`COS PUT ${key} failed: HTTP ${response.status} ${detail.slice(0, 150)}`);
  }
  return key;
}

/* -------------------------------------------------------------------------- */
/* Carrying a credential through the session store                             */
/* -------------------------------------------------------------------------- */

/** Turn the two tokens into the cookie set a session record carries. */
export function mioraTokenCookies(tokens: MioraTokens, origin = MIORA_ORIGIN): BrowserCookie[] {
  const domain = new URL(origin).hostname;
  const base = { domain, path: '/', secure: true, sameSite: 'Lax' as const };
  const cookies: BrowserCookie[] = [{ name: MIORA_AT_COOKIE, value: tokens.authToken, ...base }];
  if (tokens.refreshToken) cookies.push({ name: MIORA_RT_COOKIE, value: tokens.refreshToken, ...base });
  // The site cookie string is stored under its own name; its value is opaque
  // here (it is a whole `name=value; …` blob, not a real cookie to be parsed).
  if (tokens.cookie) cookies.push({ name: MIORA_COOKIE_COOKIE, value: tokens.cookie, ...base });
  return cookies;
}

export function readMioraTokens(cookies: readonly BrowserCookie[]): MioraTokens | undefined {
  const authToken = cookies.find((cookie) => cookie.name === MIORA_AT_COOKIE)?.value;
  if (!authToken) return undefined;
  const refreshToken = cookies.find((cookie) => cookie.name === MIORA_RT_COOKIE)?.value;
  const cookie = cookies.find((cookie) => cookie.name === MIORA_COOKIE_COOKIE)?.value;
  return { authToken, ...(refreshToken ? { refreshToken } : {}), ...(cookie ? { cookie } : {}) };
}

interface MioraJwtClaims {
  sub?: unknown;
  iat?: unknown;
  exp?: unknown;
  scopes?: unknown;
}

function decodeJwt(token: string): MioraJwtClaims | undefined {
  const part = token.split('.')[1];
  if (!part) return undefined;
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as MioraJwtClaims;
  } catch {
    return undefined;
  }
}

/** Best-effort decode of the authToken so accounts can be told apart. */
export function describeMioraToken(authToken: string): ProviderAccount | undefined {
  const claims = decodeJwt(authToken);
  if (!claims) return undefined;
  const userId =
    typeof claims.sub === 'string' ? claims.sub : typeof claims.sub === 'number' ? String(claims.sub) : undefined;
  return {
    userId,
    expiresAt: typeof claims.exp === 'number' ? new Date(claims.exp * 1000).toISOString() : undefined
  };
}

/** Stable per-account id from the JWT subject, or a hash when it cannot be read. */
export function mioraSessionId(authToken: string): string {
  const userId = describeMioraToken(authToken)?.userId;
  if (userId) return `miora-${userId}`;
  return `miora-${createHash('sha256').update(authToken).digest('hex').slice(0, 12)}`;
}

/** Diagnostic only: the desktop workbench does not reject an empty scopes array. */
export function hasUsableScopes(authToken: string): boolean {
  const scopes = decodeJwt(authToken)?.scopes;
  return Array.isArray(scopes) && scopes.length > 0;
}

export function tokenExpiresAt(authToken: string): number | undefined {
  const claims = decodeJwt(authToken);
  return typeof claims?.exp === 'number' ? claims.exp * 1000 : undefined;
}

/** When the authToken was issued, in ms; tells a rotated token from the one it replaced. */
export function tokenIssuedAt(authToken: string): number | undefined {
  const claims = decodeJwt(authToken);
  return typeof claims?.iat === 'number' ? claims.iat * 1000 : undefined;
}

export function tokenLifetimeMs(authToken: string): number | undefined {
  const claims = decodeJwt(authToken);
  if (typeof claims?.iat !== 'number' || typeof claims?.exp !== 'number') return undefined;
  const lifetime = (claims.exp - claims.iat) * 1000;
  return lifetime > 0 ? lifetime : undefined;
}
