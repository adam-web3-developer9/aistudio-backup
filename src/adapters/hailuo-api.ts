import { createHash } from 'node:crypto';
import { fetch, ProxyAgent, type Dispatcher } from 'undici';
import type { BrowserCookie, CreditBalance, HailuoAccount, ModelCost } from '../types.js';

export const HAILUO_TOKEN_COOKIE = '_token';
export const CREDIT_API_PATH = '/v1/api/user/equity';

/**
 * Proxy scope is an allow-list of exactly one host: Hailuo.
 *
 * Every call in this file carries the account `_token`, so they all have to leave
 * from the same IP or Hailuo's risk control sees one account hopping countries.
 * Nothing else is proxied — in particular the OSS reference-image upload, which
 * is a multi-MB PUT straight to Aliyun under an STS signature, carries no token,
 * and gets killed by residential proxies (`UND_ERR_SOCKET` after ~67s).
 *
 * Set once at boot from `config.hailuoProxyUrl`; unset means direct.
 */
let hailuoDispatcher: Dispatcher | undefined;

export function useHailuoProxy(proxyUrl?: string): void {
  hailuoDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
}

/**
 * Query params the web app appends to every call (`getPublicParams` in the bundle).
 * The browser also sends screen/CPU fingerprint fields; the signature only has to
 * cover what we actually send, so the minimal set is enough.
 */
export interface PublicParams {
  deviceId?: string;
  uuid?: string;
}

function publicParams(unix: string, extra: PublicParams = {}): URLSearchParams {
  const params = new URLSearchParams([
    ['device_platform', 'web'],
    ['app_id', '3001'],
    ['version_code', '22203'],
    ['biz_id', '0'],
    ['unix', unix],
    ['lang', 'zh-Hans']
  ]);
  if (extra.uuid) params.set('uuid', extra.uuid);
  if (extra.deviceId) params.set('device_id', extra.deviceId);
  return params;
}

/**
 * The `yy` request signature.
 *
 * From the web bundle's axios interceptor:
 *   body = (POST|DELETE) ? JSON.stringify(data ?? {}) : JSON.stringify({})
 *   yy   = md5(encodeURIComponent(path + '?' + params) + '_' + body + md5(unix) + 'ooui')
 *
 * The signed body string is also what goes on the wire, so callers must send
 * exactly the `body` returned here — re-serializing could reorder keys.
 */
export function signRequest(options: {
  path: string;
  method: string;
  unix: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  publicParams?: PublicParams;
}): { pathWithQuery: string; yy: string; body: string } {
  const params = publicParams(options.unix, options.publicParams);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) params.set(key, String(value));
  }

  const method = options.method.toLowerCase();
  const signedBody = method === 'post' || method === 'delete' ? options.body ?? {} : {};
  const body = JSON.stringify(signedBody);

  const pathWithQuery = `${options.path}?${params.toString()}`;
  return {
    pathWithQuery,
    body,
    yy: md5(`${encodeURIComponent(pathWithQuery)}_${body}${md5(options.unix)}ooui`)
  };
}

export interface HailuoRequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  publicParams?: PublicParams;
  signal?: AbortSignal;
}

export class HailuoApiError extends Error {
  constructor(
    readonly code: number | string,
    readonly apiMessage: string,
    readonly path: string
  ) {
    super(`Hailuo ${path} failed (${code}): ${apiMessage}`);
  }
}

const GENERATE_VIDEO_PATH = '/v2/api/multimodal/generate/video';
const HAILUO3_CREDITS_PER_SECOND = {
  '768': 7,
  '1440': 12
} as const;

/** The account passed local pricing but Hailuo rejected the submission for lack of usable credits. */
export function isHailuoInsufficientCreditsError(error: unknown): error is HailuoApiError {
  return error instanceof HailuoApiError
    && error.path === GENERATE_VIDEO_PATH
    && /(?:贝壳|积分|余额).{0,8}(?:不足|不够)|insufficient.{0,12}(?:credits?|shells?|balance)/i
      .test(error.apiMessage.replace(/\s+/g, ' ').trim());
}

/** One signed call against the Hailuo web API. Returns the unwrapped `data` field. */
export async function hailuoRequest<T = unknown>(
  origin: string,
  token: string,
  path: string,
  options: HailuoRequestOptions = {}
): Promise<T> {
  const method = options.method ?? 'GET';
  const { pathWithQuery, yy, body } = signRequest({
    path,
    method,
    unix: String(Date.now()),
    query: options.query,
    body: options.body,
    publicParams: options.publicParams
  });

  const response = await fetch(`${origin}${pathWithQuery}`, {
    method,
    headers: {
      'content-type': 'application/json',
      token,
      yy,
      cookie: `${HAILUO_TOKEN_COOKIE}=${token}`
    },
    body: method === 'GET' ? undefined : body,
    dispatcher: hailuoDispatcher,
    signal: options.signal
  });

  if (!response.ok) {
    throw new HailuoApiError(response.status, await response.text().catch(() => ''), path);
  }

  const payload = await response.json() as {
    data?: T;
    statusInfo?: { code?: number; message?: string };
  };
  const status = payload.statusInfo;
  if (status && typeof status.code === 'number' && status.code !== 0) {
    throw new HailuoApiError(status.code, status.message ?? 'unknown error', path);
  }
  return payload.data as T;
}

/** Credit lookup over plain HTTP — no browser context needed. */
export async function fetchCreditsWithToken(origin: string, token: string): Promise<CreditBalance> {
  return parseCreditBalance({
    data: await hailuoRequest(origin, token, CREDIT_API_PATH)
  });
}

export function parseCreditBalance(payload: unknown): CreditBalance {
  if (!payload || typeof payload !== 'object') {
    throw new Error('Hailuo credit API returned an invalid response');
  }

  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== 'object') {
    throw new Error('Hailuo credit API response is missing data');
  }

  const raw = data as { totalCredits?: unknown; modelControl?: unknown };
  if (typeof raw.totalCredits !== 'number' || !Number.isFinite(raw.totalCredits)) {
    throw new Error('Hailuo credit API response is missing totalCredits');
  }

  const models = parseModelCosts(raw.modelControl);
  return {
    totalCredits: raw.totalCredits,
    breakdown: [],
    ...(models && { models })
  };
}

interface RawModelControl {
  modelId?: unknown;
  videoCost?: unknown;
  resolutions?: Array<{ type?: unknown; value?: unknown }>;
  durations?: Array<{ type?: unknown; value?: unknown }>;
  videoCosts?: Array<{ resolutionType?: unknown; durationType?: unknown; videoCost?: unknown }>;
}

function parseModelCosts(modelControl: unknown): ModelCost[] | undefined {
  if (!Array.isArray(modelControl)) return undefined;

  const models = modelControl.flatMap((entry: RawModelControl) => {
    if (typeof entry?.modelId !== 'string') return [];
    return [{
      modelId: entry.modelId,
      defaultCost: typeof entry.videoCost === 'number' ? entry.videoCost : 0,
      resolutions: numberPairs(entry.resolutions),
      durations: numberPairs(entry.durations),
      costs: (entry.videoCosts ?? []).flatMap((cost) =>
        typeof cost?.videoCost === 'number'
          ? [{
            resolutionType: Number(cost.resolutionType) || 0,
            durationType: Number(cost.durationType) || 0,
            cost: cost.videoCost
          }]
          : [])
    }];
  });

  return models.length ? models : undefined;
}

function numberPairs(
  entries: Array<{ type?: unknown; value?: unknown }> | undefined
): Array<{ type: number; value: number }> {
  return (entries ?? []).flatMap((entry) =>
    typeof entry?.type === 'number' && typeof entry?.value === 'number'
      ? [{ type: entry.type, value: entry.value }]
      : []);
}

/**
 * What one generation will cost, from the account's own price list.
 * Returns undefined when the model or the combination is not listed.
 */
export function estimateVideoCost(
  balance: CreditBalance,
  options: { modelId: string; resolution?: string; duration?: number; quantity?: number }
): number | undefined {
  if (options.modelId === 'hailuo3.0-i2v') {
    const resolution = options.resolution ?? '768';
    const duration = options.duration ?? 5;
    const quantity = options.quantity ?? 1;
    if (!(resolution in HAILUO3_CREDITS_PER_SECOND)) return undefined;
    if (!Number.isInteger(duration) || duration < 4 || duration > 15) return undefined;
    if (quantity !== 1) return undefined;
    return HAILUO3_CREDITS_PER_SECOND[resolution as keyof typeof HAILUO3_CREDITS_PER_SECOND] * duration;
  }

  const model = balance.models?.find((entry) => entry.modelId === options.modelId);
  if (!model) return undefined;

  const resolutionType = options.resolution === undefined
    ? undefined
    : model.resolutions.find((entry) => entry.value === Number(options.resolution))?.type;
  const durationType = options.duration === undefined
    ? undefined
    : model.durations.find((entry) => entry.value === options.duration)?.type;

  const match = model.costs.find((cost) =>
    (resolutionType === undefined || cost.resolutionType === resolutionType)
    && (durationType === undefined || cost.durationType === durationType));

  return match?.cost ?? (model.defaultCost || undefined);
}

/** Turn a raw `_token` value into the cookie set a browser context needs. */
export function hailuoTokenCookies(token: string, origin: string): BrowserCookie[] {
  return [
    {
      name: HAILUO_TOKEN_COOKIE,
      value: token,
      domain: `.${new URL(origin).hostname}`,
      path: '/',
      secure: true,
      sameSite: 'Lax'
    }
  ];
}

export function readTokenCookie(cookies: readonly BrowserCookie[]): string | undefined {
  return cookies.find((cookie) => cookie.name === HAILUO_TOKEN_COOKIE)?.value;
}

/** Best-effort decode of the JWT payload so operators can tell accounts apart. */
export function describeHailuoToken(token: string): HailuoAccount | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown;
      user?: { id?: unknown; name?: unknown };
    };
    return {
      userId: typeof decoded.user?.id === 'string' ? decoded.user.id : undefined,
      name: typeof decoded.user?.name === 'string' ? decoded.user.name : undefined,
      expiresAt: typeof decoded.exp === 'number'
        ? new Date(decoded.exp * 1000).toISOString()
        : undefined
    };
  } catch {
    return undefined;
  }
}

function md5(value: string): string {
  return createHash('md5').update(value).digest('hex');
}
