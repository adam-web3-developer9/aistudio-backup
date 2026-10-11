import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { BrowserCookie, CreditBalance, JobOptions, JobProgress, JobProgressUpdate } from '../types.js';
import { maskToken, type AdapterInput, type BrowserAdapter, type ResumeInput, type SessionIdentity } from './adapter.js';
import {
  describeDreamMakerToken,
  estimateVideoCost,
  readDreamMakerToken,
  type DreamMakerPricingTable
} from './dreammaker-api.js';
import {
  DreamMakerClient,
  videoArtifact,
  type DreamMakerMode,
  type DreamMakerTask,
  type GenerateVideoInput,
  type UploadedFile
} from './dreammaker-client.js';
import {
  DreamMakerRenderTimeoutError,
  classifyDreamMakerError,
  isDreamMakerInsufficientCreditsError,
  withDreamMakerRetries
} from './dreammaker-retry.js';
import {
  DEFAULT_RETRY_DELAYS_MS,
  ProviderJobError,
  sleep,
  type RetryAttemptInfo
} from './provider-retry.js';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

/** How long a fetched price list is trusted before it is read again. */
const PRICING_TTL_MS = 60 * 60_000;

export interface DreamMakerVideoDefaults {
  /** Any `toolKey` from `/api/tool_spec/list`; overridable per job. */
  model: string;
  /** One of `DreamMakerMode`, or whatever else the platform accepts. */
  mode: string;
  /** "480p" | "720p" | "768p" | "1080p" | "2k" | "4k" — model-dependent. */
  resolution: string;
  durationSeconds: number;
  /** "adaptive" or a ratio like "16:9". */
  aspectRatio: string;
}

export interface DreamMakerAdapterOptions {
  video: DreamMakerVideoDefaults;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  /**
   * Back-off between tries of one failing step (credits, upload, submit, poll,
   * render). The length is the number of retries; default 10s / 30s / 60s.
   */
  retryDelaysMs?: readonly number[];
}

/** Worst-case wall time of one job, so the runner's timeout does not cut a retry short. */
export function dreamMakerJobBudgetMs(
  options: Pick<DreamMakerAdapterOptions, 'pollTimeoutMs' | 'retryDelaysMs'>
): number {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const retryWait = delays.reduce((sum, delay) => sum + delay, 0);
  return options.pollTimeoutMs * (delays.length + 1) + retryWait * 4 + 60_000;
}

/**
 * DreamMaker (dreammaker.vobile.com.cn).
 *
 * The whole job runs over plain HTTP — upload to OSS under a server-issued
 * policy, submit, poll — so this adapter never touches the browser pool. It
 * carries no model list of its own: `model` is any `toolKey` the platform
 * offers, and prices come from the account's own `canvas-pricing` table.
 */
export class DreamMakerAdapter implements BrowserAdapter {
  readonly id = 'dreammaker-v1';
  readonly allowedCookieDomains = ['vobile.com.cn', 'vobile.cn'];

  /** Shared across accounts: the price list is per platform, not per token. */
  private pricing?: DreamMakerPricingTable;
  private pricingFetchedAt = 0;
  /** `model|resolution` -> credits per second, from the quote endpoint. */
  private readonly unitPrices = new Map<string, { credits: number; at: number }>();

  constructor(
    private readonly origin: string,
    private readonly options?: DreamMakerAdapterOptions
  ) {}

  describeSession(cookies: readonly BrowserCookie[]): SessionIdentity | undefined {
    const token = readDreamMakerToken(cookies);
    if (!token) return undefined;
    return { tokenMasked: maskToken(token), account: describeDreamMakerToken(token) };
  }

  /** Credits straight from the session token — skips the browser pool entirely. */
  async getCreditsFromCookies(cookies: readonly BrowserCookie[]): Promise<CreditBalance | undefined> {
    const token = readDreamMakerToken(cookies);
    if (!token) return undefined;
    const balance = await new DreamMakerClient(this.origin, token).getCredits();
    // Piggyback the price list on the balance read the pool already makes, so
    // `estimateJobCost` (which is synchronous) always has a table to price with.
    await this.refreshPricing(token).catch(() => undefined);
    return balance;
  }

  /**
   * What this job costs: video is billed per second, so the unit price times
   * the requested duration. The unit price depends on **model and resolution**
   * (Seedance 2.5 is 672/s at 480p but 3750/s at 1080p), and only the quote
   * endpoint knows the tiers — `canvas-pricing` lists one number per model and
   * is therefore only right at that model's listed tier. Quotes are cached per
   * model+resolution, so this is one extra call per combination per hour.
   */
  async estimateJobCost(
    _balance: CreditBalance,
    options?: JobOptions,
    cookies?: readonly BrowserCookie[]
  ): Promise<number | undefined> {
    if (!this.options) return undefined;
    const model = options?.modelId ?? this.options.video.model;
    const resolution = options?.resolution ?? this.options.video.resolution;
    const duration = options?.durationSeconds ?? this.options.video.durationSeconds;
    const unitPrice = await this.unitPrice(model, resolution, cookies);
    if (unitPrice === undefined || !Number.isFinite(duration) || duration <= 0) return undefined;
    return Math.ceil(unitPrice * duration) * (options?.quantity ?? 1);
  }

  isInsufficientCreditsError(error: unknown): boolean {
    return isDreamMakerInsufficientCreditsError(error);
  }

  runWithoutBrowser(
    cookies: readonly BrowserCookie[],
    input: AdapterInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined {
    const token = readDreamMakerToken(cookies);
    if (!token || !this.options) return undefined;
    return this.generate(token, input, this.options, signal);
  }

  /** Poll a task another process submitted; the render kept going without us. */
  resumeWithoutBrowser(
    cookies: readonly BrowserCookie[],
    progress: JobProgress,
    input: ResumeInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined {
    const token = readDreamMakerToken(cookies);
    if (!token || !this.options || !progress.providerJobId) return undefined;
    return this.resume(token, progress.providerJobId, progress, input, this.options, signal);
  }

  /** There is no browser path: everything this adapter does is an HTTP call. */
  async run(_page: Page, _input: AdapterInput): Promise<unknown> {
    throw new Error('DreamMaker runs over the API only; the session is missing its access token');
  }

  /**
   * Upload → submit → poll, every step retried on its own schedule:
   * - network trouble / platform busy on credits, upload, submit → the same
   *   call again after 10s / 30s / 60s;
   * - a poll that cannot reach DreamMaker → handled inside `waitForTask`;
   * - a task the platform reports as failed → the same generation is submitted
   *   again with the files already uploaded. A failed task is not charged; a
   *   task that merely timed out is polled again rather than resubmitted.
   *   Never retried: an account that cannot pay (the runner moves the job to
   *   another account).
   */
  private async generate(
    token: string,
    input: AdapterInput,
    options: DreamMakerAdapterOptions,
    signal?: AbortSignal
  ): Promise<unknown> {
    const client = new DreamMakerClient(this.origin, token);
    const retry = this.retryContext(options, input.onProgress, signal);
    const creditsBefore = await withDreamMakerRetries('credits', () => client.getCredits(), retry);

    const references = [
      { imagePath: input.imagePath, mimeType: input.mimeType, originalName: input.originalName },
      ...(input.referenceImages ?? [])
    ];
    const uploaded: UploadedFile[] = [];
    for (const reference of references) {
      const buffer = await readFile(reference.imagePath);
      uploaded.push(await withDreamMakerRetries('upload', () => client.uploadImage({
        buffer,
        fileName: reference.originalName ?? path.basename(reference.imagePath),
        mimeType: reference.mimeType ?? mimeFromPath(reference.imagePath),
        signal
      }), retry));
    }

    const generation = this.generationInput(input, uploaded, options);
    const submitted = await withDreamMakerRetries('submit', () => client.generateVideo(generation, signal), retry);
    const referenceImages = uploaded.map((file) => ({ fileId: file.uploadId, url: file.url }));
    // From here on the platform owns the render: persist enough to find it again
    // and, should it fail, to submit it again without uploading the images.
    input.onProgress?.({
      providerJobId: submitted.taskId,
      referenceImages,
      uploadedFiles: uploaded,
      creditsBefore: creditsBefore.totalCredits,
      renderAttempts: 1,
      retry: undefined
    });

    const { task, attempts } = await this.waitWithResubmits(client, {
      taskId: submitted.taskId,
      generation,
      renderAttempts: 1,
      referenceImages,
      uploadedFiles: uploaded,
      creditsBefore: creditsBefore.totalCredits
    }, retry);

    return {
      ...describeResult(input.text, task),
      referenceImages,
      creditsBefore: creditsBefore.totalCredits,
      creditsAfter: task.balanceAfter,
      creditsSpent: task.creditCost,
      renderAttempts: attempts
    };
  }

  private async resume(
    token: string,
    taskId: string,
    progress: JobProgress,
    input: ResumeInput,
    options: DreamMakerAdapterOptions,
    signal?: AbortSignal
  ): Promise<unknown> {
    const client = new DreamMakerClient(this.origin, token);
    const retry = this.retryContext(options, input.onProgress, signal);
    // The previous process kept the uploads, so a failed task can be resubmitted
    // without touching the image files again.
    const uploaded = Array.isArray(progress.uploadedFiles) && progress.uploadedFiles.length
      ? progress.uploadedFiles as UploadedFile[]
      : undefined;
    const generation = uploaded
      ? this.generationInput({ text: input.text, options: input.options }, uploaded, options)
      : undefined;

    const { task, attempts } = await this.waitWithResubmits(client, {
      taskId,
      generation,
      renderAttempts: progress.renderAttempts ?? 1,
      referenceImages: progress.referenceImages,
      uploadedFiles: uploaded,
      creditsBefore: progress.creditsBefore
    }, retry);

    return {
      ...describeResult(input.text, task),
      referenceImages: progress.referenceImages,
      creditsBefore: progress.creditsBefore,
      creditsAfter: task.balanceAfter,
      creditsSpent: task.creditCost,
      renderAttempts: attempts,
      resumed: true
    };
  }

  /**
   * Poll one task. When it fails, wait the next back-off and try again: a
   * timed-out task is polled further under the same id (it is still rendering,
   * a second submission would pay twice); anything else is submitted again with
   * the files already uploaded.
   */
  private async waitWithResubmits(
    client: DreamMakerClient,
    state: {
      taskId: string;
      generation?: GenerateVideoInput;
      renderAttempts: number;
      referenceImages?: Array<{ fileId: string; url: string }>;
      uploadedFiles?: UploadedFile[];
      creditsBefore?: number;
    },
    retry: RetryContext
  ): Promise<{ task: DreamMakerTask; attempts: number }> {
    const { options, signal, onProgress, delaysMs: delays } = retry;
    const maxAttempts = delays.length + 1;
    let { taskId, renderAttempts } = state;
    // Every pass through the loop, resubmission or continued poll, is one try.
    let attempt = 1;

    for (;;) {
      try {
        const task = await client.waitForTask(taskId, {
          timeoutMs: options.pollTimeoutMs,
          intervalMs: options.pollIntervalMs,
          retryDelaysMs: delays,
          signal,
          onPoll: (poll) => onProgress?.({
            percent: poll.progress,
            // The platform reports 0 for the whole render and 100 only at the
            // end, so the stage is the only thing that actually moves.
            message: stageLabel(poll),
            retry: undefined
          }),
          onPollRetry: (info) => onProgress?.(retryProgress(info))
        });
        return { task, attempts: renderAttempts };
      } catch (error) {
        if (signal?.aborted) throw error;
        // Poll retries were already spent inside waitForTask: that verdict stands.
        if (error instanceof ProviderJobError) throw error;
        const failure = classifyDreamMakerError(error);
        const keepPolling = error instanceof DreamMakerRenderTimeoutError;
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

        let submitted: DreamMakerTask;
        try {
          submitted = await withDreamMakerRetries(
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
        taskId = submitted.taskId;
        onProgress?.({
          providerJobId: taskId,
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

  private generationInput(
    input: Pick<AdapterInput, 'text' | 'options'>,
    uploaded: UploadedFile[],
    options: DreamMakerAdapterOptions
  ): GenerateVideoInput {
    const overrides = input.options ?? {};
    const imageUrls = uploaded.map((file) => file.url);
    const duration = overrides.durationSeconds ?? options.video.durationSeconds;
    return {
      model: overrides.modelId ?? options.video.model,
      // Several images are a reference set, not a first frame — say so unless
      // the caller picked a mode itself. A mode we do not recognise is passed
      // through as given: the platform's list is the platform's to change.
      mode: overrides.mode?.trim()
        || (imageUrls.length > 1 ? 'allReference' : options.video.mode),
      prompt: input.text,
      imageUrls,
      options: {
        duration,
        // The canvas sends both spellings; different models read different ones.
        durationSeconds: duration,
        resolution: overrides.resolution ?? options.video.resolution,
        ratio: overrides.aspectRatio ?? options.video.aspectRatio
      }
    };
  }

  private retryContext(
    options: DreamMakerAdapterOptions,
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
   * Credits per second for this model at this resolution. The quote endpoint is
   * authoritative; if it cannot be reached (or the session carries no token)
   * fall back to the coarse `canvas-pricing` number rather than refusing to
   * price the job at all.
   */
  private async unitPrice(
    model: string,
    resolution: string,
    cookies?: readonly BrowserCookie[]
  ): Promise<number | undefined> {
    const key = `${model}|${resolution}`;
    const cached = this.unitPrices.get(key);
    if (cached && Date.now() - cached.at < PRICING_TTL_MS) return cached.credits;

    const token = cookies ? readDreamMakerToken(cookies) : undefined;
    if (token) {
      try {
        const quote = await new DreamMakerClient(this.origin, token).getQuote({
          capability: 'video',
          model,
          options: { resolution }
        });
        this.unitPrices.set(key, { credits: quote.listAmount, at: Date.now() });
        return quote.listAmount;
      } catch {
        // Fall through: a failed quote must not stop the job from being priced.
      }
    }
    return estimateVideoCost(this.pricing, { modelId: model, durationSeconds: 1 });
  }

  /** Keep the price list warm; failures are not fatal, they only cost an estimate. */
  private async refreshPricing(token: string): Promise<void> {
    if (this.pricing && Date.now() - this.pricingFetchedAt < PRICING_TTL_MS) return;
    this.pricing = await new DreamMakerClient(this.origin, token).getPricing();
    this.pricingFetchedAt = Date.now();
  }
}

interface RetryContext {
  options: DreamMakerAdapterOptions;
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

/**
 * What a poll should say. DreamMaker's `progress` is 0 until the very end, so a
 * percentage reads like a stuck job; `stage` is what actually advances
 * (queued → generating → archiving).
 */
function stageLabel(task: DreamMakerTask): string {
  switch (task.stage) {
    case 'queued': return '平台排队中';
    case 'generating': return '生成中';
    case 'archiving': return '转存成片中';
    case 'finishing': return '收尾中';
    case 'succeeded': return '已完成';
    case 'failed': return '生成失败';
    default: return task.stage || (task.status === 'queued' ? '平台排队中' : '生成中');
  }
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

function describeResult(text: string, task: DreamMakerTask) {
  const artifact = videoArtifact(task);
  return {
    status: 'succeeded' as const,
    text,
    taskId: task.taskId,
    model: task.model,
    videoUrl: artifact?.url,
    ossUri: artifact?.ossUri,
    coverUrl: artifact?.thumbnailUrl,
    durationSeconds: artifact?.durationSeconds,
    width: artifact?.width,
    height: artifact?.height,
    sizeBytes: artifact?.sizeBytes,
    artifacts: task.artifacts
  };
}

function mimeFromPath(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'image/png';
}
