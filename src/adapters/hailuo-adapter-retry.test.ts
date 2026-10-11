import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobProgressUpdate } from '../types.js';
import { HailuoAdapter, hailuoJobBudgetMs } from './hailuo-adapter.js';
import { HailuoApiError } from './hailuo-api.js';
import { HailuoClient, type UploadedFile, type VideoResult } from './hailuo-client.js';
import { HailuoJobError } from './hailuo-retry.js';

const cookies = [{ name: '_token', value: 'token-1', domain: '.hailuoai.com', path: '/' }];
const GENERATE = '/v2/api/multimodal/generate/video';

function adapter(retryDelaysMs: number[] = [0, 0, 0]) {
  return new HailuoAdapter('https://hailuoai.com/create/image-to-video', {
    video: { modelId: 'hailuo3.0-i2v', resolution: '768', duration: 5, aspectRatio: '16:9', referenceMode: 'all-reference', frameType: 4 },
    pollTimeoutMs: 5_000,
    pollIntervalMs: 1,
    retryDelaysMs
  });
}

function uploaded(id: string): UploadedFile {
  return {
    id, name: `${id}.png`, type: 'png', url: `https://cdn/${id}.png`, coverUrl: '', characterID: '',
    frameType: 4, referenceType: 0, characterUrl: '', duration: 0, assetFileType: 1, videoID: '', durationMs: 0
  };
}

function feed(id: string, status: VideoResult['status'], extra: Partial<VideoResult> = {}): VideoResult {
  return { id, status, raw: {}, ...extra };
}

let imagePath: string;
beforeAll(async () => {
  imagePath = path.join(await mkdtemp(path.join(tmpdir(), 'hailuo-adapter-')), 'ref.png');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
afterEach(() => vi.restoreAllMocks());

describe('HailuoAdapter retries', () => {
  it('resubmits a failed render with the uploaded files and reports each retry in progress', async () => {
    vi.spyOn(HailuoClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 100, breakdown: [] });
    vi.spyOn(HailuoClient.prototype, 'uploadImage').mockResolvedValue(uploaded('file-1'));
    const generateVideo = vi.spyOn(HailuoClient.prototype, 'generateVideo')
      .mockResolvedValueOnce({ id: 'v1', batchID: 'b1', videoIDs: ['v1'] })
      .mockResolvedValueOnce({ id: 'v2', batchID: 'b2', videoIDs: ['v2'] });
    vi.spyOn(HailuoClient.prototype, 'getCreation').mockImplementation(async (id) =>
      id === 'v1'
        ? feed('v1', 'failed', { message: '内容生成失败。请重试。', messageDetail: '生成过程中出现错误，请重试', canRetry: true })
        : feed('v2', 'succeeded', { videoUrl: 'https://cdn/v2.mp4', durationSeconds: 5 }));
    const progress: JobProgressUpdate[] = [];

    const result = await adapter().runWithoutBrowser!(cookies, {
      text: 'walk', imagePath, mimeType: 'image/png', originalName: 'ref.png',
      onProgress: (update) => progress.push(update)
    });

    expect(result).toMatchObject({ status: 'succeeded', videoId: 'v2', batchId: 'b2', videoUrl: 'https://cdn/v2.mp4', renderAttempts: 2 });
    expect(generateVideo).toHaveBeenCalledTimes(2);
    // The second submission reuses the registered file, no new upload.
    expect(generateVideo.mock.calls[1]?.[0].fileList).toEqual([uploaded('file-1')]);
    expect(HailuoClient.prototype.uploadImage).toHaveBeenCalledOnce();

    const retry = progress.find((update) => update.retry?.step === 'render');
    expect(retry?.retry).toMatchObject({ attempt: 1, maxAttempts: 4, code: 'PROVIDER_RENDER_FAILED', reason: expect.stringContaining('内容生成失败') });
    expect(retry?.message).toContain('海螺生成失败');
    const resubmitted = progress.find((update) => update.providerJobId === 'v2');
    expect(resubmitted).toMatchObject({ batchId: 'b2', renderAttempts: 2, uploadedFiles: [uploaded('file-1')] });
    expect(resubmitted?.retry).toBeUndefined();
  });

  it('gives up after three resubmissions with PROVIDER_RENDER_FAILED and the attempt count', async () => {
    vi.spyOn(HailuoClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 100, breakdown: [] });
    vi.spyOn(HailuoClient.prototype, 'uploadImage').mockResolvedValue(uploaded('file-1'));
    let submissions = 0;
    const generateVideo = vi.spyOn(HailuoClient.prototype, 'generateVideo').mockImplementation(async () => {
      submissions += 1;
      return { id: `v${submissions}`, batchID: `b${submissions}`, videoIDs: [`v${submissions}`] };
    });
    vi.spyOn(HailuoClient.prototype, 'getCreation').mockImplementation(async (id) =>
      feed(id, 'failed', { message: '内容生成失败。请重试。' }));

    const error = await adapter().runWithoutBrowser!(cookies, { text: 'walk', imagePath })!.catch((e: unknown) => e);

    expect(generateVideo).toHaveBeenCalledTimes(4);
    expect(error).toBeInstanceOf(HailuoJobError);
    expect(error).toMatchObject({
      code: 'PROVIDER_RENDER_FAILED', retryable: true, attempts: 4, step: 'render',
      providerMessage: '内容生成失败。请重试。'
    });
  });

  it('retries a content rejection three times and reports CONTENT_REJECTED with the attempt count', async () => {
    vi.spyOn(HailuoClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 100, breakdown: [] });
    vi.spyOn(HailuoClient.prototype, 'uploadImage').mockResolvedValue(uploaded('file-1'));
    const generateVideo = vi.spyOn(HailuoClient.prototype, 'generateVideo')
      .mockRejectedValue(new HailuoApiError(2400002, '文案违反社区规范，请更换文案后重试', GENERATE));
    const progress: JobProgressUpdate[] = [];

    const error = await adapter().runWithoutBrowser!(cookies, {
      text: 'walk', imagePath, onProgress: (update) => progress.push(update)
    })!.catch((e: unknown) => e);

    expect(generateVideo).toHaveBeenCalledTimes(4);
    // The same text is resubmitted; no second upload.
    expect(HailuoClient.prototype.uploadImage).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ code: 'CONTENT_REJECTED', retryable: true, attempts: 4, step: 'submit', providerCode: 2400002 });
    expect(progress.filter((update) => update.retry?.code === 'CONTENT_REJECTED')).toHaveLength(3);
  });

  it('keeps CONTENT_REJECTED when a resubmission after a failed render is rejected for its content', async () => {
    vi.spyOn(HailuoClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 100, breakdown: [] });
    vi.spyOn(HailuoClient.prototype, 'uploadImage').mockResolvedValue(uploaded('file-1'));
    const generateVideo = vi.spyOn(HailuoClient.prototype, 'generateVideo')
      .mockResolvedValueOnce({ id: 'v1', batchID: 'b1', videoIDs: ['v1'] })
      .mockRejectedValue(new HailuoApiError(2400002, '文案违反社区规范，请更换文案后重试', GENERATE));
    vi.spyOn(HailuoClient.prototype, 'getCreation').mockImplementation(async (id) =>
      feed(id, 'failed', { message: '内容生成失败。请重试。' }));

    const error = await adapter().runWithoutBrowser!(cookies, { text: 'walk', imagePath })!.catch((e: unknown) => e);

    // One accepted submission, then the resubmission tried four times.
    expect(generateVideo).toHaveBeenCalledTimes(5);
    expect(error).toMatchObject({ code: 'CONTENT_REJECTED', retryable: true, attempts: 4, providerCode: 2400002 });
  });

  it('keeps polling a timed-out render under the same id instead of paying for a new one', async () => {
    vi.spyOn(HailuoClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 100, breakdown: [] });
    vi.spyOn(HailuoClient.prototype, 'uploadImage').mockResolvedValue(uploaded('file-1'));
    const generateVideo = vi.spyOn(HailuoClient.prototype, 'generateVideo')
      .mockResolvedValue({ id: 'v1', batchID: 'b1', videoIDs: ['v1'] });
    vi.spyOn(HailuoClient.prototype, 'getCreation')
      .mockResolvedValueOnce(feed('v1', 'processing', { percent: 50 }))
      .mockResolvedValueOnce(feed('v1', 'processing', { percent: 90 }))
      .mockResolvedValue(feed('v1', 'succeeded', { videoUrl: 'https://cdn/v1.mp4' }));
    const progress: JobProgressUpdate[] = [];
    // A poll budget of 1ms times out after every single poll.
    const subject = new HailuoAdapter('https://hailuoai.com/create/image-to-video', {
      video: { modelId: 'hailuo3.0-i2v', resolution: '768', duration: 5, aspectRatio: '16:9', referenceMode: 'all-reference', frameType: 4 },
      pollTimeoutMs: 1,
      pollIntervalMs: 1,
      retryDelaysMs: [0, 0, 0]
    });

    const result = await subject.runWithoutBrowser!(cookies, {
      text: 'walk', imagePath, onProgress: (update) => progress.push(update)
    });

    expect(result).toMatchObject({ status: 'succeeded', videoId: 'v1', renderAttempts: 1 });
    expect(generateVideo).toHaveBeenCalledOnce();
    // Millisecond timing decides whether the second poll also times out; at least the first did.
    expect(progress.filter((update) => update.retry?.code === 'RENDER_TIMEOUT').length).toBeGreaterThanOrEqual(1);
  });

  it('retries transient upload and submit failures, then succeeds', async () => {
    vi.spyOn(HailuoClient.prototype, 'getCredits')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValue({ totalCredits: 100, breakdown: [] });
    vi.spyOn(HailuoClient.prototype, 'uploadImage')
      .mockRejectedValueOnce(new Error('OSS PUT dir/x.png failed: HTTP 503 '))
      .mockResolvedValue(uploaded('file-1'));
    vi.spyOn(HailuoClient.prototype, 'generateVideo')
      .mockRejectedValueOnce(new HailuoApiError(2400003, '当前资源较忙，请重试', GENERATE))
      .mockResolvedValue({ id: 'v1', batchID: 'b1', videoIDs: ['v1'] });
    vi.spyOn(HailuoClient.prototype, 'getCreation')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(feed('v1', 'processing', { percent: 40 }))
      .mockResolvedValue(feed('v1', 'succeeded', { videoUrl: 'https://cdn/v1.mp4' }));
    const progress: JobProgressUpdate[] = [];

    const result = await adapter().runWithoutBrowser!(cookies, {
      text: 'walk', imagePath, onProgress: (update) => progress.push(update)
    });

    expect(result).toMatchObject({ status: 'succeeded', videoId: 'v1', renderAttempts: 1 });
    expect(progress.map((update) => update.retry?.step).filter(Boolean)).toEqual(['credits', 'upload', 'submit', 'poll']);
    expect(progress.find((update) => update.retry?.step === 'submit')?.retry).toMatchObject({ code: 'PROVIDER_BUSY' });
    // A successful poll clears the pending retry marker.
    expect(progress.at(-1)).toMatchObject({ percent: undefined, retry: undefined });
  });

  it('keeps the credit rejection recognisable so the runner can switch accounts', async () => {
    vi.spyOn(HailuoClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 100, breakdown: [] });
    vi.spyOn(HailuoClient.prototype, 'uploadImage').mockResolvedValue(uploaded('file-1'));
    vi.spyOn(HailuoClient.prototype, 'generateVideo').mockRejectedValue(new HailuoApiError(1001, '贝壳不足', GENERATE));
    const subject = adapter();

    const error = await subject.runWithoutBrowser!(cookies, { text: 'walk', imagePath })!.catch((e: unknown) => e);

    expect(subject.isInsufficientCreditsError(error)).toBe(true);
  });

  it('can resubmit after a restart when the progress kept the uploaded files', async () => {
    vi.spyOn(HailuoClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 90, breakdown: [] });
    const generateVideo = vi.spyOn(HailuoClient.prototype, 'generateVideo')
      .mockResolvedValue({ id: 'v2', batchID: 'b2', videoIDs: ['v2'] });
    vi.spyOn(HailuoClient.prototype, 'getCreation').mockImplementation(async (id) =>
      id === 'v1'
        ? feed('v1', 'failed', { message: '内容生成失败。请重试。' })
        : feed('v2', 'succeeded', { videoUrl: 'https://cdn/v2.mp4' }));

    const result = await adapter().resumeWithoutBrowser!(cookies, {
      providerJobId: 'v1', batchId: 'b1', uploadedFiles: [uploaded('file-1')], creditsBefore: 100,
      renderAttempts: 1, updatedAt: '2026-09-17T00:00:00.000Z'
    }, { text: 'walk', options: { durationSeconds: 6 } });

    expect(result).toMatchObject({ videoId: 'v2', resumed: true, renderAttempts: 2 });
    expect(generateVideo.mock.calls[0]?.[0]).toMatchObject({ text: 'walk', duration: 6, fileList: [uploaded('file-1')] });
  });

  it('sizes the runner budget to cover every render attempt', () => {
    expect(hailuoJobBudgetMs({ pollTimeoutMs: 900_000, retryDelaysMs: [10_000, 30_000, 60_000] }))
      .toBe(900_000 * 4 + 100_000 * 4 + 60_000);
    expect(hailuoJobBudgetMs({ pollTimeoutMs: 900_000, retryDelaysMs: [] })).toBe(960_000);
  });
});
