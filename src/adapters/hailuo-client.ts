import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CreditBalance } from '../types.js';
import { CREDIT_API_PATH, hailuoRequest, parseCreditBalance } from './hailuo-api.js';
import {
  DEFAULT_RETRY_DELAYS_MS,
  HailuoCreationNotFoundError,
  HailuoJobError,
  HailuoRenderFailedError,
  HailuoRenderTimeoutError,
  type RetryAttemptInfo,
  classifyHailuoError,
  sleep
} from './hailuo-retry.js';
import { putObject, type OssPolicy } from './oss.js';

/** `AssetFileType` in the web bundle. */
export const AssetFileType = { Image: 1, Video: 2, Audio: 3 } as const;

/** `FrameType`: where an uploaded file sits in the generation. */
export const FrameType = {
  FirstFrame: 0,
  EndFrame: 1,
  Reference: 3,
  OnMix: 4
} as const;

/** `referenceMode` values the create page sends. */
export type ReferenceMode =
  | 'all-reference'
  | 'extend'
  | 'start-end-frames'
  | 'image-reference'
  | 'subject-reference';

/**
 * Plain image-to-video: the upload is the first frame.
 * `all-reference` (frameType OnMix) is the "全能参考" mode — it wants a
 * recognisable subject and fails at render time on abstract input.
 */
export const DEFAULT_REFERENCE_MODE: ReferenceMode = 'start-end-frames';
export const DEFAULT_FRAME_TYPE = 0;

export interface UploadedFile {
  id: string;
  name: string;
  type: string;
  url: string;
  coverUrl: string;
  characterID: string;
  frameType: number;
  referenceType: number;
  characterUrl: string;
  duration: number;
  assetFileType: number;
  videoID: string;
  durationMs: number;
}

export interface GenerateVideoInput {
  text: string;
  fileList: UploadedFile[];
  modelID: string;
  /** Seconds — 6 or 10 depending on the model. */
  duration?: number;
  /** "512" | "720" | "768" | "1080" — the API takes it as a string. */
  resolution?: string;
  aspectRatio?: string;
  referenceMode?: ReferenceMode;
  quantity?: number;
  /** false lets Hailuo rewrite the prompt; the web default is to keep it verbatim. */
  useOriginPrompt?: boolean;
  projectID?: string;
}

export interface GenerateVideoResult {
  /** The video id to poll. */
  id: string;
  /** Groups the videos of one submission; `quantity > 1` produces several ids. */
  batchID: string;
  videoIDs: string[];
  isFirstGenerate?: boolean;
}

/** `commonInfo.status`: 1 Start, 2 Finished, 3 Failed. */
export type VideoStatus = 'processing' | 'succeeded' | 'failed';

export interface VideoResult {
  id: string;
  batchID?: string;
  status: VideoStatus;
  /** 0-100 while rendering. */
  percent?: number;
  /** Hailuo's own progress/failure text, e.g. "内容生成失败。请重试。" */
  message?: string;
  messageDetail?: string;
  /** Set once the video finishes rendering. */
  videoUrl?: string;
  downloadUrls?: {
    watermarkURL?: string;
    withoutWatermarkURL?: string;
    aiWatermarkURL?: string;
    hailuoWatermarkURL?: string;
    fileName?: string;
  };
  coverUrl?: string;
  durationSeconds?: number;
  canRetry?: boolean;
  raw: unknown;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

/**
 * Direct client for the Hailuo web API — the same calls the create page makes,
 * signed the same way. No browser involved.
 */
export class HailuoClient {
  constructor(
    private readonly origin: string,
    private readonly token: string
  ) {}

  async getCredits(): Promise<CreditBalance> {
    return parseCreditBalance({ data: await this.request(CREDIT_API_PATH) });
  }

  /** Fresh OSS STS credentials. They expire in ~1h, so fetch one per upload. */
  async requestUploadPolicy(): Promise<OssPolicy> {
    return this.request<OssPolicy>('/v1/api/files/request_policy');
  }

  /**
   * Upload an image and register it: OSS PUT under the policy's dir, then
   * `policy_callback` to turn the object into a fileID the generator accepts.
   */
  async uploadImage(input: {
    buffer: Buffer;
    fileName: string;
    mimeType: string;
    frameType?: number;
    fileScene?: number;
  }): Promise<UploadedFile> {
    const extension = IMAGE_EXTENSIONS[input.mimeType]
      ?? path.extname(input.fileName).replace('.', '').toLowerCase()
      ?? 'png';

    const policy = await this.requestUploadPolicy();
    const uuid = randomUUID();
    const objectName = `${uuid}.${extension}`;

    await putObject({
      policy,
      key: `${policy.dir}/${objectName}`,
      body: input.buffer,
      contentType: input.mimeType
    });

    const registered = await this.request<{ fileID: string; ossPath: string; coverUrl?: string }>(
      '/v1/api/files/policy_callback',
      {
        method: 'POST',
        body: {
          fileName: objectName,
          originFileName: input.fileName,
          dir: policy.dir,
          endpoint: policy.endpoint,
          bucketName: policy.bucketName,
          size: String(input.buffer.byteLength),
          mimeType: extension,
          fileScene: input.fileScene ?? 0,
          assetFileType: AssetFileType.Image
        }
      }
    );

    return {
      id: registered.fileID,
      name: input.fileName,
      type: extension,
      url: registered.ossPath,
      coverUrl: registered.coverUrl ?? registered.ossPath,
      characterID: '',
      frameType: input.frameType ?? DEFAULT_FRAME_TYPE,
      referenceType: 0,
      characterUrl: '',
      duration: 0,
      assetFileType: AssetFileType.Image,
      videoID: '',
      durationMs: 0
    };
  }

  async generateVideo(input: GenerateVideoInput): Promise<GenerateVideoResult> {
    const submitted = await this.request<{
      id: string;
      isFirstGenerate?: boolean;
      task?: { batchID?: string; videoIDs?: string[] };
    }>('/v2/api/multimodal/generate/video', {
      method: 'POST',
      body: {
        quantity: input.quantity ?? 1,
        parameter: {
          modelID: input.modelID,
          desc: input.text,
          fileList: input.fileList,
          useOriginPrompt: input.useOriginPrompt ?? true,
          resolution: input.resolution,
          duration: input.duration,
          aspectRatio: input.aspectRatio,
          referenceMode: input.referenceMode ?? DEFAULT_REFERENCE_MODE
        },
        projectID: input.projectID ?? '0'
      }
    });

    return {
      id: submitted.id,
      batchID: submitted.task?.batchID ?? '',
      videoIDs: submitted.task?.videoIDs ?? [submitted.id],
      isFirstGenerate: submitted.isFirstGenerate
    };
  }

  /**
   * Current state of one creation.
   *
   * `/api/feed/detail` only exists for published feeds (it 2400016s for your own
   * in-flight work), so this uses the two endpoints the create page polls:
   * `my/processing` while it renders, then `my/batch` for the terminal state.
   */
  async getCreation(id: string, projectID = '0'): Promise<VideoResult> {
    const processing = await this.request<ProcessingResponse>('/api/feed/creation/my/processing', {
      method: 'POST',
      body: {}
    });
    const live = findFeed(processing.batchFeeds, id);
    if (live) return normalizeFeed(id, live);

    const batch = await this.request<ProcessingResponse>('/api/feed/creation/my/batch', {
      method: 'POST',
      body: { cursor: '', limit: 30, type: 'next', scene: 'create', projectID }
    });
    const settled = findFeed(batch.batchFeeds, id);
    if (!settled) throw new HailuoCreationNotFoundError(id);
    return normalizeFeed(id, settled);
  }

  /**
   * Poll until the video renders, fails, or `timeoutMs` runs out.
   *
   * A poll that fails (cannot reach Hailuo, does not find the creation yet, any
   * other error) is not a verdict on the render, which keeps going upstream.
   * Such polls are retried on `retryDelaysMs` (default 10s/30s/60s); only when
   * every retry in a row fails does the wait give up, with a `HailuoJobError`
   * that counts the tries. A successful poll resets the count.
   */
  async waitForVideo(id: string, options: {
    timeoutMs: number;
    /** The API suggests 10s via `cycleTime`. */
    intervalMs?: number;
    /** Back-off between consecutive failed polls; the length is the retry count. */
    retryDelaysMs?: readonly number[];
    projectID?: string;
    signal?: AbortSignal;
    onPoll?: (result: VideoResult) => void;
    onPollRetry?: (info: RetryAttemptInfo) => void;
  }): Promise<VideoResult> {
    const interval = options.intervalMs ?? 10_000;
    const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const deadline = Date.now() + options.timeoutMs;
    let consecutiveFailures = 0;

    for (;;) {
      let result: VideoResult;
      try {
        result = await this.getCreation(id, options.projectID);
        consecutiveFailures = 0;
      } catch (error) {
        if (options.signal?.aborted) throw error;
        const failure = classifyHailuoError(error);
        if (!failure.retryable || consecutiveFailures >= retryDelays.length) {
          throw new HailuoJobError(failure, consecutiveFailures + 1, 'poll', { cause: error });
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
      options.onPoll?.(result);

      if (result.status === 'succeeded' && result.videoUrl) return result;
      if (result.status === 'failed') {
        throw new HailuoGenerationError(id, result);
      }
      if (Date.now() + interval > deadline) {
        throw new HailuoRenderTimeoutError(id, options.timeoutMs);
      }
      await sleep(interval, options.signal);
    }
  }

  private request<T>(apiPath: string, options: Parameters<typeof hailuoRequest>[3] = {}): Promise<T> {
    return hailuoRequest<T>(this.origin, this.token, apiPath, options);
  }
}

/** Hailuo accepted the job but the render itself failed — carries its own message. */
export class HailuoGenerationError extends HailuoRenderFailedError {
  constructor(id: string, readonly result: VideoResult) {
    super(
      id,
      `${result.message ?? 'unknown reason'}${result.messageDetail ? ` (${result.messageDetail})` : ''}`,
      result.canRetry
    );
  }
}

interface Feed {
  commonInfo?: { id?: string; batchID?: string; status?: number; percent?: number };
  permissionInfo?: { canRetry?: boolean };
  feedMessage?: { message?: string; messageDetail?: string };
  feedCoverInfo?: { coverURL?: string };
  metaInfo?: {
    videoMetaInfo?: {
      duration?: number;
      mediaInfo?: { url?: string; downloadURL?: VideoResult['downloadUrls'] };
    };
  };
}

interface ProcessingResponse {
  processing?: boolean;
  cycleTime?: number;
  batchFeeds?: Array<{ batchID?: string; feeds?: Feed[] }>;
}

function findFeed(batches: ProcessingResponse['batchFeeds'], id: string): Feed | undefined {
  return batches
    ?.flatMap((batch) => batch.feeds ?? [])
    .find((feed) => feed.commonInfo?.id === id);
}

function statusLabel(status: number | undefined): VideoStatus {
  if (status === 2) return 'succeeded';
  if (status === 3) return 'failed';
  return 'processing';
}

function normalizeFeed(id: string, feed: Feed): VideoResult {
  const media = feed.metaInfo?.videoMetaInfo?.mediaInfo;
  const download = media?.downloadURL;
  return {
    id: feed.commonInfo?.id ?? id,
    batchID: feed.commonInfo?.batchID,
    status: statusLabel(feed.commonInfo?.status),
    percent: feed.commonInfo?.percent,
    message: feed.feedMessage?.message,
    messageDetail: feed.feedMessage?.messageDetail,
    videoUrl: media?.url || download?.withoutWatermarkURL || download?.watermarkURL || undefined,
    downloadUrls: download,
    coverUrl: feed.feedCoverInfo?.coverURL || undefined,
    durationSeconds: feed.metaInfo?.videoMetaInfo?.duration,
    canRetry: feed.permissionInfo?.canRetry,
    raw: feed
  };
}
