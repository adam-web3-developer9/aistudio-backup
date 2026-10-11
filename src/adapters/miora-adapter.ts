import { readFile } from 'node:fs/promises';
import { prepareMioraPrompt } from './miora-prompt.js';
import path from 'node:path';
import type { Page } from 'playwright';
import type { BrowserCookie, CreditBalance, JobOptions, JobProgress, JobProgressUpdate } from '../types.js';
import { maskToken, type AdapterInput, type BrowserAdapter, type ResumeInput, type SessionIdentity } from './adapter.js';
import {
  describeMioraToken,
  readMioraTokens,
  type MioraTokens
} from './miora-api.js';
import {
  MioraClient,
  type MioraGenerateVideoInput,
  type MioraTask
} from './miora-client.js';
import {
  MioraRenderTimeoutError,
  classifyMioraError,
  isMioraInsufficientCreditsError,
  withMioraRetries
} from './miora-retry.js';
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
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm'
};

/** Credits per video second, from the workbench bundle (v1.2.0). */
const MIORA_PRICE_PER_SECOND: Record<string, number> = {
  'minimax-h3': 6.62,
  'minimax-h3-max': 6.85
};

/** Actual four-second price, without the dispatch ledger's integer rounding. */
export function mioraMinimumVideoCredits(model: string): number | undefined {
  const price = MIORA_PRICE_PER_SECOND[model];
  return price === undefined ? undefined : Math.round(price * 4 * 100) / 100;
}

export interface MioraVideoDefaults {
  /** The catalog `modelId`. Only minimax-h3 is wired in for now. */
  model: string;
  /** "768P" | "2K" for minimax-h3. */
  resolution: string;
  durationSeconds: number;
  /** "adaptive" or a ratio like "16:9". */
  aspectRatio: string;
}

export interface MioraAdapterOptions {
  video: MioraVideoDefaults;
  pollTimeoutMs: number;
  pollIntervalMs: number;
  retryDelaysMs?: readonly number[];
  onTokens?: (previous: MioraTokens, tokens: MioraTokens) => void | Promise<void>;
}

/** Worst-case wall time of one job, so the runner's timeout does not cut a retry short. */
export function mioraJobBudgetMs(
  options: Pick<MioraAdapterOptions, 'pollTimeoutMs' | 'retryDelaysMs'>
): number {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const retryWait = delays.reduce((sum, delay) => sum + delay, 0);
  return options.pollTimeoutMs * (delays.length + 1) + retryWait * 4 + 60_000;
}

/**
 * Miora (miora.design).
 *
 * The whole job runs over plain HTTP — upload references to Tencent COS under a
 * server-issued STS grant, submit `text_to_video`, poll `media-generate/progress`
 * — so this adapter never touches the browser pool. It is wired for the
 * `minimax-h3` model ("全能参考", multimodal reference input); other models are
 * left out on purpose.
 */
export class MioraAdapter implements BrowserAdapter {
  readonly id = 'miora-v1';
  readonly allowedCookieDomains = ['miora.design'];
  /**
   * Miora prices per model and tier and gives no cheap per-job quote, so the
   * estimate is always undefined and never a verdict: the pool hands the job to
   * the account with the most credits and lets the platform be the judge.
   */
  readonly costEstimateIsBinding = false;

  constructor(private readonly options?: MioraAdapterOptions) {}

  describeSession(cookies: readonly BrowserCookie[]): SessionIdentity | undefined {
    const tokens = readMioraTokens(cookies);
    if (!tokens) return undefined;
    return { tokenMasked: maskToken(tokens.authToken), account: describeMioraToken(tokens.authToken) };
  }

  /** Credits straight from the session token — skips the browser pool entirely. */
  async getCreditsFromCookies(cookies: readonly BrowserCookie[]): Promise<CreditBalance | undefined> {
    const tokens = readMioraTokens(cookies);
    if (!tokens) return undefined;
    return new MioraClient(tokens, this.options?.onTokens).getCredits();
  }

  /**
   * The desktop workbench's own per-second table (`PRICE_PER_SEC`), times the
   * duration. Only a ledger hint so a batch spreads across accounts instead of
   * all landing on one; never a verdict (`costEstimateIsBinding` is false).
   */
  estimateJobCost(_balance: CreditBalance, options?: JobOptions): number | undefined {
    const model = options?.modelId ?? this.options?.video.model;
    const duration = options?.durationSeconds ?? this.options?.video.durationSeconds;
    const perSecond = model ? MIORA_PRICE_PER_SECOND[model] : undefined;
    if (perSecond === undefined || !duration || duration <= 0) return undefined;
    return Math.ceil(perSecond * duration);
  }

  isInsufficientCreditsError(error: unknown): boolean {
    return isMioraInsufficientCreditsError(error);
  }

  runWithoutBrowser(
    cookies: readonly BrowserCookie[],
    input: AdapterInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined {
    const tokens = readMioraTokens(cookies);
    if (!tokens || !this.options) return undefined;
    return this.generate(tokens, input, this.options, signal);
  }

  resumeWithoutBrowser(
    cookies: readonly BrowserCookie[],
    progress: JobProgress,
    input: ResumeInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined {
    const tokens = readMioraTokens(cookies);
    if (!tokens || !this.options || !progress.providerJobId) return undefined;
    return this.resume(tokens, progress.providerJobId, progress, input, this.options, signal);
  }

  /** There is no browser path: everything this adapter does is an HTTP call. */
  async run(_page: Page, _input: AdapterInput): Promise<unknown> {
    throw new Error('Miora runs over the API only; the session is missing its auth token');
  }

  /**
   * Upload references → submit → poll, each step retried on its own schedule.
   * A render the platform reports as failed is resubmitted with the references
   * already uploaded; a render that only timed out is polled further under the
   * same task id (it is still going, a second submission would pay twice).
   */
  private async generate(
    tokens: MioraTokens,
    input: AdapterInput,
    options: MioraAdapterOptions,
    signal?: AbortSignal
  ): Promise<unknown> {
    const model = input.options?.modelId ?? options.video.model;
    const preparedPrompt = prepareMioraPrompt(input.text, model);
    if (preparedPrompt !== input.text) {
      input.onProgress?.({ message: `Miora 已优先保留分镜正文、按剩余空间选用素材说明及规则条款：${input.text.length} → ${preparedPrompt.length} 字符` });
    }
    const client = new MioraClient(tokens, options.onTokens);
    const retry = this.retryContext(options, input.onProgress, signal);
    const creditsBefore = await withMioraRetries('credits', () => client.getCredits(signal), retry);

    const references = [
      { imagePath: input.imagePath, mimeType: input.mimeType, originalName: input.originalName },
      ...(input.referenceImages ?? [])
    ];
    const uploaded: UploadedReference[] = [];
    for (const reference of references) {
      const buffer = await readFile(reference.imagePath);
      const mimeType = reference.mimeType ?? mimeFromPath(reference.imagePath);
      const key = await withMioraRetries('upload', () => client.uploadImage({
        buffer,
        mimeType,
        extension: path.extname(reference.imagePath) || undefined,
        signal
      }), retry);
      uploaded.push({ key, kind: kindOf(mimeType) });
    }

    const generation = this.generationInput({ ...input, text: preparedPrompt }, uploaded, options);
    // The desktop workbench attaches its own platform project before submission.
    // If project lookup is unavailable, generation remains usable without it.
    generation.workflowId = await client.getOrCreateWorkflowId(signal).catch(() => undefined);
    const taskId = await withMioraRetries('submit', () => client.generateVideo(generation, signal, input.beforeSubmit),
      { ...retry.asRetryOptions(), shouldRetry: input.allowPaidRetries === false ? () => false : undefined });
    // From here the platform owns the render: persist enough to find it again and,
    // should it fail, to submit it again without re-uploading the references.
    input.onProgress?.({
      providerJobId: taskId,
      uploadedFiles: uploaded,
      creditsBefore: creditsBefore.totalCredits,
      renderAttempts: 1,
      retry: undefined
    });

    const { task, attempts } = await this.waitWithResubmits(client, {
      taskId,
      generation,
      renderAttempts: 1,
      uploadedFiles: uploaded,
      creditsBefore: creditsBefore.totalCredits,
      beforeSubmit: input.beforeSubmit,
      allowPaidRetries: input.allowPaidRetries
    }, retry);

    return this.describeResult(client, input.text, task, {
      creditsBefore: creditsBefore.totalCredits,
      renderAttempts: attempts,
      signal
    });
  }

  private async resume(
    tokens: MioraTokens,
    taskId: string,
    progress: JobProgress,
    input: ResumeInput,
    options: MioraAdapterOptions,
    signal?: AbortSignal
  ): Promise<unknown> {
    const client = new MioraClient(tokens, options.onTokens);
    const retry = this.retryContext(options, input.onProgress, signal);
    const uploaded = Array.isArray(progress.uploadedFiles) && progress.uploadedFiles.length
      ? (progress.uploadedFiles as UploadedReference[])
      : undefined;
    const generation = uploaded
      ? this.generationInput({ text: prepareMioraPrompt(input.text, input.options?.modelId ?? options.video.model), options: input.options }, uploaded, options)
      : undefined;
    if (generation) generation.workflowId = await client.getOrCreateWorkflowId(signal).catch(() => undefined);

    const { task, attempts } = await this.waitWithResubmits(client, {
      taskId,
      generation,
      renderAttempts: progress.renderAttempts ?? 1,
      uploadedFiles: uploaded,
      creditsBefore: progress.creditsBefore,
      beforeSubmit: input.beforeSubmit,
      allowPaidRetries: input.allowPaidRetries
    }, retry);

    return {
      ...(await this.describeResult(client, input.text, task, {
        creditsBefore: progress.creditsBefore,
        renderAttempts: attempts,
        signal
      })),
      resumed: true
    };
  }

  private async waitWithResubmits(
    client: MioraClient,
    state: {
      taskId: string;
      generation?: MioraGenerateVideoInput;
      renderAttempts: number;
      uploadedFiles?: UploadedReference[];
      creditsBefore?: number;
      beforeSubmit?: () => Promise<void>;
      allowPaidRetries?: boolean;
    },
    retry: RetryContext
  ): Promise<{ task: MioraTask; attempts: number }> {
    const { options, signal, onProgress, delaysMs: delays } = retry;
    const maxAttempts = delays.length + 1;
    let { taskId, renderAttempts } = state;
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
            message: poll.status === 'queued' ? '平台排队中' : '生成中',
            retry: undefined
          }),
          onPollRetry: (info) => onProgress?.(retryProgress(info))
        });
        return { task, attempts: renderAttempts };
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof ProviderJobError) throw error;
        const failure = classifyMioraError(error);
        const keepPolling = error instanceof MioraRenderTimeoutError;
        const canRetry = failure.retryable
          && attempt < maxAttempts
          && (keepPolling || (state.allowPaidRetries !== false && state.generation !== undefined));
        if (!canRetry) throw new ProviderJobError(failure, attempt, 'render', { cause: error });

        const delayMs = delays[attempt - 1]!;
        onProgress?.(retryProgress({ step: 'render', attempt, maxAttempts, delayMs, failure }));
        await sleep(delayMs, signal);
        attempt += 1;
        if (keepPolling) {
          onProgress?.({ retry: undefined, message: `继续等待生成（第 ${attempt}/${maxAttempts} 轮）` });
          continue;
        }

        let resubmittedId: string;
        try {
          resubmittedId = await withMioraRetries('submit', () => client.generateVideo(state.generation!, signal, state.beforeSubmit), retry.asRetryOptions());
        } catch (submitError) {
          const verdict = submitError instanceof ProviderJobError
            && (!submitError.retryable || submitError.kind === 'content_rejected');
          throw verdict
            ? submitError
            : new ProviderJobError(failure, attempt, 'render', { cause: submitError });
        }
        renderAttempts += 1;
        taskId = resubmittedId;
        onProgress?.({
          providerJobId: taskId,
          percent: 0,
          message: undefined,
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
    uploaded: UploadedReference[],
    options: MioraAdapterOptions
  ): MioraGenerateVideoInput {
    const overrides = input.options ?? {};
    return {
      model: overrides.modelId ?? options.video.model,
      prompt: input.text,
      durationSeconds: overrides.durationSeconds ?? options.video.durationSeconds,
      resolution: overrides.resolution ?? options.video.resolution,
      aspectRatio: overrides.aspectRatio ?? options.video.aspectRatio,
      // "全能参考": route each reference to the key its kind belongs on. minimax-h3
      // takes up to 9 images, 3 videos, 3 audios. generateAudio is never sent —
      // minimax-h3 rejects it (VIDEO_UNSUPPORTED_AUDIO_CONTROL).
      referenceImageKeys: uploaded.filter((file) => file.kind === 'image').map((file) => file.key),
      referenceVideoKeys: uploaded.filter((file) => file.kind === 'video').map((file) => file.key),
      referenceAudioKeys: uploaded.filter((file) => file.kind === 'audio').map((file) => file.key)
    };
  }

  private async describeResult(
    client: MioraClient,
    text: string,
    task: MioraTask,
    context: { creditsBefore?: number; renderAttempts: number; signal?: AbortSignal }
  ) {
    let videoUrl = task.resultSignUrl;
    // The result's signed URL is short-lived and sometimes omitted; sign the key
    // ourselves so the caller always gets a fresh, working link.
    if (!videoUrl && task.resultFileKey) {
      videoUrl = await client.getCdnSignUrl(task.resultFileKey, context.signal);
    }
    if (!videoUrl) {
      throw new Error(`Miora task ${task.taskId} completed but has no downloadable result URL`);
    }
    return {
      status: 'succeeded' as const,
      text,
      taskId: task.taskId,
      model: this.options?.video.model,
      videoUrl,
      resultFileKey: task.resultFileKey,
      creditsBefore: context.creditsBefore,
      renderAttempts: context.renderAttempts
    };
  }

  private retryContext(
    options: MioraAdapterOptions,
    onProgress: ((progress: JobProgressUpdate) => void) | undefined,
    signal?: AbortSignal
  ): RetryContext {
    const delaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const onRetry = (info: RetryAttemptInfo) => onProgress?.(retryProgress(info));
    return {
      options,
      signal,
      onProgress,
      delaysMs,
      onRetry,
      asRetryOptions: () => ({ delaysMs, signal, onRetry })
    };
  }
}

interface UploadedReference {
  key: string;
  kind: 'image' | 'video' | 'audio';
}

interface RetryContext {
  options: MioraAdapterOptions;
  signal?: AbortSignal;
  onProgress?: (progress: JobProgressUpdate) => void;
  delaysMs: readonly number[];
  onRetry: (info: RetryAttemptInfo) => void;
  asRetryOptions: () => { delaysMs: readonly number[]; signal?: AbortSignal; onRetry: (info: RetryAttemptInfo) => void };
}

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
    case 'upload': return '上传参考素材';
    case 'submit': return '提交生成';
    case 'poll': return '查询任务状态';
    case 'render': return '生成';
    default: return step;
  }
}

function kindOf(mimeType: string): 'image' | 'video' | 'audio' {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'image';
}

function mimeFromPath(filePath: string): string {
  return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'image/png';
}
