import { randomUUID } from 'node:crypto';
import { fetch, FormData } from 'undici';
import type { CreditBalance } from '../types.js';
import {
  dreamMakerRequest,
  fetchPricing,
  fetchQuote,
  parseCreditBalance,
  CREDIT_API_PATH,
  GENERATE_VIDEO_PATH,
  type DreamMakerPricingTable,
  type DreamMakerQuote
} from './dreammaker-api.js';
import {
  DreamMakerRenderTimeoutError,
  DreamMakerTaskFailedError,
  DreamMakerTaskNotFoundError,
  classifyDreamMakerError
} from './dreammaker-retry.js';
import { DEFAULT_RETRY_DELAYS_MS, ProviderJobError, sleep, type RetryAttemptInfo } from './provider-retry.js';

/**
 * `mode` in the canvas bundle: which inputs the model is given. These are the
 * ones seen in the web app; the field is typed as a plain string wherever it
 * crosses the wire, because the platform can add modes without us.
 */
export type DreamMakerMode =
  | 'text2video'
  | 'image2video'
  | 'firstLastFrame'
  | 'imageReference'
  | 'allReference';

export const DEFAULT_MODE: DreamMakerMode = 'image2video';

/** A file the platform has accepted and can be referenced by URL in a generation. */
export interface UploadedFile {
  uploadId: string;
  ossUri: string;
  /** Signed URL — this is what the generation endpoints take. */
  url: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface GenerateVideoInput {
  model: string;
  /** One of `DreamMakerMode`, or anything else the platform starts accepting. */
  mode: string;
  prompt: string;
  imageUrls?: string[];
  videoUrls?: string[];
  audioUrls?: string[];
  /** Model-specific knobs: duration, resolution, ratio, enableSound, … */
  options?: Record<string, unknown>;
  projectId?: string;
  canvasId?: string;
  nodeId?: string;
  clientRequestId?: string;
}

export interface DreamMakerArtifact {
  artifactId?: string;
  mediaType?: string;
  status?: string;
  ossUri?: string;
  url?: string;
  thumbnailUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  sizeBytes?: number;
  outputIndex?: number;
}

export type DreamMakerTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled';

export interface DreamMakerTask {
  taskId: string;
  status: DreamMakerTaskStatus;
  /** Finer-grained than `status`: queued, generating, archiving, succeeded, failed. */
  stage?: string;
  /** 0-100; the platform only moves it to 100 at the end for most models. */
  progress?: number;
  capability?: string;
  model?: string;
  artifacts: DreamMakerArtifact[];
  /** Credits this task actually cost — 0 until it succeeds. */
  creditCost?: number;
  balanceAfter?: number;
  errorCode?: string;
  errorMessage?: string;
  errorShort?: string;
  /** What the platform says would make it pass: retry, recharge, edit_prompt, … */
  errorAction?: string;
  resultPayload?: unknown;
  raw: unknown;
}

const TERMINAL_STATUSES = new Set<DreamMakerTaskStatus>(['succeeded', 'failed', 'canceled']);

/** Direct client for the DreamMaker web API — the same calls the canvas makes. */
export class DreamMakerClient {
  constructor(
    private readonly origin: string,
    private readonly token: string,
    private readonly accountId?: string
  ) {}

  async getCredits(): Promise<CreditBalance> {
    return parseCreditBalance(await this.request(CREDIT_API_PATH));
  }

  getPricing(): Promise<DreamMakerPricingTable> {
    return fetchPricing(this.origin, this.token);
  }

  /** Per-second price for one model at one resolution; charges nothing. */
  getQuote(
    input: { capability?: string; model: string; options?: Record<string, unknown>; quantity?: number },
    signal?: AbortSignal
  ): Promise<DreamMakerQuote> {
    return fetchQuote(this.origin, this.token, input, signal);
  }

  /**
   * Upload an image: `initiate` hands out an OSS form policy, the bytes go
   * straight to Aliyun, `complete` turns the object into a URL the generator
   * accepts. No credits are involved; it only uses the account's storage quota.
   */
  async uploadImage(input: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    signal?: AbortSignal;
  }): Promise<UploadedFile> {
    const initiated = await this.request<{
      uploadId: string;
      uploadUrl: string;
      method?: string;
      objectKey: string;
      formData?: Record<string, string>;
      constraints?: { contentType?: string };
    }>('/api/uploads/initiate', {
      method: 'POST',
      body: {
        intent: 'workspace_input',
        filename: input.fileName,
        mimeType: input.mimeType,
        sizeBytes: input.buffer.byteLength,
        clientRequestId: `upl-${randomUUID()}`
      },
      signal: input.signal
    });

    const contentType = initiated.constraints?.contentType ?? input.mimeType;
    const form = new FormData();
    for (const [key, value] of Object.entries(initiated.formData ?? {})) form.append(key, String(value));
    form.append('file', new Blob([new Uint8Array(input.buffer)], { type: contentType }), input.fileName);

    // Straight to Aliyun OSS: no token, no proxy — the same reasoning as Hailuo's uploads.
    const put = await fetch(initiated.uploadUrl, {
      method: initiated.method || 'POST',
      body: form,
      signal: input.signal
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => '');
      throw new Error(`OSS POST ${initiated.objectKey} failed: HTTP ${put.status} ${detail.slice(0, 200)}`);
    }

    const completed = await this.request<{ ossUri: string; url: string }>('/api/uploads/complete', {
      method: 'POST',
      body: {
        uploadId: initiated.uploadId,
        etag: put.headers.get('etag')?.trim() || undefined,
        sizeBytes: input.buffer.byteLength,
        mimeType: input.mimeType
      },
      signal: input.signal
    });

    return {
      uploadId: initiated.uploadId,
      ossUri: completed.ossUri,
      url: completed.url,
      fileName: input.fileName,
      mimeType: input.mimeType,
      sizeBytes: input.buffer.byteLength
    };
  }

  /**
   * Submit a video generation. Only `model` is required by the API; a canvas id
   * is not, so a headless caller can generate without owning a project.
   */
  async generateVideo(input: GenerateVideoInput, signal?: AbortSignal): Promise<DreamMakerTask> {
    const task = await this.request<RawTask>(GENERATE_VIDEO_PATH, {
      method: 'POST',
      body: {
        model: input.model,
        mode: input.mode,
        prompt: input.prompt,
        ...(input.imageUrls?.length ? { imageUrls: input.imageUrls } : {}),
        ...(input.videoUrls?.length ? { videoUrls: input.videoUrls } : {}),
        ...(input.audioUrls?.length ? { audioUrls: input.audioUrls } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.canvasId ? { canvasId: input.canvasId } : {}),
        ...(input.nodeId ? { nodeId: input.nodeId } : {}),
        clientRequestId: input.clientRequestId ?? `gen-${randomUUID()}`,
        options: input.options ?? {}
      },
      signal
    });
    return normalizeTask(task);
  }

  async getTask(taskId: string, signal?: AbortSignal): Promise<DreamMakerTask> {
    const { tasks } = await this.request<{ tasks?: RawTask[] }>('/api/canvas/tasks/batch', {
      method: 'POST',
      body: { taskIds: [taskId] },
      signal
    });
    // The batch endpoint answers 200 with an empty list for an id it does not
    // know, so "missing" has to be turned into an error here.
    const task = tasks?.find((entry) => entry?.taskId === taskId);
    if (!task) throw new DreamMakerTaskNotFoundError(taskId);
    return normalizeTask(task);
  }

  /** Give the task back and get the credits refunded; best-effort. */
  async cancelTask(taskId: string, signal?: AbortSignal): Promise<void> {
    await this.request(`/api/canvas/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', signal });
  }

  /**
   * Poll until the task settles or `timeoutMs` runs out.
   *
   * A poll that fails (cannot reach DreamMaker, does not find the task yet, any
   * other error) is not a verdict on the render, which keeps going upstream.
   * Such polls are retried on `retryDelaysMs`; only when every retry in a row
   * fails does the wait give up. A successful poll resets the count.
   */
  async waitForTask(taskId: string, options: {
    timeoutMs: number;
    intervalMs?: number;
    retryDelaysMs?: readonly number[];
    signal?: AbortSignal;
    onPoll?: (task: DreamMakerTask) => void;
    onPollRetry?: (info: RetryAttemptInfo) => void;
  }): Promise<DreamMakerTask> {
    const interval = options.intervalMs ?? 10_000;
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const deadline = Date.now() + options.timeoutMs;
    let consecutiveFailures = 0;

    for (;;) {
      let task: DreamMakerTask;
      try {
        task = await this.getTask(taskId, options.signal);
        consecutiveFailures = 0;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const failure = classifyDreamMakerError(error);
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
      options.onPoll?.(task);

      if (task.status === 'succeeded') return task;
      if (TERMINAL_STATUSES.has(task.status)) {
        throw new DreamMakerTaskFailedError(
          task.taskId,
          task.errorCode,
          task.errorMessage ?? (task.status === 'canceled' ? 'task was canceled' : 'unknown reason'),
          task.errorAction
        );
      }
      if (Date.now() + interval > deadline) {
        throw new DreamMakerRenderTimeoutError(taskId, options.timeoutMs);
      }
      await sleep(interval, options.signal);
    }
  }

  private request<T>(path: string, options: Parameters<typeof dreamMakerRequest>[3] = {}): Promise<T> {
    return dreamMakerRequest<T>(this.origin, this.token, path, { accountId: this.accountId, ...options });
  }
}

interface RawTask {
  taskId?: string;
  status?: string;
  stage?: string;
  progress?: number;
  capability?: string;
  model?: string;
  artifacts?: DreamMakerArtifact[];
  creditCost?: string | number;
  balanceAfter?: string | number;
  errorCode?: string | null;
  errorMessage?: string | null;
  errorShort?: string | null;
  errorAction?: string | null;
  resultPayload?: unknown;
}

function normalizeTask(raw: RawTask): DreamMakerTask {
  return {
    taskId: raw.taskId ?? '',
    status: toStatus(raw.status),
    stage: raw.stage ?? undefined,
    progress: typeof raw.progress === 'number' ? raw.progress : undefined,
    capability: raw.capability ?? undefined,
    model: raw.model ?? undefined,
    artifacts: raw.artifacts ?? [],
    creditCost: toNumber(raw.creditCost),
    balanceAfter: toNumber(raw.balanceAfter),
    errorCode: raw.errorCode ?? undefined,
    errorMessage: raw.errorMessage ?? undefined,
    errorShort: raw.errorShort ?? undefined,
    errorAction: raw.errorAction ?? undefined,
    resultPayload: raw.resultPayload ?? undefined,
    raw
  };
}

function toStatus(status: string | undefined): DreamMakerTaskStatus {
  switch (status) {
    case 'queued':
    case 'running':
    case 'succeeded':
    case 'failed':
    case 'canceled':
      return status;
    default:
      // An unknown status is treated as still running: the poll keeps asking
      // rather than declaring a verdict the platform did not give.
      return 'running';
  }
}

function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The finished video: the first ready video artifact, else whatever carries a URL. */
export function videoArtifact(task: DreamMakerTask): DreamMakerArtifact | undefined {
  return task.artifacts.find((artifact) => artifact.mediaType === 'video' && artifact.url)
    ?? task.artifacts.find((artifact) => artifact.url);
}
