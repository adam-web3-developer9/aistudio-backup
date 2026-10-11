import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobProgressUpdate } from '../types.js';
import { DreamMakerAdapter, dreamMakerJobBudgetMs } from './dreammaker-adapter.js';
import { DreamMakerClient, type DreamMakerTask, type UploadedFile } from './dreammaker-client.js';
import { DreamMakerApiError } from './dreammaker-api.js';
import { DreamMakerRenderTimeoutError, DreamMakerTaskFailedError } from './dreammaker-retry.js';
import { ProviderJobError } from './provider-retry.js';

const ORIGIN = 'https://dreammaker.vobile.com.cn';
const cookies = [{ name: 'access_token', value: 'token-1', domain: 'dreammaker.vobile.com.cn', path: '/' }];

function adapter(retryDelaysMs: number[] = [0, 0, 0]) {
  return new DreamMakerAdapter(ORIGIN, {
    video: {
      model: 'minimax-h3',
      mode: 'image2video',
      resolution: '768p',
      durationSeconds: 5,
      aspectRatio: 'adaptive'
    },
    pollTimeoutMs: 5_000,
    pollIntervalMs: 1,
    retryDelaysMs
  });
}

function uploaded(id: string): UploadedFile {
  return {
    uploadId: id,
    ossUri: `oss://bucket/${id}.png`,
    url: `https://cdn/${id}.png`,
    fileName: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 4
  };
}

function task(taskId: string, overrides: Partial<DreamMakerTask> = {}): DreamMakerTask {
  return {
    taskId,
    status: 'succeeded',
    artifacts: [{
      artifactId: `art_${taskId}`,
      mediaType: 'video',
      status: 'ready',
      url: `https://cdn/${taskId}.mp4`,
      ossUri: `oss://bucket/${taskId}.mp4`,
      thumbnailUrl: `https://cdn/${taskId}.jpg`,
      width: 768,
      height: 1344,
      sizeBytes: 726_062
    }],
    creditCost: 2_500,
    balanceAfter: 43_184,
    raw: {},
    ...overrides
  };
}

let imagePath: string;
beforeAll(async () => {
  imagePath = path.join(await mkdtemp(path.join(tmpdir(), 'dreammaker-adapter-')), 'ref.png');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
afterEach(() => vi.restoreAllMocks());

function mockHappyPath() {
  vi.spyOn(DreamMakerClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 45_684, breakdown: [] });
  vi.spyOn(DreamMakerClient.prototype, 'uploadImage')
    .mockImplementation(async (input) => uploaded(input.fileName.replace('.png', '')));
  return {
    generateVideo: vi.spyOn(DreamMakerClient.prototype, 'generateVideo').mockResolvedValue(task('cgt_1', { status: 'queued' })),
    waitForTask: vi.spyOn(DreamMakerClient.prototype, 'waitForTask').mockResolvedValue(task('cgt_1'))
  };
}

describe('DreamMakerAdapter', () => {
  it('uploads, submits image2video and reports the finished video with what it cost', async () => {
    const { generateVideo } = mockHappyPath();
    const progress: JobProgressUpdate[] = [];

    const result = await adapter().runWithoutBrowser!(cookies, {
      text: '镜头缓慢推进',
      imagePath,
      mimeType: 'image/png',
      originalName: 'ref.png',
      onProgress: (update) => progress.push(update)
    });

    expect(result).toMatchObject({
      status: 'succeeded',
      taskId: 'cgt_1',
      videoUrl: 'https://cdn/cgt_1.mp4',
      coverUrl: 'https://cdn/cgt_1.jpg',
      width: 768,
      height: 1344,
      creditsBefore: 45_684,
      creditsAfter: 43_184,
      // The platform reports the charge itself, so it is not inferred from balances.
      creditsSpent: 2_500,
      renderAttempts: 1
    });
    expect(generateVideo.mock.calls[0]?.[0]).toMatchObject({
      model: 'minimax-h3',
      mode: 'image2video',
      prompt: '镜头缓慢推进',
      imageUrls: ['https://cdn/ref.png'],
      options: { duration: 5, durationSeconds: 5, resolution: '768p', ratio: 'adaptive' }
    });
    // The task id is persisted before the wait, so a restart can resume it.
    expect(progress[0]).toMatchObject({ providerJobId: 'cgt_1', renderAttempts: 1 });
  });

  it('reports the stage, because the platform leaves progress at 0 until the end', async () => {
    mockHappyPath();
    // What the platform really answers over a 3 minute render.
    const polls = [
      task('cgt_1', { status: 'queued', stage: 'queued', progress: 0 }),
      task('cgt_1', { status: 'running', stage: 'generating', progress: 0 }),
      task('cgt_1', { status: 'running', stage: 'archiving', progress: 0 }),
      task('cgt_1', { status: 'succeeded', stage: 'succeeded', progress: 100 })
    ];
    vi.spyOn(DreamMakerClient.prototype, 'waitForTask').mockImplementation(async (_id, options) => {
      for (const poll of polls) options.onPoll?.(poll);
      return polls[polls.length - 1]!;
    });
    const progress: JobProgressUpdate[] = [];

    await adapter().runWithoutBrowser!(cookies, {
      text: 'x',
      imagePath,
      originalName: 'ref.png',
      onProgress: (update) => progress.push(update)
    });

    expect(progress.filter((update) => update.message).map((update) => update.message))
      .toEqual(['平台排队中', '生成中', '转存成片中', '已完成']);
    expect(progress.at(-1)?.percent).toBe(100);
  });

  it('treats several images as a reference set unless the caller picks a mode', async () => {
    const { generateVideo } = mockHappyPath();

    await adapter().runWithoutBrowser!(cookies, {
      text: 'x',
      imagePath,
      originalName: 'a.png',
      referenceImages: [{ imagePath, originalName: 'b.png' }]
    });
    expect(generateVideo.mock.calls[0]?.[0]).toMatchObject({
      mode: 'allReference',
      imageUrls: ['https://cdn/a.png', 'https://cdn/b.png']
    });

    generateVideo.mockClear();
    await adapter().runWithoutBrowser!(cookies, {
      text: 'x',
      imagePath,
      originalName: 'a.png',
      referenceImages: [{ imagePath, originalName: 'b.png' }],
      options: { mode: 'firstLastFrame' }
    });
    expect(generateVideo.mock.calls[0]?.[0]).toMatchObject({ mode: 'firstLastFrame' });
  });

  it('passes per-job overrides through to the platform', async () => {
    const { generateVideo } = mockHappyPath();

    await adapter().runWithoutBrowser!(cookies, {
      text: 'x',
      imagePath,
      originalName: 'ref.png',
      options: {
        modelId: 'doubao-seedance-2-5-260628',
        resolution: '1080p',
        durationSeconds: 10,
        aspectRatio: '16:9'
      }
    });

    expect(generateVideo.mock.calls[0]?.[0]).toMatchObject({
      model: 'doubao-seedance-2-5-260628',
      options: { duration: 10, durationSeconds: 10, resolution: '1080p', ratio: '16:9' }
    });
  });

  it('resubmits a failed task with the images already uploaded', async () => {
    mockHappyPath();
    const generateVideo = vi.spyOn(DreamMakerClient.prototype, 'generateVideo')
      .mockResolvedValueOnce(task('cgt_1', { status: 'queued' }))
      .mockResolvedValueOnce(task('cgt_2', { status: 'queued' }));
    vi.spyOn(DreamMakerClient.prototype, 'waitForTask')
      .mockRejectedValueOnce(new DreamMakerTaskFailedError('cgt_1', 'PROVIDER_SUBMIT_FAILED', '生成任务提交失败，请稍后重试。', 'retry'))
      .mockResolvedValueOnce(task('cgt_2'));
    const progress: JobProgressUpdate[] = [];

    const result = await adapter().runWithoutBrowser!(cookies, {
      text: 'x',
      imagePath,
      originalName: 'ref.png',
      onProgress: (update) => progress.push(update)
    });

    expect(result).toMatchObject({ taskId: 'cgt_2', renderAttempts: 2 });
    expect(generateVideo).toHaveBeenCalledTimes(2);
    expect(DreamMakerClient.prototype.uploadImage).toHaveBeenCalledOnce();
    const retry = progress.find((update) => update.retry?.step === 'render');
    expect(retry?.retry).toMatchObject({ code: 'PROVIDER_RENDER_FAILED', attempt: 1, maxAttempts: 4 });
    expect(progress.find((update) => update.providerJobId === 'cgt_2')).toMatchObject({ renderAttempts: 2 });
  });

  it('keeps polling the same task after a timeout instead of paying for a second one', async () => {
    mockHappyPath();
    const generateVideo = vi.spyOn(DreamMakerClient.prototype, 'generateVideo')
      .mockResolvedValue(task('cgt_1', { status: 'queued' }));
    vi.spyOn(DreamMakerClient.prototype, 'waitForTask')
      .mockRejectedValueOnce(new DreamMakerRenderTimeoutError('cgt_1', 5_000))
      .mockResolvedValueOnce(task('cgt_1'));

    const result = await adapter().runWithoutBrowser!(cookies, { text: 'x', imagePath, originalName: 'ref.png' });

    expect(result).toMatchObject({ taskId: 'cgt_1', renderAttempts: 1 });
    expect(generateVideo).toHaveBeenCalledOnce();
  });

  it('gives up on an account that cannot pay, without retrying', async () => {
    mockHappyPath();
    const rejection = new DreamMakerApiError(402, 'INSUFFICIENT_CREDIT', '积分余额不足', '/api/video/generate');
    const generateVideo = vi.spyOn(DreamMakerClient.prototype, 'generateVideo').mockRejectedValue(rejection);

    const failure = await adapter().runWithoutBrowser!(cookies, { text: 'x', imagePath, originalName: 'ref.png' })!
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderJobError);
    expect(failure).toMatchObject({ code: 'INSUFFICIENT_CREDITS', retryable: false });
    expect(generateVideo).toHaveBeenCalledOnce();
    expect(adapter().isInsufficientCreditsError(failure)).toBe(true);
  });

  it('reports a rejected prompt as CONTENT_REJECTED once every try is spent', async () => {
    mockHappyPath();
    vi.spyOn(DreamMakerClient.prototype, 'generateVideo').mockResolvedValue(task('cgt_1', { status: 'queued' }));
    vi.spyOn(DreamMakerClient.prototype, 'waitForTask').mockRejectedValue(
      new DreamMakerTaskFailedError('cgt_1', 'CONTENT_REJECTED', '描述不合规', 'edit_prompt')
    );

    const failure = await adapter().runWithoutBrowser!(cookies, { text: 'x', imagePath, originalName: 'ref.png' })!
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'CONTENT_REJECTED', attempts: 4 });
  });

  it('resumes a submitted task without uploading again', async () => {
    vi.spyOn(DreamMakerClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 45_684, breakdown: [] });
    const uploadImage = vi.spyOn(DreamMakerClient.prototype, 'uploadImage');
    vi.spyOn(DreamMakerClient.prototype, 'waitForTask').mockResolvedValue(task('cgt_1'));

    const result = await adapter().resumeWithoutBrowser!(
      cookies,
      {
        providerJobId: 'cgt_1',
        uploadedFiles: [uploaded('ref')],
        creditsBefore: 45_684,
        renderAttempts: 1,
        updatedAt: new Date().toISOString()
      },
      { text: 'x' }
    )!;

    expect(result).toMatchObject({ taskId: 'cgt_1', resumed: true, creditsSpent: 2_500 });
    expect(uploadImage).not.toHaveBeenCalled();
  });

  it('cannot run without an access token in the session', () => {
    expect(adapter().runWithoutBrowser!([], { text: 'x', imagePath })).toBeUndefined();
    expect(adapter().resumeWithoutBrowser!(cookies, { updatedAt: '' }, { text: 'x' })).toBeUndefined();
  });

  it('prices per second at the quoted price for that model and resolution', async () => {
    // The platform charges by tier: Seedance 2.5 is 672/s at 480p and 3750/s at 1080p.
    const getQuote = vi.spyOn(DreamMakerClient.prototype, 'getQuote').mockImplementation(async ({ model, options }) => {
      const tiers: Record<string, number> = { '480p': 672, '720p': 1512, '1080p': 3750, '768p': 500 };
      const listAmount = model === 'minimax-h3' ? 500 : tiers[String(options?.resolution)] ?? 1000;
      return { listAmount, payableAmount: listAmount };
    });
    const dreamMaker = adapter();
    const balance = { totalCredits: 45_684, breakdown: [] };

    expect(await dreamMaker.estimateJobCost(balance, { durationSeconds: 5 }, cookies)).toBe(2_500);
    expect(await dreamMaker.estimateJobCost(balance, {
      modelId: 'doubao-seedance-2-5-260628',
      resolution: '480p',
      durationSeconds: 27
    }, cookies)).toBe(18_144);
    expect(await dreamMaker.estimateJobCost(balance, {
      modelId: 'doubao-seedance-2-5-260628',
      resolution: '1080p',
      durationSeconds: 27
    }, cookies)).toBe(101_250);

    // One quote per model+resolution, then cached.
    const calls = getQuote.mock.calls.length;
    await dreamMaker.estimateJobCost(balance, { durationSeconds: 9 }, cookies);
    expect(getQuote).toHaveBeenCalledTimes(calls);
  });

  it('falls back to the coarse price table when the quote cannot be had', async () => {
    vi.spyOn(DreamMakerClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 45_684, breakdown: [] });
    vi.spyOn(DreamMakerClient.prototype, 'getPricing').mockResolvedValue({
      video: { unit: 'per_second', models: { 'minimax-h3': 500 } }
    });
    vi.spyOn(DreamMakerClient.prototype, 'getQuote').mockRejectedValue(new Error('fetch failed'));
    const dreamMaker = adapter();
    const balance = { totalCredits: 1, breakdown: [] };

    // No table read yet and no quote: no estimate rather than a guess.
    expect(await dreamMaker.estimateJobCost(balance, { durationSeconds: 5 }, cookies)).toBeUndefined();

    await dreamMaker.getCreditsFromCookies(cookies);
    expect(await dreamMaker.estimateJobCost(balance, { durationSeconds: 5 }, cookies)).toBe(2_500);
  });

  it('identifies the account behind a session without exposing the token', () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: '21574', exp: 1_790_512_134 })).toString('base64url');
    const identity = adapter().describeSession([{ ...cookies[0]!, value: `${header}.${payload}.sig` }]);

    expect(identity?.account?.userId).toBe('21574');
    expect(identity?.tokenMasked).toContain('…');
    expect(identity?.tokenMasked).not.toContain(payload);
  });
});

describe('dreamMakerJobBudgetMs', () => {
  it('covers every render attempt plus the waits between them', () => {
    expect(dreamMakerJobBudgetMs({ pollTimeoutMs: 60_000, retryDelaysMs: [] })).toBe(120_000);
    expect(dreamMakerJobBudgetMs({ pollTimeoutMs: 60_000, retryDelaysMs: [1_000, 2_000] }))
      .toBe(60_000 * 3 + 3_000 * 4 + 60_000);
  });
});
