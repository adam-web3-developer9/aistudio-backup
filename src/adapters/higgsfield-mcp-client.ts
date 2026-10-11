import { fetch } from 'undici';
import type { CreditBalance } from '../types.js';
import {
  mediaKindFromMimeType,
  type HiggsfieldJob,
  type HiggsfieldJobSet,
  type HiggsfieldJobStatus,
  type HiggsfieldMediaKind,
  type UploadedMedia
} from './higgsfield-client.js';
import {
  HiggsfieldJobFailedError,
  HiggsfieldJobNotFoundError,
  HiggsfieldRenderTimeoutError,
  classifyHiggsfieldError
} from './higgsfield-retry.js';
import {
  HiggsfieldMcpError,
  readCost,
  readCredits,
  readId,
  readJobStatus,
  readUpload,
  type HiggsfieldMcpSession
} from './higgsfield-mcp.js';
import { DEFAULT_RETRY_DELAYS_MS, ProviderJobError, sleep, type RetryAttemptInfo } from './provider-retry.js';

/**
 * The Higgsfield channel as the MCP server presents it.
 *
 * Same job as the old gateway client — upload, submit, poll — against the
 * interface Higgsfield actually offers to programs. Two differences are worth
 * knowing when reading this:
 *
 *  - **A cost preflight is exact and free.** `generate_video` with `get_cost`
 *    prices the very request that would be submitted, so `estimateCost` is a
 *    real quote rather than the floor the old price table could give.
 *  - **There are jobs, not job sets.** Submitting answers with one id per
 *    generation. The `HiggsfieldJobSet` shape is kept so the adapter, the
 *    persisted progress and the resume path do not change; a set here is simply
 *    the job that was submitted.
 */

/** Where a media sits in a generation, in the MCP server's vocabulary. */
export type HiggsfieldMediaRole =
  | 'start_image'
  | 'end_image'
  | 'image_references'
  | 'video_references'
  | 'audio_references';

export interface McpGenerateVideoInput {
  /** The model's own id, e.g. `seedance_2_5`. */
  model: string;
  prompt: string;
  /**
   * Generation mode. For seedance 2.5: `t2v`, `omni_reference`, `video_edit`
   * (billed by the reference video's own duration — `duration` and
   * `aspect_ratio` are ignored) or `video_extension`.
   */
  mode?: string;
  media: UploadedMedia[];
  /** Everything else the model understands: resolution, duration, seed… */
  params?: Record<string, unknown>;
}

const TERMINAL: ReadonlySet<HiggsfieldJobStatus> = new Set<HiggsfieldJobStatus>([
  'completed',
  'failed',
  'nsfw',
  'canceled'
]);

/** The platform's own words for a status, mapped onto this service's set. */
function normalizeStatus(value: string | undefined): HiggsfieldJobStatus {
  switch (value?.toLowerCase()) {
    case 'completed':
    case 'succeeded':
    case 'success':
      return 'completed';
    case 'failed':
    case 'error':
      return 'failed';
    case 'nsfw':
      return 'nsfw';
    case 'canceled':
    case 'cancelled':
      return 'canceled';
    case 'queued':
    case 'pending':
      return 'queued';
    default:
      return 'in_progress';
  }
}

/**
 * Which slot an uploaded file goes in.
 *
 * The first image is the start frame — that is what image-to-video means on
 * every channel here — and further images ride along as references. Video and
 * audio have one slot each.
 */
export function roleForMedia(media: UploadedMedia, index: number, mode?: string): HiggsfieldMediaRole {
  const kind: HiggsfieldMediaKind = media.kind;
  if (kind === 'video') return 'video_references';
  if (kind === 'audio') return 'audio_references';
  // In video_edit the reference video leads; a still is then only a reference.
  if (mode === 'video_edit' || mode === 'video_extension') return 'image_references';
  return index === 0 ? 'start_image' : 'image_references';
}

export class HiggsfieldMcpClient {
  constructor(private readonly session: HiggsfieldMcpSession) {}

  async getCredits(signal?: AbortSignal): Promise<CreditBalance> {
    const { credits, plan } = readCredits(await this.session.callTool('balance', {}, signal));
    return {
      totalCredits: credits,
      breakdown: [{ creditType: 0, credits, record: { source: plan ?? 'mcp' } }]
    };
  }

  /**
   * Upload one file: ask for a presigned target, put the bytes there, confirm.
   *
   * The bytes go straight to object storage without the token, exactly as on
   * the other channels, so nothing large travels through the MCP session.
   */
  async uploadMedia(input: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    signal?: AbortSignal;
  }): Promise<UploadedMedia> {
    const kind = mediaKindFromMimeType(input.mimeType);
    const created = await this.session.callTool('media_upload', {
      files: [{ filename: input.fileName, content_type: input.mimeType }]
    }, input.signal);
    const { mediaId, uploadUrl } = readUpload(created);

    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': input.mimeType },
      body: new Uint8Array(input.buffer),
      signal: input.signal
    });
    if (!put.ok) {
      const detail = await put.text().catch(() => '');
      throw new HiggsfieldMcpError(put.status, `Storage PUT for ${input.fileName} failed: ${detail.slice(0, 200)}`, 'media_upload');
    }

    await this.session.callTool('media_confirm', { type: kind, media_ids: [mediaId] }, input.signal);
    return {
      id: mediaId,
      kind,
      mimeType: input.mimeType,
      fileName: input.fileName,
      sizeBytes: input.buffer.byteLength
    };
  }

  /** What this exact request will cost, from the platform. No job is created. */
  async estimateCost(input: McpGenerateVideoInput, signal?: AbortSignal): Promise<number | undefined> {
    try {
      return readCost(await this.session.callTool(
        'generate_video',
        { params: { ...this.paramsFor(input), get_cost: true } },
        signal
      ));
    } catch {
      // A quote is a convenience; never let it fail a job.
      return undefined;
    }
  }

  async generateVideo(input: McpGenerateVideoInput, signal?: AbortSignal): Promise<HiggsfieldJobSet> {
    const result = await this.session.callTool('generate_video', { params: this.paramsFor(input) }, signal);
    const jobId = readId(result);
    if (!jobId) {
      throw new HiggsfieldMcpError(200, `generate_video named no job: ${result.text.slice(0, 200)}`, 'generate_video');
    }
    return {
      id: jobId,
      jobs: [{ id: jobId, status: 'queued', raw_payload: result.text }],
      raw: result.text
    };
  }

  private paramsFor(input: McpGenerateVideoInput): Record<string, unknown> {
    return {
      model: input.model,
      prompt: input.prompt,
      ...(input.mode ? { mode: input.mode } : {}),
      ...input.params,
      use_unlim: false,
      ...(input.media.length
        ? {
          medias: input.media.map((media, index) => ({
            value: media.id,
            role: roleForMedia(media, index, input.mode)
          }))
        }
        : {})
    };
  }

  async getJobSet(jobSetId: string, signal?: AbortSignal): Promise<HiggsfieldJobSet> {
    let result;
    try {
      result = await this.session.callTool('job_status', { jobId: jobSetId }, signal);
    } catch (error) {
      if (error instanceof HiggsfieldMcpError && error.status === 404) {
        throw new HiggsfieldJobNotFoundError(jobSetId);
      }
      throw error;
    }
    const { status, url } = readJobStatus(result);
    const job: HiggsfieldJob = {
      id: jobSetId,
      status: normalizeStatus(status),
      ...(url ? { raw: { url, type: 'video' } } : {}),
      raw_payload: result.text
    };
    return { id: jobSetId, jobs: [job], raw: result.text };
  }

  /**
   * Poll until the job settles or the clock runs out.
   *
   * A poll that fails says nothing about the render, which keeps going upstream,
   * so failures are retried on their own schedule and only a run of them gives
   * up. This mirrors the gateway client it replaces.
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

      const job = jobSet.jobs[0];
      if (job && TERMINAL.has(job.status)) {
        if (job.status === 'completed') return jobSet;
        throw new HiggsfieldJobFailedError(job.id, job.status, job.reason ?? 'the platform reported no reason');
      }
      if (Date.now() >= deadline) throw new HiggsfieldRenderTimeoutError(jobSetId, options.timeoutMs);
      await sleep(interval, options.signal);
    }
  }
}
