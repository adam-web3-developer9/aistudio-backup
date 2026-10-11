import { fetch } from 'undici';
import type { CreditBalance } from '../types.js';
import {
  COSTS_API_PATH,
  MEDIA_BATCH_API_PATH,
  USER_API_PATH,
  WALLET_API_PATH,
  higgsfieldRequest,
  parseCostTable,
  parseWallet,
  walletToCreditBalance,
  type HiggsfieldCostTable,
  type HiggsfieldRequestOptions,
  type HiggsfieldWallet
} from './higgsfield-api.js';
import {
  HiggsfieldJobFailedError,
  HiggsfieldJobNotFoundError,
  HiggsfieldRenderTimeoutError,
  classifyHiggsfieldError
} from './higgsfield-retry.js';
import { DEFAULT_RETRY_DELAYS_MS, ProviderJobError, sleep, type RetryAttemptInfo } from './provider-retry.js';

/** Supplies a bearer token, minting a fresh one when the last has nearly lapsed. */
export interface HiggsfieldAuth {
  token(signal?: AbortSignal): Promise<string>;
  /** Called after a 401 so the next call mints instead of reusing. */
  invalidate(): void;
}

/** What a media is, as the platform's own `medias[].data.type` spells it. */
export type HiggsfieldMediaKind = 'image' | 'video' | 'audio';

/** A media record the platform has accepted; generations reference it by `id`. */
export interface UploadedMedia {
  id: string;
  /** Readable URL of the stored object, for the job record. */
  url?: string;
  kind: HiggsfieldMediaKind;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
}

export function mediaKindFromMimeType(mimeType: string): HiggsfieldMediaKind {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

/** Where an image goes in a generation's `params`. See `HiggsfieldImageBinding`. */
export type HiggsfieldImageBinding = 'medias' | 'input_image';

export interface GenerateVideoInput {
  /**
   * Which generator to post to: the path segment after `/jobs/`, e.g.
   * `seedance`, `minimax-hailuo`, `image2video`, or `v2/<job_set_type>`.
   */
  jobType: string;
  prompt: string;
  /** Uploaded references; the first image is the start frame. */
  media: UploadedMedia[];
  imageBinding: HiggsfieldImageBinding;
  /** Everything the model itself understands: model, duration, resolution, … */
  params?: Record<string, unknown>;
  /** Flags the gateway reads next to `params`, not inside it. */
  flags?: Record<string, unknown>;
}

export type HiggsfieldJobStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'nsfw' | 'canceled';

export interface HiggsfieldJobResult {
  url?: string;
  type?: string;
}

export interface HiggsfieldJob {
  id: string;
  status: HiggsfieldJobStatus;
  /** `results.raw` — the full-size render. */
  raw?: HiggsfieldJobResult;
  /** `results.min` — the preview the feed shows. */
  preview?: HiggsfieldJobResult;
  /** Whatever the platform said about a failure. */
  reason?: string;
  raw_payload: unknown;
}

export interface HiggsfieldJobSet {
  id: string;
  type?: string;
  jobs: HiggsfieldJob[];
  raw: unknown;
}

const TERMINAL_STATUSES = new Set<HiggsfieldJobStatus>(['completed', 'failed', 'nsfw', 'canceled']);

/** Direct client for the Higgsfield gateway — the same calls the web app makes. */
export class HiggsfieldClient {
  constructor(
    private readonly origin: string,
    private readonly auth: HiggsfieldAuth,
    private readonly workspaceId?: string
  ) {}

  async getWallet(signal?: AbortSignal): Promise<HiggsfieldWallet> {
    return parseWallet(await this.request(WALLET_API_PATH, { signal }));
  }

  async getCredits(signal?: AbortSignal): Promise<CreditBalance> {
    return walletToCreditBalance(await this.getWallet(signal));
  }

  async getUser(signal?: AbortSignal): Promise<Record<string, unknown> | undefined> {
    return this.request<Record<string, unknown>>(USER_API_PATH, { signal });
  }

  /** Per-generator price list. Charges nothing; the shape is the platform's. */
  async getCosts(signal?: AbortSignal): Promise<HiggsfieldCostTable> {
    return parseCostTable(await this.request(COSTS_API_PATH, { signal }));
  }

  /**
   * Upload an image: `media/batch` hands out a record with a presigned URL, the
   * bytes go straight to object storage, and `media/{id}/upload` confirms it and
   * runs the platform's own checks. No credits are involved.
   */
  async uploadImage(input: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    signal?: AbortSignal;
  }): Promise<UploadedMedia> {
    const created = await this.request<Array<{
      id?: string;
      url?: string;
      upload_url?: string;
      content_type?: string;
    }>>(MEDIA_BATCH_API_PATH, {
      method: 'POST',
      body: { mimetypes: [input.mimeType], source: 'user_upload' },
      signal: input.signal
    });

    const media = created?.[0];
    if (!media?.id || !media.upload_url) {
      throw new Error('Higgsfield /media/batch returned no upload target');
    }

    const contentType = media.content_type || input.mimeType;
    // Straight to object storage: presigned, no bearer token, and deliberately
    // not proxied — the same reasoning as the other channels' uploads.
    const put = await fetch(media.upload_url, {
      method: 'PUT',
      headers: { 'content-type': contentType },
      body: new Uint8Array(input.buffer),
      signal: input.signal
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => '');
      throw new Error(`Storage PUT ${media.id} failed: HTTP ${put.status} ${detail.slice(0, 200)}`);
    }

    await this.request(`/media/${encodeURIComponent(media.id)}/upload`, {
      method: 'POST',
      body: {
        filename: input.fileName,
        force_nsfw_check: false,
        force_ip_check: false
      },
      signal: input.signal
    });

    return {
      id: media.id,
      url: media.url,
      kind: mediaKindFromMimeType(contentType),
      mimeType: contentType,
      fileName: input.fileName,
      sizeBytes: input.buffer.byteLength
    };
  }

  /**
   * Submit a generation. The gateway takes `{params, …flags}`; which key the
   * images go under is per generator, hence `imageBinding`.
   */
  async generateVideo(input: GenerateVideoInput, signal?: AbortSignal): Promise<HiggsfieldJobSet> {
    const params: Record<string, unknown> = {
      prompt: input.prompt,
      ...input.params,
      ...bindMedia(input.media, input.imageBinding)
    };

    const payload = await this.request<unknown>(`/jobs/${input.jobType}`, {
      method: 'POST',
      body: { params, ...input.flags },
      signal
    });

    const jobSet = firstJobSet(payload);
    if (!jobSet) throw new Error(`Higgsfield /jobs/${input.jobType} returned no job set`);
    return jobSet;
  }

  async getJobSet(jobSetId: string, signal?: AbortSignal): Promise<HiggsfieldJobSet> {
    let payload: unknown;
    try {
      payload = await this.request(`/job-sets/${encodeURIComponent(jobSetId)}`, { signal });
    } catch (error) {
      if (classifyHiggsfieldError(error).kind === 'not_found') throw new HiggsfieldJobNotFoundError(jobSetId);
      throw error;
    }
    const jobSet = firstJobSet(payload);
    if (!jobSet) throw new HiggsfieldJobNotFoundError(jobSetId);
    return jobSet;
  }

  /**
   * Poll until every job in the set settles or `timeoutMs` runs out.
   *
   * A poll that fails (cannot reach the gateway, does not find the set yet) is
   * not a verdict on the render, which keeps going upstream. Such polls are
   * retried on `retryDelaysMs`; only when every retry in a row fails does the
   * wait give up, and a successful poll resets the count.
   */
  async waitForJobSet(jobSetId: string, options: {
    timeoutMs: number;
    intervalMs?: number;
    retryDelaysMs?: readonly number[];
    signal?: AbortSignal;
    onPoll?: (jobSet: HiggsfieldJobSet) => void;
    onPollRetry?: (info: RetryAttemptInfo) => void;
  }): Promise<HiggsfieldJobSet> {
    const interval = options.intervalMs ?? 10_000;
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const deadline = Date.now() + options.timeoutMs;
    let consecutiveFailures = 0;

    for (;;) {
      let jobSet: HiggsfieldJobSet;
      try {
        jobSet = await this.getJobSet(jobSetId, options.signal);
        consecutiveFailures = 0;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const failure = classifyHiggsfieldError(error);
        if (!failure.retryable || consecutiveFailures >= retryDelays.length) {
          throw new ProviderJobError(failure, consecutiveFailures + 1, 'poll', { cause: error });
        }
        const delayMs = retryDelays[consecutiveFailures]!;
        consecutiveFailures += 1;
        options.onPollRetry?.({
          step: 'poll',
          attempt: consecutiveFailures,
          maxAttempts: retryDelays.length + 1,
          delayMs,
          failure
        });
        await sleep(delayMs, options.signal);
        continue;
      }
      options.onPoll?.(jobSet);

      if (jobSet.jobs.length && jobSet.jobs.every((job) => TERMINAL_STATUSES.has(job.status))) {
        const succeeded = jobSet.jobs.find((job) => job.status === 'completed');
        if (succeeded) return jobSet;
        const failed = jobSet.jobs[0]!;
        throw new HiggsfieldJobFailedError(failed.id, failed.status, failed.reason ?? 'unknown reason');
      }
      if (Date.now() + interval > deadline) {
        throw new HiggsfieldRenderTimeoutError(jobSetId, options.timeoutMs);
      }
      await sleep(interval, options.signal);
    }
  }

  private request<T>(path: string, options: HiggsfieldRequestOptions = {}): Promise<T> {
    return this.authorized((token) => higgsfieldRequest<T>(this.origin, token, path, {
      workspaceId: this.workspaceId,
      ...options
    }), options.signal);
  }

  /**
   * Run one call with a fresh-enough bearer token. A 401 means the minted JWT
   * lapsed between minting and arriving (it lives about a minute), so the token
   * is dropped and the call made once more before the error stands.
   */
  private async authorized<T>(
    run: (token: string) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const token = await this.auth.token(signal);
    try {
      return await run(token);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (classifyHiggsfieldError(error).kind !== 'auth') throw error;
      this.auth.invalidate();
      return run(await this.auth.token(signal));
    }
  }
}

/**
 * Where the references go.
 *
 * Two conventions live side by side in the platform:
 *
 * - `medias`: a role-tagged list, `{role, data: {id, type}}`. Roles are
 *   `start_image` / `end_image` / `image` / `video` / `audio`, and `type` is
 *   the media's own kind — so this is the shape that can carry reference
 *   video and audio, not just stills.
 * - `input_image` / `input_image_end`: bare media ids, images only. The
 *   generators added first (`image2video`, `minimax-hailuo`, `kling`) take
 *   this one, and anything that is not an image simply has nowhere to go.
 *
 * Which one a generator wants is not discoverable from the API, so it is
 * configuration rather than a guess made per request.
 */
export function bindMedia(media: readonly UploadedMedia[], binding: HiggsfieldImageBinding): Record<string, unknown> {
  if (!media.length) return {};

  if (binding === 'input_image') {
    const images = media.filter((item) => item.kind === 'image');
    if (!images.length) return {};
    return {
      input_image: images[0]!.id,
      ...(images.length > 1 ? { input_image_end: images[1]!.id } : {})
    };
  }

  let imageIndex = 0;
  return {
    medias: media.map((item) => {
      if (item.kind !== 'image') return { role: item.kind, data: { id: item.id, type: item.kind } };
      // The first still is the frame the shot starts on; the rest are references.
      const role = imageIndex++ === 0 ? 'start_image' : 'image';
      return { role, data: { id: item.id, type: item.kind } };
    })
  };
}

/** Submissions answer `{job_sets:[…]}`, reads answer one set; accept either. */
function firstJobSet(payload: unknown): HiggsfieldJobSet | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as { job_sets?: unknown; data?: unknown };
  const candidate = Array.isArray(record.job_sets)
    ? record.job_sets[0]
    : record.data && typeof record.data === 'object' ? record.data : payload;
  return normalizeJobSet(candidate);
}

export function normalizeJobSet(payload: unknown): HiggsfieldJobSet | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as {
    id?: unknown;
    job_set_id?: unknown;
    type?: unknown;
    job_set_type?: unknown;
    jobs?: unknown;
  };
  const id = [record.id, record.job_set_id].find(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  if (!id) return undefined;

  return {
    id,
    type: [record.type, record.job_set_type].find((value): value is string => typeof value === 'string'),
    jobs: Array.isArray(record.jobs) ? record.jobs.flatMap(normalizeJob) : [],
    raw: payload
  };
}

function normalizeJob(payload: unknown): HiggsfieldJob[] {
  if (!payload || typeof payload !== 'object') return [];
  const record = payload as {
    id?: unknown;
    status?: unknown;
    results?: { raw?: unknown; min?: unknown } | null;
    reason?: unknown;
    error?: unknown;
    error_message?: unknown;
    failure_reason?: unknown;
  };
  if (typeof record.id !== 'string') return [];

  const reason = [record.reason, record.error_message, record.failure_reason, record.error]
    .find((value): value is string => typeof value === 'string' && value.length > 0);

  return [{
    id: record.id,
    status: toStatus(record.status),
    raw: toResult(record.results?.raw),
    preview: toResult(record.results?.min),
    reason,
    raw_payload: payload
  }];
}

function toResult(value: unknown): HiggsfieldJobResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as { url?: unknown; type?: unknown };
  if (typeof record.url !== 'string' || !record.url) return undefined;
  return { url: record.url, type: typeof record.type === 'string' ? record.type : undefined };
}

function toStatus(status: unknown): HiggsfieldJobStatus {
  switch (status) {
    case 'queued':
    case 'in_progress':
    case 'completed':
    case 'failed':
    case 'nsfw':
    case 'canceled':
      return status;
    default:
      // An unknown status is treated as still running: the poll keeps asking
      // rather than declaring a verdict the platform did not give.
      return 'in_progress';
  }
}

/** The finished video: the full-size render, else whatever carries a URL. */
export function videoResult(jobSet: HiggsfieldJobSet): { job: HiggsfieldJob; url: string } | undefined {
  for (const job of jobSet.jobs) {
    const url = job.raw?.url ?? job.preview?.url;
    if (job.status === 'completed' && url) return { job, url };
  }
  return undefined;
}
