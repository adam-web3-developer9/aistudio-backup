import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { BrowserCookie, CreditBalance, JobOptions, JobProgress, JobProgressUpdate } from '../types.js';
import { maskToken, type AdapterInput, type BrowserAdapter, type ResumeInput, type SessionIdentity } from './adapter.js';
import {
  HiggsfieldMcpSession,
  describeMcpToken,
  readHiggsfieldMcpTokens,
  type HiggsfieldOAuthTokens
} from './higgsfield-mcp.js';
import {
  HiggsfieldMcpClient,
  type McpGenerateVideoInput
} from './higgsfield-mcp-client.js';
import {
  videoResult,
  type HiggsfieldJobSet,
  type UploadedMedia
} from './higgsfield-client.js';
import { hasVideoEditWrapper, wrapVideoEditPrompt } from './higgsfield-prompt.js';
import {
  HiggsfieldNoResultError,
  HiggsfieldRenderTimeoutError,
  classifyHiggsfieldError,
  isHiggsfieldInsufficientCreditsError,
  withHiggsfieldRetries
} from './higgsfield-retry.js';
import {
  DEFAULT_RETRY_DELAYS_MS,
  ProviderJobError,
  sleep,
  type RetryAttemptInfo
} from './provider-retry.js';

/**
 * Higgsfield takes reference video and audio as well as stills, so the kind of
 * every file has to survive the trip: `medias[].data.type` is what tells the
 * platform which it is. Only images can actually reach this adapter today —
 * the gateway's own `/v1/assets` accepts images only — but the moment that
 * changes, nothing here has to.
 */
/**
 * The seed clip `video_edit` falls back to, shipped with the service.
 *
 * Two seconds at 1280×720 — the mode is billed by this file's duration, so
 * every second here is on the bill of every job that uses it.
 */
const DEFAULT_EDIT_SEED_VIDEO = path.resolve('./assets/higgsfield-edit-seed.mp4');

/** How long that clip is, and so the whole bill of a job that is edited on it. */
const DEFAULT_EDIT_SEED_SECONDS = 2;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac'
};

export interface HiggsfieldVideoDefaults {
  /** The model's own id: `seedance_2_5`, `minimax_hailuo`, `wan2_6`, … */
  model: string;
  /**
   * Generation mode. For seedance 2.5: `t2v`, `omni_reference`, `video_edit`
   * (billed by the reference video's duration; `duration` and `aspect_ratio`
   * are ignored) or `video_extension`. Blank lets the platform default.
   */
  mode?: string;
  /** `480p`, `720p`, `1080p` — model-dependent, passed through. */
  resolution: string;
  durationSeconds: number;
  /** `16:9`, `9:16`, `auto` — passed through. */
  aspectRatio: string;
}

export interface HiggsfieldAdapterOptions {
  video: HiggsfieldVideoDefaults;
  /**
   * The clip `video_edit` edits when a job brings no video of its own.
   *
   * That mode is billed by the reference video's duration, so this file is the
   * price of the job: a two-second seed is the floor, and what comes back is as
   * long as the prompt asks for. Shipping one with the service is what lets a
   * caller use the mode by sending nothing but a prompt.
   */
  editSeedVideoPath?: string;
  /**
   * That clip's length in seconds. It is what the platform bills a `video_edit`
   * job by, so it is also the only honest thing to quote one at — keep it in
   * step with the file. Default 2.
   */
  editSeedVideoSeconds?: number;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  /**
   * Back-off between tries of one failing step (credits, upload, submit, poll,
   * render). The length is the number of retries; default 10s / 30s / 60s.
   */
  retryDelaysMs?: readonly number[];
}

/** Worst-case wall time of one job, so the runner's timeout does not cut a retry short. */
export function higgsfieldJobBudgetMs(
  options: Pick<HiggsfieldAdapterOptions, 'pollTimeoutMs' | 'retryDelaysMs'>
): number {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const retryWait = delays.reduce((sum, delay) => sum + delay, 0);
  return options.pollTimeoutMs * (delays.length + 1) + retryWait * 4 + 60_000;
}

/**
 * Higgsfield (higgsfield.ai).
 *
 * Everything runs over Higgsfield's own MCP server: upload to object storage
 * under a presigned URL, submit, poll. No browser is involved — which is the
 * point, because the web app's gateway keeps `/jobs/*` behind DataDome and
 * refuses trial accounts there outright.
 *
 * It carries no model list: `modelId` is the platform's model id and every
 * other parameter is passed through, because Higgsfield adds and retires models
 * without us. The credential is an OAuth refresh token; access tokens last
 * about a day and are minted from it as needed.
 */
export class HiggsfieldAdapter implements BrowserAdapter {
  readonly id = 'higgsfield-v1';
  readonly allowedCookieDomains = ['higgsfield.ai'];

  /**
   * A quote here prices the request as far as it is known before an account is
   * picked, and that is not always the request that gets submitted: nothing has
   * been uploaded yet, so a `video_edit` job carrying a video of its own is
   * priced without it. The platform bills what it bills — see `quoteOptions`.
   */
  readonly costEstimateIsBinding = false;

  /** One MCP session per account credential, so refreshes are shared. */
  private readonly sessions = new Map<string, HiggsfieldMcpSession>();

  constructor(private readonly options?: HiggsfieldAdapterOptions) {}

  describeSession(cookies: readonly BrowserCookie[]): SessionIdentity | undefined {
    const tokens = readHiggsfieldMcpTokens(cookies);
    if (!tokens) return undefined;
    const credential = tokens.refreshToken ?? tokens.accessToken!;
    // The access token is opaque; the id token is what names the account.
    const claims = tokens.idToken ? describeMcpToken(tokens.idToken) : {};
    return {
      tokenMasked: maskToken(credential),
      account: {
        userId: claims.userId ?? claims.email,
        expiresAt: claims.expiresAt ? new Date(claims.expiresAt).toISOString() : undefined
      }
    };
  }

  /** Credits straight from the stored credential — no browser, no job. */
  async getCreditsFromCookies(cookies: readonly BrowserCookie[]): Promise<CreditBalance | undefined> {
    return this.clientFor(cookies)?.getCredits();
  }

  /**
   * What this job costs, from the platform.
   *
   * MCP prices a request free and without creating anything, so this is a real
   * quote rather than the floor the old per-generator price table could give.
   * What it prices is the request as known before an account is picked, which
   * `quoteOptions` corrects for the one mode where that differs from the bill.
   * It never fails a job: an unanswered preflight simply yields no opinion.
   */
  async estimateJobCost(
    _balance: CreditBalance,
    options?: JobOptions,
    cookies?: readonly BrowserCookie[]
  ): Promise<number | undefined> {
    const client = cookies && this.clientFor(cookies);
    if (!client || !this.options) return undefined;
    const quote = await client.estimateCost(
      this.generationInput({ text: '', options: this.quoteOptions(options) }, [], this.options)
    );
    return quote === undefined ? undefined : quote * (options?.quantity ?? 1);
  }

  isInsufficientCreditsError(error: unknown): boolean {
    return isHiggsfieldInsufficientCreditsError(error);
  }

  runWithoutBrowser(
    cookies: readonly BrowserCookie[],
    input: AdapterInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined {
    const client = this.clientFor(cookies);
    if (!client || !this.options) return undefined;
    return this.generate(client, input, this.options, signal);
  }

  /** Poll a job set another process submitted; the render kept going without us. */
  resumeWithoutBrowser(
    cookies: readonly BrowserCookie[],
    progress: JobProgress,
    input: ResumeInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined {
    const client = this.clientFor(cookies);
    if (!client || !this.options || !progress.providerJobId) return undefined;
    return this.resume(client, progress.providerJobId, progress, input, this.options, signal);
  }

  /** There is no browser path: everything this adapter does is an HTTP call. */
  async run(_page: Page, _input: AdapterInput): Promise<unknown> {
    throw new Error('Higgsfield runs over MCP only; this session has no OAuth credential — run `npm run higgsfield:login`');
  }

  /**
   * Upload → submit → poll, every step retried on its own schedule:
   * - network trouble / platform busy on credits, upload, submit → the same
   *   call again after 10s / 30s / 60s;
   * - a poll that cannot reach the gateway → handled inside `waitForJobSet`;
   * - a job the platform reports as failed → the same generation is submitted
   *   again with the media already uploaded. A render that merely timed out is
   *   polled further rather than resubmitted, so nothing is paid for twice.
   *   Never retried: an account that cannot pay (the runner moves the job to
   *   another account).
   */
  private async generate(
    client: HiggsfieldMcpClient,
    input: AdapterInput,
    options: HiggsfieldAdapterOptions,
    signal?: AbortSignal
  ): Promise<unknown> {
    const retry = this.retryContext(options, input.onProgress, signal);
    const creditsBefore = await withHiggsfieldRetries('credits', () => client.getCredits(signal), retry);

    const references = [
      { imagePath: input.imagePath, mimeType: input.mimeType, originalName: input.originalName },
      ...(input.referenceImages ?? [])
    ];
    const uploaded: UploadedMedia[] = [];
    for (const reference of references) {
      const buffer = await readFile(reference.imagePath);
      uploaded.push(await withHiggsfieldRetries('upload', () => client.uploadMedia({
        buffer,
        fileName: reference.originalName ?? path.basename(reference.imagePath),
        mimeType: reference.mimeType ?? mimeFromPath(reference.imagePath),
        signal
      }), retry));
    }

    // `video_edit` edits a video, and the platform bills that video's duration.
    // A caller who asked for the mode without bringing one gets the seed clip
    // the service ships: two seconds, the cheapest input there is.
    if (this.modeFor(input.options, options) === 'video_edit'
      && !uploaded.some((media) => media.kind === 'video')) {
      const seedPath = options.editSeedVideoPath ?? DEFAULT_EDIT_SEED_VIDEO;
      const seed = await readFile(seedPath);
      uploaded.push(await withHiggsfieldRetries('upload', () => client.uploadMedia({
        buffer: seed,
        fileName: path.basename(seedPath),
        mimeType: mimeFromPath(seedPath),
        signal
      }), retry));
    }

    const generation = this.generationInput(input, uploaded, options);
    const submitted = await withHiggsfieldRetries('submit', () => client.generateVideo(generation, signal), retry);
    const referenceImages = uploaded.map((media) => ({ fileId: media.id, url: media.url ?? '' }));
    // From here on the platform owns the render: persist enough to find it
    // again and, should it fail, to submit it again without uploading.
    input.onProgress?.({
      providerJobId: submitted.id,
      referenceImages,
      uploadedFiles: uploaded,
      creditsBefore: creditsBefore.totalCredits,
      renderAttempts: 1,
      retry: undefined
    });

    const { jobSet, attempts } = await this.waitWithResubmits(client, {
      jobSetId: submitted.id,
      generation,
      renderAttempts: 1,
      referenceImages,
      uploadedFiles: uploaded,
      creditsBefore: creditsBefore.totalCredits
    }, retry);

    const creditsAfter = await client.getCredits(signal).then((b) => b.totalCredits).catch(() => undefined);
    return {
      ...describeResult(input.text, jobSet),
      referenceImages,
      creditsBefore: creditsBefore.totalCredits,
      creditsAfter,
      creditsSpent: creditsAfter === undefined ? undefined : creditsBefore.totalCredits - creditsAfter,
      renderAttempts: attempts
    };
  }

  private async resume(
    client: HiggsfieldMcpClient,
    jobSetId: string,
    progress: JobProgress,
    input: ResumeInput,
    options: HiggsfieldAdapterOptions,
    signal?: AbortSignal
  ): Promise<unknown> {
    const retry = this.retryContext(options, input.onProgress, signal);
    // The previous process kept the uploads, so a failed render can be
    // resubmitted without touching the image files again.
    const uploaded = Array.isArray(progress.uploadedFiles) && progress.uploadedFiles.length
      ? progress.uploadedFiles as UploadedMedia[]
      : undefined;
    const generation = uploaded
      ? this.generationInput({ text: input.text, options: input.options }, uploaded, options)
      : undefined;

    const { jobSet, attempts } = await this.waitWithResubmits(client, {
      jobSetId,
      generation,
      renderAttempts: progress.renderAttempts ?? 1,
      referenceImages: progress.referenceImages,
      uploadedFiles: uploaded,
      creditsBefore: progress.creditsBefore
    }, retry);

    const creditsAfter = await client.getCredits(signal).then((b) => b.totalCredits).catch(() => undefined);
    return {
      ...describeResult(input.text, jobSet),
      referenceImages: progress.referenceImages,
      creditsBefore: progress.creditsBefore,
      creditsAfter,
      renderAttempts: attempts,
      resumed: true
    };
  }

  /**
   * Poll one job set. When it fails, wait the next back-off and try again: a
   * timed-out render is polled further under the same id (it is still running,
   * a second submission would pay twice); anything else is submitted again with
   * the media already uploaded.
   */
  private async waitWithResubmits(
    client: HiggsfieldMcpClient,
    state: {
      jobSetId: string;
      generation?: McpGenerateVideoInput;
      renderAttempts: number;
      referenceImages?: Array<{ fileId: string; url: string }>;
      uploadedFiles?: UploadedMedia[];
      creditsBefore?: number;
    },
    retry: RetryContext
  ): Promise<{ jobSet: HiggsfieldJobSet; attempts: number }> {
    const { options, signal, onProgress, delaysMs: delays } = retry;
    const maxAttempts = delays.length + 1;
    let { jobSetId, renderAttempts } = state;
    // Every pass through the loop, resubmission or continued poll, is one try.
    let attempt = 1;

    for (;;) {
      try {
        const jobSet = await client.waitForJobSet(jobSetId, {
          timeoutMs: options.pollTimeoutMs,
          intervalMs: options.pollIntervalMs,
          retryDelaysMs: delays,
          signal,
          onPoll: (poll) => onProgress?.({
            // The platform reports a status per job, not a percentage, so the
            // stage is the only thing that actually moves.
            message: statusLabel(poll),
            retry: undefined
          }),
          onPollRetry: (info) => onProgress?.(retryProgress(info))
        });
        if (!videoResult(jobSet)) throw new HiggsfieldNoResultError(jobSet.id);
        return { jobSet, attempts: renderAttempts };
      } catch (error) {
        if (signal?.aborted) throw error;
        // Poll retries were already spent inside waitForJobSet: that verdict stands.
        if (error instanceof ProviderJobError) throw error;
        const failure = classifyHiggsfieldError(error);
        const keepPolling = error instanceof HiggsfieldRenderTimeoutError;
        const canRetry = failure.retryable
          && attempt < maxAttempts
          && (keepPolling || state.generation !== undefined);
        if (!canRetry) throw new ProviderJobError(failure, attempt, 'render', { cause: error });

        const delayMs = delays[attempt - 1]!;
        onProgress?.(retryProgress({ step: 'render', attempt, maxAttempts, delayMs, failure }));
        await sleep(delayMs, signal);
        attempt += 1;
        if (keepPolling) {
          onProgress?.({ retry: undefined, message: `继续等待生成（第 ${attempt}/${maxAttempts} 轮）` });
          continue;
        }

        let submitted: HiggsfieldJobSet;
        try {
          submitted = await withHiggsfieldRetries(
            'submit',
            () => client.generateVideo(state.generation!, signal),
            retry
          );
        } catch (submitError) {
          // The resubmission itself could not be placed. A verdict about the
          // submission's own content or account stands on its own; anything
          // else is reported as the render failure we were retrying.
          const verdict = submitError instanceof ProviderJobError
            && (!submitError.retryable || submitError.kind === 'content_rejected');
          throw verdict
            ? submitError
            : new ProviderJobError(failure, attempt, 'render', { cause: submitError });
        }
        renderAttempts += 1;
        jobSetId = submitted.id;
        onProgress?.({
          providerJobId: jobSetId,
          percent: 0,
          message: undefined,
          referenceImages: state.referenceImages,
          uploadedFiles: state.uploadedFiles,
          creditsBefore: state.creditsBefore,
          renderAttempts,
          retry: undefined
        });
      }
    }
  }

  /** The generation mode this job runs in: the job's own, else the configured one. */
  private modeFor(
    jobOptions: JobOptions | undefined,
    options: HiggsfieldAdapterOptions
  ): string | undefined {
    return jobOptions?.mode?.trim() || options.video.mode;
  }

  /**
   * The request a quote should price, which is not quite the one a job states.
   *
   * A quote carries no media: nothing has been uploaded while an account is
   * still being picked. `video_edit` is billed by the reference video's own
   * duration and ignores `duration` — but with no video in the request the
   * platform has nothing to bill and prices `duration` after all, answering
   * several times the real bill (a 10s shot quoted ~84 against a 14-credit
   * job). The pool then reserves that on every job of a batch and declares
   * accounts that could have paid for all of them broke. A job that brings no
   * video of its own is edited on the seed clip, so the seed's length is the
   * length to price.
   *
   * A caller who brings a longer video is quoted low, and that is the safe
   * direction: a quote only picks an account, and an account that truly cannot
   * pay is refused by the platform at submit, which the runner answers by
   * moving the job to the next account. Hence `costEstimateIsBinding = false`.
   */
  private quoteOptions(options?: JobOptions): JobOptions | undefined {
    if (!this.options || this.modeFor(options, this.options) !== 'video_edit') return options;
    return {
      ...options,
      durationSeconds: this.options.editSeedVideoSeconds ?? DEFAULT_EDIT_SEED_SECONDS
    };
  }

  private generationInput(
    input: Pick<AdapterInput, 'text' | 'options'>,
    uploaded: UploadedMedia[],
    options: HiggsfieldAdapterOptions
  ): McpGenerateVideoInput {
    const overrides = input.options ?? {};
    const video = options.video;
    const mode = this.modeFor(overrides, options);
    const aspectRatio = overrides.aspectRatio ?? video.aspectRatio;
    const durationSeconds = overrides.durationSeconds ?? video.durationSeconds;

    // In video_edit the platform reads the length off the prompt, not off
    // `duration`, so the requested length has to be written into the text —
    // see `wrapVideoEditPrompt`. A caller who wrote their own wrapper keeps it.
    const prompt = mode === 'video_edit' && !hasVideoEditWrapper(input.text)
      ? wrapVideoEditPrompt({ prompt: input.text, seconds: durationSeconds, aspectRatio })
      : input.text;

    return {
      model: overrides.modelId?.trim() || video.model,
      prompt,
      media: uploaded,
      ...(mode ? { mode } : {}),
      params: {
        // In video_edit the platform ignores both of these and bills by the
        // reference video's own duration, so sending them is harmless there
        // and required everywhere else.
        duration: durationSeconds,
        resolution: overrides.resolution ?? video.resolution,
        aspect_ratio: aspectRatio,
        ...(overrides.quantity !== undefined ? { count: overrides.quantity } : {})
      }
    };
  }

  private retryContext(
    options: HiggsfieldAdapterOptions,
    onProgress: ((progress: JobProgressUpdate) => void) | undefined,
    signal?: AbortSignal
  ): RetryContext {
    return {
      options,
      signal,
      onProgress,
      delaysMs: options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS,
      onRetry: (info) => onProgress?.(retryProgress(info))
    };
  }

  /**
   * A client bound to one account's credential.
   *
   * The MCP session is kept per refresh token so that a token refresh is made
   * once and reused, rather than once per call. A replaced credential is a new
   * key, and the old session is dropped with its entry.
   */
  private clientFor(cookies: readonly BrowserCookie[]): HiggsfieldMcpClient | undefined {
    if (!this.options) return undefined;
    const tokens = readHiggsfieldMcpTokens(cookies);
    if (!tokens) return undefined;
    return new HiggsfieldMcpClient(this.sessionFor(tokens));
  }

  private sessionFor(tokens: HiggsfieldOAuthTokens): HiggsfieldMcpSession {
    const key = tokens.refreshToken ?? tokens.accessToken!;
    let session = this.sessions.get(key);
    if (!session) {
      session = new HiggsfieldMcpSession(tokens);
      this.sessions.set(key, session);
    }
    return session;
  }
}

interface RetryContext {
  options: HiggsfieldAdapterOptions;
  signal?: AbortSignal;
  onProgress?: (progress: JobProgressUpdate) => void;
  delaysMs: readonly number[];
  onRetry: (info: RetryAttemptInfo) => void;
}

/** What a scheduled retry looks like in the persisted job progress. */
function retryProgress(info: RetryAttemptInfo): JobProgressUpdate {
  const reason = info.failure.providerMessage ?? info.failure.message;
  return {
    retry: {
      step: info.step,
      attempt: info.attempt,
      maxAttempts: info.maxAttempts,
      delayMs: info.delayMs,
      nextAttemptAt: new Date(Date.now() + info.delayMs).toISOString(),
      code: info.failure.code,
      reason
    },
    message: `${stepLabel(info.step)}失败（${reason}），${Math.round(info.delayMs / 1000)}s 后第 ${info.attempt + 1}/${info.maxAttempts} 次尝试`
  };
}

/** Higgsfield reports a status per job and no percentage, so say the status. */
function statusLabel(jobSet: HiggsfieldJobSet): string {
  const statuses = new Set(jobSet.jobs.map((job) => job.status));
  if (statuses.has('in_progress')) return '生成中';
  if (statuses.has('queued')) return '平台排队中';
  if (statuses.has('completed')) return '已完成';
  if (statuses.has('nsfw')) return '内容被拒';
  if (statuses.has('failed')) return '生成失败';
  return '生成中';
}

function stepLabel(step: string): string {
  switch (step) {
    case 'credits': return '读取余额';
    case 'upload': return '上传图片';
    case 'submit': return '提交生成';
    case 'poll': return '查询任务状态';
    case 'render': return '生成';
    default: return step;
  }
}

function describeResult(text: string, jobSet: HiggsfieldJobSet) {
  const found = videoResult(jobSet);
  return {
    status: 'succeeded' as const,
    text,
    taskId: jobSet.id,
    jobId: found?.job.id,
    model: jobSet.type,
    videoUrl: found?.url,
    coverUrl: found?.job.preview?.url,
    jobs: jobSet.jobs.map((job) => ({
      id: job.id,
      status: job.status,
      url: job.raw?.url ?? job.preview?.url
    }))
  };
}

function mimeFromPath(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'image/png';
}
