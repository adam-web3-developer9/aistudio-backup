import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { BrowserCookie, CreditBalance, JobOptions, JobProgress, JobProgressUpdate } from '../types.js';
import { maskToken, type AdapterInput, type BrowserAdapter, type ResumeInput, type SessionIdentity } from './adapter.js';
import {
  CREDIT_API_PATH,
  describeHailuoToken,
  estimateVideoCost,
  fetchCreditsWithToken,
  isHailuoInsufficientCreditsError,
  parseCreditBalance,
  readTokenCookie,
  signRequest
} from './hailuo-api.js';
import {
  HailuoClient,
  type GenerateVideoInput,
  type GenerateVideoResult,
  type ReferenceMode,
  type UploadedFile,
  type VideoResult
} from './hailuo-client.js';
import {
  DEFAULT_RETRY_DELAYS_MS,
  HailuoJobError,
  HailuoRenderTimeoutError,
  type RetryAttemptInfo,
  classifyHailuoError,
  sleep,
  withHailuoRetries
} from './hailuo-retry.js';

const UPLOAD_LABEL = /^Upload 参考 \(\d+\/12\)$/;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
};

export interface HailuoVideoDefaults {
  modelId: string;
  resolution: string;
  duration: number;
  aspectRatio: string;
  referenceMode: string;
  frameType: number;
}

export interface HailuoAdapterOptions {
  video: HailuoVideoDefaults;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  /**
   * Back-off between tries of one failing step (credits, upload, submit, poll,
   * render). The length is the number of retries; default 10s / 30s / 60s.
   */
  retryDelaysMs?: readonly number[];
}

/** Worst-case wall time of one job, so the runner's timeout does not cut a retry short. */
export function hailuoJobBudgetMs(options: Pick<HailuoAdapterOptions, 'pollTimeoutMs' | 'retryDelaysMs'>): number {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const retryWait = delays.reduce((sum, delay) => sum + delay, 0);
  // Each render attempt gets the full poll budget; step retries before it add their own waits.
  return options.pollTimeoutMs * (delays.length + 1) + retryWait * 4 + 60_000;
}

export class HailuoAdapter implements BrowserAdapter {
  readonly id = 'hailuo-v1';
  readonly allowedCookieDomains = ['hailuoai.com', 'hailuoai.video'];

  constructor(
    private readonly createUrl: string,
    private readonly options?: HailuoAdapterOptions
  ) {}

  describeSession(cookies: readonly BrowserCookie[]): SessionIdentity | undefined {
    const token = readTokenCookie(cookies);
    if (!token) return undefined;
    return { tokenMasked: maskToken(token), account: describeHailuoToken(token) };
  }

  /** Credits straight from the session token — skips the browser pool entirely. */
  async getCreditsFromCookies(cookies: readonly BrowserCookie[]): Promise<CreditBalance | undefined> {
    const token = readTokenCookie(cookies);
    if (!token) return undefined;
    return fetchCreditsWithToken(new URL(this.createUrl).origin, token);
  }

  /** Price this job against the account's own table (it varies by plan). */
  estimateJobCost(balance: CreditBalance, options?: JobOptions): number | undefined {
    if (!this.options) return undefined;
    return estimateVideoCost(balance, {
      modelId: options?.modelId ?? this.options.video.modelId,
      resolution: options?.resolution ?? this.options.video.resolution,
      duration: options?.durationSeconds ?? this.options.video.duration,
      quantity: options?.quantity
    });
  }

  isInsufficientCreditsError(error: unknown): boolean {
    return isHailuoInsufficientCreditsError(error)
      || (error instanceof HailuoJobError && isHailuoInsufficientCreditsError(error.cause));
  }

  /**
   * Upload the reference image, submit the generation and poll to completion —
   * the same calls the create page makes, without driving a browser.
   */
  runWithoutBrowser(
    cookies: readonly BrowserCookie[],
    input: AdapterInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined {
    const token = readTokenCookie(cookies);
    if (!token || !this.options) return undefined;
    return this.generate(token, input, this.options, signal);
  }

  /** Poll a generation another process submitted; the render kept going without us. */
  resumeWithoutBrowser(
    cookies: readonly BrowserCookie[],
    progress: JobProgress,
    input: ResumeInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined {
    const token = readTokenCookie(cookies);
    if (!token || !this.options || !progress.providerJobId) return undefined;
    return this.resume(token, progress.providerJobId, progress, input, this.options, signal);
  }

  private async resume(
    token: string,
    videoId: string,
    progress: JobProgress,
    input: ResumeInput,
    options: HailuoAdapterOptions,
    signal?: AbortSignal
  ): Promise<unknown> {
    const client = new HailuoClient(new URL(this.createUrl).origin, token);
    const retry = this.retryContext(options, input.onProgress, signal);
    // The previous process kept the file records, so a failed render can still be resubmitted.
    const uploaded = Array.isArray(progress.uploadedFiles) && progress.uploadedFiles.length
      ? progress.uploadedFiles as UploadedFile[]
      : undefined;
    const generation = uploaded ? this.generationInput(input, uploaded, options) : undefined;

    const { result, batchId, attempts } = await this.waitWithResubmits(client, {
      videoId,
      batchId: progress.batchId ?? '',
      generation,
      renderAttempts: progress.renderAttempts ?? 1,
      referenceImages: progress.referenceImages,
      uploadedFiles: uploaded,
      creditsBefore: progress.creditsBefore
    }, retry);

    const creditsAfter = await client.getCredits().catch(() => undefined);
    return {
      ...describeResult(input.text, result, batchId),
      referenceImages: progress.referenceImages,
      creditsBefore: progress.creditsBefore,
      creditsAfter: creditsAfter?.totalCredits,
      creditsSpent: creditsAfter && progress.creditsBefore !== undefined
        ? progress.creditsBefore - creditsAfter.totalCredits
        : undefined,
      renderAttempts: attempts,
      resumed: true
    };
  }

  /**
   * Upload → submit → poll, every step retried on its own schedule:
   * - network trouble / provider busy on credits, upload, submit → the same
   *   call again after 10s / 30s / 60s;
   * - a poll that cannot reach Hailuo → handled inside `waitForVideo`;
   * - a render Hailuo reports as failed ("内容生成失败。请重试。"), rejects, or
   *   fails in any other way → the same generation is submitted again with the
   *   files already uploaded, up to three more times. Failed renders are not
   *   charged; a render that merely timed out is polled again rather than
   *   resubmitted. The caller only ever sees the final verdict. A moderation
   *   rejection (2400002) is retried like the rest and reported as
   *   CONTENT_REJECTED only after the last try. Never retried: an account that
   *   cannot pay (the runner moves the job to another account).
   */
  private async generate(
    token: string,
    input: AdapterInput,
    options: HailuoAdapterOptions,
    signal?: AbortSignal
  ): Promise<unknown> {
    const client = new HailuoClient(new URL(this.createUrl).origin, token);
    const retry = this.retryContext(options, input.onProgress, signal);
    const creditsBefore = await withHailuoRetries('credits', () => client.getCredits(), retry);

    const references = [
      {
        imagePath: input.imagePath,
        mimeType: input.mimeType,
        originalName: input.originalName
      },
      ...(input.referenceImages ?? [])
    ].slice(0, 9);
    const uploaded: UploadedFile[] = [];
    for (const reference of references) {
      const buffer = await readFile(reference.imagePath);
      uploaded.push(await withHailuoRetries('upload', () => client.uploadImage({
        buffer,
        fileName: reference.originalName ?? path.basename(reference.imagePath),
        mimeType: reference.mimeType ?? mimeFromPath(reference.imagePath),
        frameType: 4
      }), retry));
    }

    const generation = this.generationInput(input, uploaded, options);
    const submitted = await withHailuoRetries('submit', () => client.generateVideo(generation), retry);
    const referenceImages = uploaded.map((reference) => ({ fileId: reference.id, url: reference.url }));
    // From here on the provider owns the render: persist enough to find it again
    // and, should the render fail, to submit it again without the image files.
    input.onProgress?.({
      providerJobId: submitted.id,
      batchId: submitted.batchID,
      referenceImages,
      uploadedFiles: uploaded,
      creditsBefore: creditsBefore.totalCredits,
      renderAttempts: 1,
      retry: undefined
    });

    const { result, batchId, attempts } = await this.waitWithResubmits(client, {
      videoId: submitted.id,
      batchId: submitted.batchID,
      generation,
      renderAttempts: 1,
      referenceImages,
      uploadedFiles: uploaded,
      creditsBefore: creditsBefore.totalCredits
    }, retry);

    const creditsAfter = await client.getCredits().catch(() => undefined);
    return {
      ...describeResult(input.text, result, batchId),
      referenceImages,
      creditsBefore: creditsBefore.totalCredits,
      creditsAfter: creditsAfter?.totalCredits,
      creditsSpent: creditsAfter ? creditsBefore.totalCredits - creditsAfter.totalCredits : undefined,
      renderAttempts: attempts
    };
  }

  /**
   * Poll one render. When it fails, wait the next back-off and try again: a
   * timed-out render is polled further under the same id (it is still
   * rendering, a second submission would pay twice); anything else is
   * submitted again with the files already uploaded. Poll retries exhausted
   * inside `waitForVideo` and the credit rejection are final; so is the last
   * try, thrown as a classified `HailuoJobError`.
   */
  private async waitWithResubmits(
    client: HailuoClient,
    state: {
      videoId: string;
      batchId: string;
      generation?: GenerateVideoInput;
      renderAttempts: number;
      referenceImages?: Array<{ fileId: string; url: string }>;
      uploadedFiles?: UploadedFile[];
      creditsBefore?: number;
    },
    retry: RetryContext
  ): Promise<{ result: VideoResult; batchId: string; attempts: number }> {
    const { options, signal, onProgress, delaysMs: delays } = retry;
    const maxAttempts = delays.length + 1;
    let { videoId, batchId, renderAttempts } = state;
    // Every pass through the loop, resubmission or continued poll, is one try.
    let attempt = 1;

    for (;;) {
      try {
        const result = await client.waitForVideo(videoId, {
          timeoutMs: options.pollTimeoutMs,
          intervalMs: options.pollIntervalMs,
          retryDelaysMs: delays,
          signal,
          onPoll: (poll) => onProgress?.({ percent: poll.percent, message: poll.message, retry: undefined }),
          onPollRetry: (info) => onProgress?.(retryProgress(info))
        });
        return { result, batchId, attempts: renderAttempts };
      } catch (error) {
        if (signal?.aborted) throw error;
        // Poll retries were already spent inside waitForVideo: that verdict stands.
        if (error instanceof HailuoJobError) throw error;
        const failure = classifyHailuoError(error);
        const keepPolling = error instanceof HailuoRenderTimeoutError;
        const canRetry = failure.retryable
          && attempt < maxAttempts
          && (keepPolling || state.generation !== undefined);
        if (!canRetry) throw new HailuoJobError(failure, attempt, 'render', { cause: error });

        const delayMs = delays[attempt - 1]!;
        onProgress?.(retryProgress({ step: 'render', attempt, maxAttempts, delayMs, failure }));
        await sleep(delayMs, signal);
        attempt += 1;
        if (keepPolling) {
          onProgress?.({ retry: undefined, message: `继续等待海螺渲染（第 ${attempt}/${maxAttempts} 轮）` });
          continue;
        }

        let submitted: GenerateVideoResult;
        try {
          submitted = await withHailuoRetries('submit', () => client.generateVideo(state.generation!), retry);
        } catch (submitError) {
          // The resubmission itself could not be placed. A verdict about the
          // submission's own content or account (moderation after its retries,
          // credits) stands on its own; anything else is reported as the render
          // failure we were retrying, with the cause kept.
          const verdict = submitError instanceof HailuoJobError
            && (!submitError.retryable || submitError.kind === 'content_rejected');
          throw verdict
            ? submitError
            : new HailuoJobError(failure, attempt, 'render', { cause: submitError });
        }
        renderAttempts += 1;
        videoId = submitted.id;
        batchId = submitted.batchID || batchId;
        onProgress?.({
          providerJobId: videoId,
          batchId,
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
    options: HailuoAdapterOptions
  ): GenerateVideoInput {
    const overrides = input.options ?? {};
    return {
      text: input.text,
      fileList: uploaded,
      modelID: 'hailuo3.0-i2v',
      resolution: overrides.resolution ?? options.video.resolution,
      duration: overrides.durationSeconds ?? options.video.duration,
      aspectRatio: overrides.aspectRatio ?? options.video.aspectRatio,
      referenceMode: 'all-reference' as ReferenceMode,
      quantity: 1,
      useOriginPrompt: true
    };
  }

  private retryContext(
    options: HailuoAdapterOptions,
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

  async getCredits(page: Page): Promise<CreditBalance> {
    const directBalance = await requestCreditsDirect(page, this.createUrl);
    if (directBalance) return directBalance;

    const creditResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET' && url.pathname === CREDIT_API_PATH;
    }, { timeout: 15_000 });

    await page.goto(this.createUrl, { waitUntil: 'domcontentloaded' });
    const response = await creditResponse;
    if (!response.ok()) {
      throw new Error(`Hailuo credit API returned HTTP ${response.status()}`);
    }

    return parseCreditBalance(await response.json());
  }

  async run(page: Page, input: AdapterInput): Promise<unknown> {
    const creditBalance = await this.getCredits(page);
    if (page.url() === 'about:blank') {
      await page.goto(this.createUrl, { waitUntil: 'domcontentloaded' });
    }

    const uploadButton = page.getByRole('button', { name: UPLOAD_LABEL }).first();
    await uploadButton.waitFor({ state: 'visible' });

    const uploadInput = uploadButton.locator('xpath=..').locator('input[type="file"]').first();
    await uploadInput.setInputFiles(input.imagePath);
    await waitForReferenceUpload(page);

    const promptEditor = page.locator(
      '#video-create-textarea[role="textbox"][contenteditable="true"]'
    );
    await promptEditor.waitFor({ state: 'visible' });
    await promptEditor.fill(input.text);

    const createButton = page.getByRole('button', { name: /^创作$/ }).first();
    await createButton.waitFor({ state: 'visible' });
    await createButton.click();

    // Let the page start its submission before the job runner closes the context.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    return {
      status: 'submitted',
      text: input.text,
      currentCredits: creditBalance.totalCredits,
      creditBalance,
      pageUrl: page.url()
    };
  }
}

async function requestCreditsDirect(page: Page, createUrl: string): Promise<CreditBalance | undefined> {
  try {
    const origin = new URL(createUrl).origin;
    const token = readTokenCookie(await page.context().cookies(origin));
    if (!token) return undefined;

    const { pathWithQuery, yy } = signRequest({
      path: CREDIT_API_PATH,
      method: 'GET',
      unix: String(Date.now())
    });
    const response = await page.context().request.get(`${origin}${pathWithQuery}`, {
      headers: {
        'content-type': 'application/json',
        token,
        yy
      }
    });
    if (!response.ok()) return undefined;
    return parseCreditBalance(await response.json());
  } catch {
    return undefined;
  }
}

interface RetryContext {
  options: HailuoAdapterOptions;
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

function stepLabel(step: string): string {
  switch (step) {
    case 'credits': return '读取余额';
    case 'upload': return '上传参考图';
    case 'submit': return '提交生成';
    case 'poll': return '查询生成状态';
    case 'render': return '海螺生成';
    default: return step;
  }
}

function describeResult(text: string, result: VideoResult, batchId: string) {
  return {
    status: 'succeeded' as const,
    text,
    videoId: result.id,
    batchId: result.batchID ?? batchId,
    videoUrl: result.videoUrl,
    downloadUrls: result.downloadUrls,
    coverUrl: result.coverUrl,
    durationSeconds: result.durationSeconds
  };
}

function mimeFromPath(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'image/png';
}

async function waitForReferenceUpload(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll<HTMLElement>('[role="button"][aria-label]')];
    return buttons.some((button) => {
      const label = button.getAttribute('aria-label') ?? '';
      const match = label.match(/^Upload 参考 \((\d+)\/12\)$/);
      return match ? Number(match[1]) > 0 : false;
    });
  });
}
