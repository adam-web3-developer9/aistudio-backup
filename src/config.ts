import path from 'node:path';
import { parseRetryDelays } from './adapters/hailuo-retry.js';

try {
  process.loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve('./.playwright-browsers');

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function hailuoDuration(value: string | undefined): number {
  return Math.max(4, Math.min(15, positiveInteger(value, 5)));
}

function hailuoResolution(value: string | undefined): '768' | '1440' {
  return value === '1440' || value?.toLowerCase() === '2k' ? '1440' : '768';
}

/**
 * The known modes are text2video, image2video, firstLastFrame, imageReference
 * and allReference, but the value is not checked against that list: the
 * platform owns it and can add to it.
 */
function dreamMakerMode(value: string | undefined): string {
  return value?.trim() || 'image2video';
}

/** A default only; the real range is per model and enforced by the platform. */
function dreamMakerDuration(value: string | undefined): number {
  return positiveInteger(value, 5);
}

/**
 * How a Higgsfield generation treats its references.
 *
 *   t2v             prompt only
 *   omni_reference  image, video or audio references (the default for a job
 *                   that carries a reference image)
 *   video_edit      edit one reference video. Billed by **that video's own
 *                   duration**, and `duration` / `aspect_ratio` are ignored —
 *                   which is why a two-second source is the cheapest input
 *                   there is, whatever length the prompt then asks for.
 *   video_extension extend a reference video
 *
 * Blank leaves it to the platform. The value is checked here because a wrong
 * one changes what a job costs and is rejected only at submission.
 */
const HIGGSFIELD_MODES = new Set(['t2v', 'omni_reference', 'video_edit', 'video_extension']);

function higgsfieldMode(value: string | undefined): string | undefined {
  const mode = value?.trim();
  if (!mode) return undefined;
  if (!HIGGSFIELD_MODES.has(mode)) {
    throw new Error(`HIGGSFIELD_MODE must be one of ${[...HIGGSFIELD_MODES].join(', ')} (got "${value}")`);
  }
  return mode;
}

export type HailuoProxyMode = 'iproyal' | 'local' | 'direct';

/**
 * Which exit Hailuo traffic leaves through. One switch for both the signed API
 * calls and the browser, because every request carries an account `_token` and
 * one account must always show up from one IP.
 *
 *   iproyal  the residential proxy in HAILUO_PROXY_URL
 *   local    the proxy client running on this machine (HAILUO_LOCAL_PROXY_URL,
 *            default Clash/mihomo on 127.0.0.1:7897)
 *   direct   no proxy
 *
 * Unset falls back to `iproyal` when HAILUO_PROXY_URL is set, else `direct`, so
 * existing .env files keep working.
 */
function resolveHailuoProxy(env: NodeJS.ProcessEnv): { mode: HailuoProxyMode; url?: string } {
  const iproyalUrl = env.HAILUO_PROXY_URL?.trim() || undefined;
  const localUrl = env.HAILUO_LOCAL_PROXY_URL?.trim() || 'http://127.0.0.1:7897';
  const raw = env.HAILUO_PROXY?.trim().toLowerCase();
  const mode: HailuoProxyMode = raw ? (raw as HailuoProxyMode) : iproyalUrl ? 'iproyal' : 'direct';

  switch (mode) {
    case 'iproyal':
      if (!iproyalUrl) throw new Error('HAILUO_PROXY=iproyal needs HAILUO_PROXY_URL');
      return { mode, url: iproyalUrl };
    case 'local':
      return { mode, url: localUrl };
    case 'direct':
      return { mode };
    default:
      throw new Error(`HAILUO_PROXY must be iproyal, local or direct (got "${env.HAILUO_PROXY}")`);
  }
}

const hailuoProxy = resolveHailuoProxy(process.env);

export type HailuoTransport = 'api' | 'browser';

/**
 * How Hailuo is called, independent of which exit the traffic takes.
 *
 *   api      sign the requests ourselves and send them from Node (current path)
 *   browser  drive the web app's own axios inside a Playwright page, so signature,
 *            device identity and fingerprint come from Hailuo's code
 *            (design: docs/browser-injected-api.md — not wired in yet)
 */
function resolveHailuoTransport(value: string | undefined): HailuoTransport {
  const transport = value?.trim().toLowerCase() || 'api';
  if (transport === 'api' || transport === 'browser') return transport;
  throw new Error(`HAILUO_TRANSPORT must be api or browser (got "${value}")`);
}

export const config = {
  host: process.env.HOST ?? '0.0.0.0',
  port: positiveInteger(process.env.PORT, 3000),
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://127.0.0.1:3000',
  hailuoCreateUrl: process.env.HAILUO_CREATE_URL ?? 'https://hailuoai.com/create/image-to-video',
  /**
   * The proxy applies to Hailuo only — the signed API calls and the browser. It
   * is deliberately not `HTTPS_PROXY`: a process-wide proxy would also capture
   * the Aliyun OSS uploads, which residential proxies drop. `hailuoProxyUrl` is
   * the resolved exit for `hailuoProxyMode`; undefined means direct.
   */
  hailuoProxyMode: hailuoProxy.mode,
  hailuoProxyUrl: hailuoProxy.url,
  hailuoTransport: resolveHailuoTransport(process.env.HAILUO_TRANSPORT),
  apiKey: process.env.API_KEY,
  /**
   * Hailuo account credentials live in a text file, one token per line. The file
   * is re-read while the service runs, so edits take effect without a restart.
   * API_KEY is unrelated: it gates this service's own /v1/* routes.
   */
  hailuoTokenFile: path.resolve(process.env.HAILUO_TOKEN_FILE ?? './tokens.txt'),
  /** Fallback poll for token-file edits that `fs.watch` does not report. */
  hailuoTokenPollMs: positiveInteger(process.env.HAILUO_TOKEN_POLL_MS, 5_000),
  /** Defaults for a generation job; every field is overridable per request. */
  hailuoVideo: {
    modelId: 'hailuo3.0-i2v',
    resolution: hailuoResolution(process.env.HAILUO_RESOLUTION),
    duration: hailuoDuration(process.env.HAILUO_DURATION),
    aspectRatio: process.env.HAILUO_ASPECT_RATIO ?? '16:9',
    referenceMode: 'all-reference',
    frameType: 4
  },
  /** Rendering takes ~1-3 min, well past the browser-job timeout. */
  hailuoPollTimeoutMs: positiveInteger(process.env.HAILUO_POLL_TIMEOUT_MS, 15 * 60_000),
  hailuoPollIntervalMs: positiveInteger(process.env.HAILUO_POLL_INTERVAL_MS, 10_000),
  /**
   * Back-off between tries of one failing Hailuo step (credits, upload, submit,
   * poll, render). Three retries at 10s / 30s / 60s by default; `none` disables.
   * Callers only see the verdict after the last try.
   */
  hailuoRetryDelaysMs: parseRetryDelays(process.env.HAILUO_RETRY_DELAYS_MS),
  /** How long a credit reading is trusted before the pool re-checks. */
  /**
   * DreamMaker (dreammaker.vobile.com.cn) — a second channel, reached over its
   * plain REST API. It needs no browser and no signature; an account is an
   * access token, or a username and password this service logs in with.
   */
  dreamMakerOrigin: process.env.DREAMMAKER_ORIGIN ?? 'https://dreammaker.vobile.com.cn',
  /** One line per account: an access token, or `username:password`. Re-read while running. */
  dreamMakerAccountFile: path.resolve(process.env.DREAMMAKER_ACCOUNT_FILE ?? './dreammaker-accounts.txt'),
  /** Mainland host, so direct by default; set only if this service needs a way out. */
  dreamMakerProxyUrl: process.env.DREAMMAKER_PROXY_URL?.trim() || undefined,
  dreamMakerVideo: {
    /** Any `toolKey` from `/api/tool_spec/list`; the cheapest usable one by default (500 credits/second). */
    model: process.env.DREAMMAKER_MODEL?.trim() || 'minimax-h3',
    mode: dreamMakerMode(process.env.DREAMMAKER_MODE),
    resolution: process.env.DREAMMAKER_RESOLUTION?.trim() || '768p',
    duration: dreamMakerDuration(process.env.DREAMMAKER_DURATION),
    /** `adaptive` keeps the aspect ratio of the uploaded image. */
    aspectRatio: process.env.DREAMMAKER_ASPECT_RATIO?.trim() || 'adaptive'
  },
  dreamMakerPollTimeoutMs: positiveInteger(process.env.DREAMMAKER_POLL_TIMEOUT_MS, 15 * 60_000),
  dreamMakerPollIntervalMs: positiveInteger(process.env.DREAMMAKER_POLL_INTERVAL_MS, 10_000),
  dreamMakerRetryDelaysMs: parseRetryDelays(
    process.env.DREAMMAKER_RETRY_DELAYS_MS,
    undefined,
    'DREAMMAKER_RETRY_DELAYS_MS'
  ),
  /** How often password accounts are checked for a token that is about to lapse. */
  dreamMakerTokenCheckMs: positiveInteger(process.env.DREAMMAKER_TOKEN_CHECK_MS, 60 * 60_000),
  /**
   * Higgsfield (higgsfield.ai) — a third channel, reached over its own API
   * gateway. No browser and no signature; an account is the Clerk `__client`
   * cookie, from which short-lived bearer tokens are minted per call.
   */
  higgsfieldOrigin: process.env.HIGGSFIELD_ORIGIN ?? 'https://fnf-api-gw.higgsfield.ai/fnf',
  /** Clerk's frontend API for this tenant; where `__session` JWTs come from. */
  higgsfieldClerkOrigin: process.env.HIGGSFIELD_CLERK_ORIGIN ?? 'https://clerk.higgsfield.ai',
  /** The site the credential cookies belong to — used only to label them. */
  higgsfieldSiteOrigin: process.env.HIGGSFIELD_SITE_ORIGIN ?? 'https://higgsfield.ai',
  /** One `__client` cookie per line. Re-read while running. */
  higgsfieldAccountFile: path.resolve(process.env.HIGGSFIELD_ACCOUNT_FILE ?? './higgsfield-accounts.txt'),
  /** Covers the gateway and Clerk; the presigned media uploads stay direct. */
  higgsfieldProxyUrl: process.env.HIGGSFIELD_PROXY_URL?.trim() || undefined,
  higgsfieldVideo: {
    /** The platform's model id: seedance_2_5, minimax_hailuo, wan2_6, … */
    model: process.env.HIGGSFIELD_MODEL?.trim() || 'seedance_2_5',
    /**
     * Generation mode; see `higgsfieldMode`. `video_edit` is the default
     * because it is what this channel is used for: billed by the seed clip's
     * two seconds whatever length the prompt asks for.
     */
    mode: higgsfieldMode(process.env.HIGGSFIELD_MODE) ?? 'video_edit',
    /** The clip video_edit edits when a job brings none; its duration is the bill. */
    editSeedVideo: path.resolve(process.env.HIGGSFIELD_EDIT_SEED_VIDEO ?? './assets/higgsfield-edit-seed.mp4'),
    /** That clip's length, and so what a video_edit job is quoted at. Follow the file. */
    editSeedSeconds: positiveInteger(process.env.HIGGSFIELD_EDIT_SEED_SECONDS, 2),
    resolution: process.env.HIGGSFIELD_RESOLUTION?.trim() || '720p',
    duration: positiveInteger(process.env.HIGGSFIELD_DURATION, 5),
    aspectRatio: process.env.HIGGSFIELD_ASPECT_RATIO?.trim() || '16:9'
  },
  higgsfieldPollTimeoutMs: positiveInteger(process.env.HIGGSFIELD_POLL_TIMEOUT_MS, 15 * 60_000),
  higgsfieldPollIntervalMs: positiveInteger(process.env.HIGGSFIELD_POLL_INTERVAL_MS, 10_000),
  higgsfieldRetryDelaysMs: parseRetryDelays(
    process.env.HIGGSFIELD_RETRY_DELAYS_MS,
    undefined,
    'HIGGSFIELD_RETRY_DELAYS_MS'
  ),
  /**
   * Miora (miora.design) — a fourth channel, reached over its `/api/ai` REST
   * API. No browser and no signature; an account is an authToken (+ a refresh
   * token this service renews from). Wired for the minimax-h3 model only.
   */
  /** One JSON object per line: `{authToken, refreshToken?}`. Re-read while running. */
  mioraAccountFile: path.resolve(process.env.MIORA_ACCOUNT_FILE ?? './miora-accounts.txt'),
  /** Drop miora.design site-state exports here; they are imported into the account file automatically. */
  mioraImportDir: path.resolve(process.env.MIORA_IMPORT_DIR ?? './miora-imports'),
  /**
   * Credits, generation submissions and task progress reads share these proxy routes.
   * All other API calls and COS reference uploads stay direct.
   * Unset means the local proxy client is the primary exit (direct is the fallback),
   * so credits, submissions and task progress reads go through a proxy by default.
   */
  mioraProxyUrl: process.env.MIORA_PROXY_URL?.trim() || undefined,
  /** Optional verified proxy gateway address when local DNS resolves it incorrectly. */
  mioraProxyAddress: process.env.MIORA_PROXY_ADDRESS?.trim() || undefined,
  /** Auto follows the current Windows system proxy; an explicit URL overrides it. */
  mioraLocalProxyUrl: process.env.MIORA_LOCAL_PROXY_URL?.trim() || 'auto',
  mioraVideo: {
    /** The catalog `modelId`; minimax-h3 ("全能参考", multimodal reference) by default. */
    model: process.env.MIORA_MODEL?.trim() || 'minimax-h3',
    /** minimax-h3: "768P" | "2K". */
    resolution: process.env.MIORA_RESOLUTION?.trim() || '768P',
    duration: positiveInteger(process.env.MIORA_DURATION, 5),
    /** `adaptive` keeps the reference's aspect ratio. */
    aspectRatio: process.env.MIORA_ASPECT_RATIO?.trim() || '16:9'
  },
  mioraPollTimeoutMs: positiveInteger(process.env.MIORA_POLL_TIMEOUT_MS, 15 * 60_000),
  mioraPollIntervalMs: positiveInteger(process.env.MIORA_POLL_INTERVAL_MS, 5_000),
  mioraRetryDelaysMs: parseRetryDelays(process.env.MIORA_RETRY_DELAYS_MS, undefined, 'MIORA_RETRY_DELAYS_MS'),
  mioraPublicMediaHosts: (process.env.MIORA_PUBLIC_MEDIA_HOSTS ?? '.volces.com,.volcengine.com,.myqcloud.com')
    .split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
  /** How often authTokens are checked for one about to lapse. */
  mioraTokenCheckMs: positiveInteger(process.env.MIORA_TOKEN_CHECK_MS, 60 * 60_000),
  creditsCacheTtlMs: positiveInteger(process.env.CREDITS_CACHE_TTL_MS, 60_000),
  browserPoolSize: positiveInteger(process.env.BROWSER_POOL_SIZE, 2),
  browserHeadless: process.env.BROWSER_HEADLESS !== 'false',
  maxUploadBytes: positiveInteger(process.env.MAX_UPLOAD_BYTES, 10 * 1024 * 1024),
  dataDir: path.resolve(process.env.DATA_DIR ?? './data'),
  jobTimeoutMs: positiveInteger(process.env.JOB_TIMEOUT_MS, 120_000),
  /**
   * Finished job records older than this are deleted from the data directory.
   * Hailuo's video URLs expire after about a day, so a longer default only keeps dead links.
   */
  jobRetentionDays: positiveInteger(process.env.JOB_RETENTION_DAYS, 1)
};
