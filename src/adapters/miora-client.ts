import { randomBytes, randomUUID } from 'node:crypto';
import { mioraDiagnostic, mioraNetworkCode, withMioraDiagnosticContext } from './miora-diagnostics.js';
import type { CreditBalance } from '../types.js';
import {
  CDN_SIGN_PATH,
  CREDIT_API_PATH,
  GENERATE_VIDEO_PATH,
  PROGRESS_PATH,
  STS_TOKENS_PATH,
  MioraApiError,
  MioraAuthError,
  describeMioraToken,
  mioraRequest,
  parseCreditBalance,
  refreshAuthToken,
  toApiError,
  uploadToCos,
  type MioraCosGrant,
  type MioraResponse,
  type MioraTokens
} from './miora-api.js';
import {
  MioraRenderTimeoutError,
  MioraTaskFailedError,
  MioraTaskNotFoundError,
  classifyMioraError
} from './miora-retry.js';
import { DEFAULT_RETRY_DELAYS_MS, ProviderJobError, sleep, type RetryAttemptInfo } from './provider-retry.js';

export interface MioraGenerateVideoInput {
  model: string;
  prompt: string;
  durationSeconds: number;
  resolution: string;
  aspectRatio: string;
  /** COS object keys from `uploadImage`. minimax-h3 takes up to 9. */
  referenceImageKeys?: string[];
  referenceVideoKeys?: string[];
  referenceAudioKeys?: string[];
  /**
   * Only sent when the model supports it (`supportsAudioControl`). minimax-h3
   * does not, and sending it there is rejected as VIDEO_UNSUPPORTED_AUDIO_CONTROL.
   */
  generateAudio?: boolean;
  workflowId?: string;
}

export type MioraTaskStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface MioraTask {
  taskId: string;
  status: MioraTaskStatus;
  /** 0-100 while rendering. */
  progress?: number;
  /** A ready-to-download signed URL, when the platform included one. */
  resultSignUrl?: string;
  /** The COS key of the result; `getCdnSignUrl` turns it into a URL. */
  resultFileKey?: string;
  errorMessage?: string;
  raw: unknown;
}

const TERMINAL: ReadonlySet<MioraTaskStatus> = new Set<MioraTaskStatus>(['succeeded', 'failed']);

/**
 * Direct client for the Miora `/api/ai` endpoints — the same calls the web app
 * makes. Holds the account's tokens and, on a 401, swaps the refresh token for a
 * fresh authToken once before giving up, so a token that lapses mid-job does not
 * sink it. `onTokens` (optional) lets the caller persist a renewed pair.
 */
export class MioraClient {
  private static readonly workflowIds = new Map<string, Promise<string | undefined>>();
  private tokens: MioraTokens;
  private refreshing?: Promise<void>;

  constructor(
    tokens: MioraTokens,
    private readonly onTokens?: (previous: MioraTokens, tokens: MioraTokens) => void | Promise<void>
  ) {
    this.tokens = tokens;
  }

  get credentials(): MioraTokens {
    return this.tokens;
  }

  async getCredits(signal?: AbortSignal): Promise<CreditBalance> {
    const response = await this.request(CREDIT_API_PATH, { signal });
    if (response.status < 200 || response.status >= 300) throw toApiError(response, CREDIT_API_PATH);
    return parseCreditBalance(response.json, response.status);
  }

  /**
   * Upload one reference file and return its COS key. Fetches a fresh STS grant
   * per upload, as the web app does; the key names the account's own prefix, so
   * a key uploaded for one account cannot be reused by another.
   */
  async uploadImage(input: {
    buffer: Buffer;
    mimeType: string;
    /** File extension including the dot, e.g. `.png`; used only to name the object. */
    extension?: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const grant = await this.getCosGrant(input.signal);
    const extension = input.extension || extensionForMime(input.mimeType);
    const name = `a${Date.now().toString(36)}${randomBytes(3).toString('hex')}${extension}`;
    return uploadToCos(grant, input.buffer, name, input.mimeType, input.signal);
  }

  async getCosGrant(signal?: AbortSignal): Promise<MioraCosGrant> {
    const response = await this.request<{ data?: MioraCosGrant }>(STS_TOKENS_PATH, { signal });
    const grant = response.json?.data;
    if (!grant?.bucket || !grant.secret_id) throw toApiError(response, STS_TOKENS_PATH);
    return grant;
  }

  /** Reuse the desktop workbench's per-account project for platform history. */
  async getOrCreateWorkflowId(signal?: AbortSignal): Promise<string | undefined> {
    const accountId = describeMioraToken(this.tokens.authToken)?.userId;
    if (!accountId) return this.lookupWorkflowId(signal);
    let pending = MioraClient.workflowIds.get(accountId);
    if (!pending) {
      pending = this.lookupWorkflowId(signal).catch((error) => {
        MioraClient.workflowIds.delete(accountId);
        throw error;
      });
      MioraClient.workflowIds.set(accountId, pending);
    }
    return pending;
  }

  private async lookupWorkflowId(signal?: AbortSignal): Promise<string | undefined> {
    const listing = await this.request<{ data?: { list?: Array<{ id?: string | number; title?: string }> } }>(
      '/workflow/list?page=1&pageSize=20', { signal }
    );
    const existing = listing.json?.data?.list?.find((workflow) =>
      /本地工作台|MioraWorkbench/i.test(workflow.title ?? '')
    );
    if (existing?.id != null) return String(existing.id);
    if (listing.status < 200 || listing.status >= 300 || !listing.json?.data) {
      throw toApiError(listing, '/workflow/list');
    }
    const created = await this.request<{ data?: string | number | { id?: string | number } }>(
      '/workflow/create', { method: 'POST', body: { name: 'Miora 本地工作台' }, signal }
    );
    const value = created.json?.data;
    const id = typeof value === 'object' && value !== null ? value.id : value;
    if (id == null || id === '') throw toApiError(created, '/workflow/create');
    return String(id);
  }

  /** Submit a video generation and return its platform task id. */
  async generateVideo(input: MioraGenerateVideoInput, signal?: AbortSignal, beforeSubmit?: () => Promise<void>): Promise<string> {
    const body: Record<string, unknown> = {
      type: 'text_to_video',
      model: input.model,
      prompt: input.prompt,
      duration: Number(input.durationSeconds),
      extraParameters: { aspectRatio: input.aspectRatio, resolution: input.resolution },
      nodeId: randomUUID(),
      sandboxTraceId: randomBytes(16).toString('hex')
    };
    if (input.referenceImageKeys?.length) body.referenceImageFileKeys = input.referenceImageKeys;
    if (input.referenceVideoKeys?.length) body.referenceVideoFileKeys = input.referenceVideoKeys;
    if (input.referenceAudioKeys?.length) body.referenceAudioFileKeys = input.referenceAudioKeys;
    if (input.generateAudio !== undefined) body.generateAudio = input.generateAudio;
    if (input.workflowId) body.workflowId = input.workflowId;

    const response = await this.request<{
      data?: { taskId?: string; data?: { taskId?: string } };
    }>(GENERATE_VIDEO_PATH, { method: 'POST', body, signal }, beforeSubmit);

    const taskId = response.json?.data?.data?.taskId ?? response.json?.data?.taskId;
    if (!taskId) throw toApiError(response, GENERATE_VIDEO_PATH);
    mioraDiagnostic('miora.task.submitted', { taskId });
    return taskId;
  }

  /** One progress read for a video task. */
  async getTask(taskId: string, signal?: AbortSignal): Promise<MioraTask> {
    const response = await this.request<{
      data?: { tasks?: Record<string, RawTask> };
    }>(PROGRESS_PATH, {
      method: 'POST',
      body: { videoTaskIds: [taskId] },
      signal
    });
    // A failed read (5xx, 429, an error payload) says nothing about the task;
    // report it as what it is so it is not mistaken for a missing task.
    if (response.status < 200 || response.status >= 300 || !response.json?.data) {
      throw toApiError(response, PROGRESS_PATH);
    }
    const tasks = response.json.data.tasks;
    // The platform keys the map by task id, but has been seen to answer with a
    // single differently-keyed entry; fall back to the only value present.
    const raw = tasks?.[taskId] ?? (tasks ? Object.values(tasks)[0] : undefined);
    if (!raw) throw new MioraTaskNotFoundError(taskId);
    const task = normalizeTask(taskId, raw);
    mioraDiagnostic('miora.task.poll', { taskId, outcome:task.status });
    return task;
  }

  /** Turn a result COS key into a downloadable signed URL. */
  async getCdnSignUrl(fileKey: string, signal?: AbortSignal): Promise<string> {
    const response = await this.request<{ data?: unknown }>(CDN_SIGN_PATH, {
      method: 'POST',
      body: { filePaths: [fileKey] },
      signal
    });
    const data = response.json?.data;
    const url =
      typeof data === 'string'
        ? data
        : Array.isArray(data)
          ? (data[0] as { signUrl?: string; url?: string })?.signUrl ?? (data[0] as { url?: string })?.url
          : (data as { signUrl?: string; url?: string })?.signUrl ?? (data as { url?: string })?.url;
    if (!url) throw toApiError(response, CDN_SIGN_PATH);
    return url;
  }

  /**
   * Poll until the task settles or `timeoutMs` runs out. A poll that fails to
   * reach Miora is retried on `retryDelaysMs` rather than treated as a verdict on
   * the render; only when every retry in a row fails does the wait give up.
   */
  async waitForTask(taskId: string, options: {
    timeoutMs: number;
    intervalMs?: number;
    retryDelaysMs?: readonly number[];
    signal?: AbortSignal;
    onPoll?: (task: MioraTask) => void;
    onPollRetry?: (info: RetryAttemptInfo) => void;
  }): Promise<MioraTask> {
    const started = performance.now();
    try {
      const task = await withMioraDiagnosticContext({ taskId }, () => this.pollTask(taskId, options));
      mioraDiagnostic('miora.task.finished', { taskId, outcome:'succeeded', elapsedMs:performance.now() - started });
      return task;
    } catch (error) {
      mioraDiagnostic('miora.task.finished', { taskId, outcome:options.signal?.aborted ? 'cancelled' : error instanceof MioraRenderTimeoutError ? 'timeout' : 'failed', code:classifyMioraError(error).code, networkCode:mioraNetworkCode(error), elapsedMs:performance.now() - started });
      throw error;
    }
  }

  private async pollTask(taskId: string, options: Parameters<MioraClient['waitForTask']>[1]): Promise<MioraTask> {
    const interval = options.intervalMs ?? 5_000;
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const deadline = Date.now() + options.timeoutMs;
    let consecutiveFailures = 0;

    for (;;) {
      let task: MioraTask;
      try {
        task = await this.getTask(taskId, options.signal);
        consecutiveFailures = 0;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        if (error instanceof MioraTaskNotFoundError) {
          // The progress map can leave a task out for a while (right after submit,
          // or while the platform is busy). Miora's own workbench just keeps
          // polling; do the same until the render budget runs out. Never resubmit
          // from here — the task may well exist and a second one would pay twice.
          consecutiveFailures = 0;
          if (Date.now() + interval > deadline) {
            throw new ProviderJobError(classifyMioraError(error), 1, 'poll', { cause: error });
          }
          await sleep(interval, options.signal);
          continue;
        }
        const failure = classifyMioraError(error);
        if (!failure.retryable || consecutiveFailures >= retryDelays.length) {
          throw new ProviderJobError(failure, consecutiveFailures + 1, 'poll', { cause: error });
        }
        const delayMs = retryDelays[consecutiveFailures]!;
        mioraDiagnostic('miora.task.poll_retry', { taskId, retry:consecutiveFailures + 1, delayMs, code:failure.code, networkCode:mioraNetworkCode(error) });
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
      if (TERMINAL.has(task.status)) {
        throw new MioraTaskFailedError(task.taskId, task.errorMessage ?? 'unknown reason');
      }
      if (Date.now() + interval > deadline) {
        throw new MioraRenderTimeoutError(taskId, options.timeoutMs);
      }
      await sleep(interval, options.signal);
    }
  }

  /**
   * One `/api/ai` call, with a single refresh-and-retry on 401. Non-2xx that is
   * not a 401 comes back for the caller to classify (Miora reports app errors
   * with a 200 as often as with a status).
   */
  private async request<T = unknown>(
    path: string,
    options: Parameters<typeof mioraRequest>[2] = {},
    beforeRequest?: () => Promise<void>
  ): Promise<MioraResponse<T>> {
    const withCookie = { ...options, cookie: options.cookie ?? this.tokens.cookie, beforeRequest };
    try {
      return await mioraRequest<T>(this.tokens.authToken, path, withCookie);
    } catch (error) {
      if (error instanceof MioraAuthError && this.tokens.refreshToken) {
        mioraDiagnostic('miora.api.auth_retry', { path, httpStatus:401, retry:1 });
        await this.refresh(options.signal);
        return mioraRequest<T>(this.tokens.authToken, path, { ...withCookie, cookie: this.tokens.cookie });
      }
      throw error;
    }
  }

  /** Concurrent callers share one refresh. */
  private async refresh(signal?: AbortSignal): Promise<void> {
    const refreshToken = this.tokens.refreshToken;
    if (!refreshToken) throw new MioraApiError(401, 'NO_REFRESH_TOKEN', 'account has no refresh token', '/api/auth/refresh-token');
    this.refreshing ??= refreshAuthToken(refreshToken, { cookie: this.tokens.cookie, signal })
      .then((tokens) => {
        // Keep the site cookie across a token refresh — it is not reissued here.
        const previous = this.tokens;
        this.tokens = { ...tokens, cookie: previous.cookie };
        return this.onTokens?.(previous, this.tokens);
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    await this.refreshing;
  }
}

interface RawTask {
  status?: string;
  progress?: number;
  resultSignUrl?: string;
  signUrls?: string[];
  resultFileKey?: string;
  errorMessage?: string;
}

function normalizeTask(taskId: string, raw: RawTask): MioraTask {
  return {
    taskId,
    status: toStatus(raw.status),
    progress: typeof raw.progress === 'number' ? raw.progress : undefined,
    resultSignUrl: raw.resultSignUrl ?? raw.signUrls?.[0],
    resultFileKey: raw.resultFileKey ?? undefined,
    errorMessage: raw.errorMessage ?? undefined,
    raw
  };
}

function toStatus(status: string | undefined): MioraTaskStatus {
  switch (String(status ?? '').toLowerCase()) {
    case 'completed':
    case 'success':
    case 'succeeded':
      return 'succeeded';
    case 'failed':
    case 'error':
      return 'failed';
    case 'queued':
    case 'pending':
    case 'waiting':
      return 'queued';
    default:
      // An unknown status is treated as still running: keep polling rather than
      // declaring a verdict the platform did not give.
      return 'running';
  }
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'video/mp4':
      return '.mp4';
    case 'video/quicktime':
      return '.mov';
    case 'video/webm':
      return '.webm';
    default:
      return '.png';
  }
}
