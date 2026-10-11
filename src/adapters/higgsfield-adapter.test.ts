import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JobProgressUpdate } from '../types.js';
import { HiggsfieldAdapter, higgsfieldJobBudgetMs } from './higgsfield-adapter.js';
import { HiggsfieldMcpClient } from './higgsfield-mcp-client.js';
import { HiggsfieldMcpError, higgsfieldMcpCookies } from './higgsfield-mcp.js';
import type { HiggsfieldJobSet, UploadedMedia } from './higgsfield-client.js';
import { HiggsfieldJobFailedError, HiggsfieldRenderTimeoutError } from './higgsfield-retry.js';
import { ProviderJobError } from './provider-retry.js';

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  return `${header}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.sig`;
}

// The access token is opaque in practice; identity comes from the id token.
const idToken = jwt({ sub: 'user_aaa', email: 'a@example.com' });
const cookies = higgsfieldMcpCookies(
  { clientId: 'client_aaa', refreshToken: 'rt_a', accessToken: 'opaque-access', idToken },
  'https://higgsfield.ai'
);

function adapter(retryDelaysMs: number[] = [0, 0, 0]) {
  return new HiggsfieldAdapter({
    video: {
      model: 'seedance_2_5',
      resolution: '720p',
      durationSeconds: 5,
      aspectRatio: '16:9'
    },
    pollTimeoutMs: 5_000,
    pollIntervalMs: 1,
    retryDelaysMs
  });
}

function media(id: string, kind: UploadedMedia['kind'] = 'image'): UploadedMedia {
  return { id, url: `https://cdn/${id}.png`, kind, mimeType: 'image/png', fileName: `${id}.png`, sizeBytes: 4 };
}

function jobSet(id: string, overrides: Partial<HiggsfieldJobSet> = {}): HiggsfieldJobSet {
  return {
    id,
    type: 'seedance_2_5',
    jobs: [{
      id: `job_${id}`,
      status: 'completed',
      raw: { url: `https://cdn/${id}.mp4`, type: 'video' },
      preview: { url: `https://cdn/${id}.jpg`, type: 'image' },
      raw_payload: {}
    }],
    raw: {},
    ...overrides
  };
}

let imagePath: string;
beforeAll(async () => {
  imagePath = path.join(await mkdtemp(path.join(tmpdir(), 'higgsfield-adapter-')), 'ref.png');
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});
afterEach(() => vi.restoreAllMocks());

function mockHappyPath() {
  vi.spyOn(HiggsfieldMcpClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 96, breakdown: [] });
  vi.spyOn(HiggsfieldMcpClient.prototype, 'uploadMedia')
    .mockImplementation(async (input) => media(
      input.fileName.replace(/\.(png|mp4)$/, ''),
      input.mimeType.startsWith('video/') ? 'video' : 'image'
    ));
  return {
    estimateCost: vi.spyOn(HiggsfieldMcpClient.prototype, 'estimateCost').mockResolvedValue(14),
    generateVideo: vi.spyOn(HiggsfieldMcpClient.prototype, 'generateVideo')
      .mockResolvedValue(jobSet('js_1', { jobs: [] })),
    waitForJobSet: vi.spyOn(HiggsfieldMcpClient.prototype, 'waitForJobSet').mockResolvedValue(jobSet('js_1'))
  };
}

describe('HiggsfieldAdapter', () => {
  it('describes the account from the stored OAuth credential', () => {
    expect(adapter().describeSession(cookies)).toEqual({
      tokenMasked: `${'rt_a'.slice(0, 8)}…${'rt_a'.slice(-8)}`,
      account: { userId: 'user_aaa', expiresAt: undefined }
    });
    expect(adapter().describeSession([])).toBeUndefined();
  });

  it('will not run without a credential it can mint tokens from', () => {
    const input = { text: 'hi', imagePath };
    expect(adapter().runWithoutBrowser([], input)).toBeUndefined();
    expect(adapter().resumeWithoutBrowser([], { updatedAt: '' }, { text: 'hi' })).toBeUndefined();
  });

  it('has no browser path at all', async () => {
    await expect(adapter().run({} as never, { text: 'hi', imagePath })).rejects.toThrow(/MCP only/);
  });

  it('uploads, submits and polls, and reports the finished video', async () => {
    const { generateVideo } = mockHappyPath();
    const result = await adapter().runWithoutBrowser(cookies, { text: 'a cat', imagePath }) as Record<string, unknown>;

    expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'seedance_2_5',
      prompt: 'a cat',
      media: [expect.objectContaining({ id: 'ref', kind: 'image' })],
      params: { duration: 5, resolution: '720p', aspect_ratio: '16:9' }
    }), undefined);
    expect(result).toMatchObject({
      status: 'succeeded',
      taskId: 'js_1',
      jobId: 'job_js_1',
      videoUrl: 'https://cdn/js_1.mp4',
      coverUrl: 'https://cdn/js_1.jpg',
      renderAttempts: 1
    });
  });

  it('in video_edit, brings its own seed clip and writes the length into the prompt', async () => {
    const { generateVideo } = mockHappyPath();
    await adapter().runWithoutBrowser(cookies, {
      text: '一只猫在玩泥巴',
      imagePath,
      options: { mode: 'video_edit', durationSeconds: 12 }
    });

    const generation = generateVideo.mock.calls[0]![0];
    // The mode is billed by the reference video's duration, so a job that
    // brought none gets the two-second clip shipped with the service.
    expect(generation.media.map((item) => item.kind)).toEqual(['image', 'video']);
    expect(generation.prompt).toContain('exactly 12.0 seconds');
    expect(generation.prompt).toContain('一只猫在玩泥巴');
  });

  it('does not add a seed clip when the job already carries a video', async () => {
    const { generateVideo } = mockHappyPath();
    vi.mocked(HiggsfieldMcpClient.prototype.uploadMedia)
      .mockImplementation(async (input) => media(input.fileName.replace('.png', ''), 'video'));

    await adapter().runWithoutBrowser(cookies, {
      text: 'hi',
      imagePath,
      options: { mode: 'video_edit' }
    });

    expect(generateVideo.mock.calls[0]![0].media).toHaveLength(1);
  });

  it('leaves the prompt alone outside video_edit', async () => {
    const { generateVideo } = mockHappyPath();
    await adapter().runWithoutBrowser(cookies, {
      text: 'hi',
      imagePath,
      options: { mode: 'omni_reference' }
    });

    expect(generateVideo.mock.calls[0]![0].prompt).toBe('hi');
  });

  it('lets a job override the model, the mode and the knobs', async () => {
    const { generateVideo } = mockHappyPath();
    await adapter().runWithoutBrowser(cookies, {
      text: 'a cat',
      imagePath,
      options: {
        modelId: 'minimax_hailuo',
        mode: 'video_edit',
        resolution: '1080p',
        durationSeconds: 10,
        aspectRatio: '9:16',
        quantity: 2
      }
    });

    expect(generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      model: 'minimax_hailuo',
      mode: 'video_edit',
      params: { duration: 10, resolution: '1080p', aspect_ratio: '9:16', count: 2 }
    }), undefined);
  });

  it('records the job id as soon as it exists, so a restart can resume', async () => {
    mockHappyPath();
    const progress: JobProgressUpdate[] = [];
    await adapter().runWithoutBrowser(cookies, {
      text: 'a cat',
      imagePath,
      onProgress: (update) => progress.push(update)
    });

    expect(progress[0]).toMatchObject({
      providerJobId: 'js_1',
      renderAttempts: 1,
      creditsBefore: 96,
      referenceImages: [{ fileId: 'ref', url: 'https://cdn/ref.png' }]
    });
  });

  it('resubmits a failed render with the media already uploaded', async () => {
    const { generateVideo, waitForJobSet } = mockHappyPath();
    waitForJobSet
      .mockRejectedValueOnce(new HiggsfieldJobFailedError('job_js_1', 'failed', 'upstream died'))
      .mockResolvedValueOnce(jobSet('js_2'));
    generateVideo
      .mockResolvedValueOnce(jobSet('js_1', { jobs: [] }))
      .mockResolvedValueOnce(jobSet('js_2', { jobs: [] }));

    const result = await adapter().runWithoutBrowser(cookies, { text: 'a cat', imagePath }) as Record<string, unknown>;

    expect(generateVideo).toHaveBeenCalledTimes(2);
    // Uploaded once: the second submission reuses the media record.
    expect(HiggsfieldMcpClient.prototype.uploadMedia).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ taskId: 'js_2', renderAttempts: 2 });
  });

  it('keeps polling a render that timed out instead of paying for a second one', async () => {
    const { generateVideo, waitForJobSet } = mockHappyPath();
    waitForJobSet
      .mockRejectedValueOnce(new HiggsfieldRenderTimeoutError('js_1', 10))
      .mockResolvedValueOnce(jobSet('js_1'));

    const result = await adapter().runWithoutBrowser(cookies, { text: 'a cat', imagePath }) as Record<string, unknown>;

    expect(generateVideo).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ taskId: 'js_1', renderAttempts: 1 });
  });

  it('fails a completed job that carries no video', async () => {
    const { waitForJobSet } = mockHappyPath();
    waitForJobSet.mockResolvedValue(jobSet('js_1', {
      jobs: [{ id: 'job_1', status: 'completed', raw_payload: {} }]
    }));

    await expect(adapter([]).runWithoutBrowser(cookies, { text: 'a cat', imagePath }))
      .rejects.toThrow(/without a video result/);
  });

  it('does not retry an account that cannot pay — the runner switches accounts', async () => {
    mockHappyPath();
    const refused = new HiggsfieldMcpError(402, 'Not enough credits', 'generate_video');
    vi.spyOn(HiggsfieldMcpClient.prototype, 'generateVideo').mockRejectedValue(refused);

    const failure = await adapter().runWithoutBrowser(cookies, { text: 'a cat', imagePath })
      ?.catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderJobError);
    expect((failure as ProviderJobError).attempts).toBe(1);
    expect(adapter().isInsufficientCreditsError(failure)).toBe(true);
  });

  it('resumes a job another process submitted', async () => {
    mockHappyPath();
    const result = await adapter().resumeWithoutBrowser(
      cookies,
      { providerJobId: 'js_9', uploadedFiles: [media('ref')], creditsBefore: 96, updatedAt: '' },
      { text: 'a cat' }
    ) as Record<string, unknown>;

    expect(HiggsfieldMcpClient.prototype.uploadMedia).not.toHaveBeenCalled();
    expect(result).toMatchObject({ resumed: true, videoUrl: 'https://cdn/js_1.mp4' });
  });

  it('prices a job by asking the platform, and stays quiet when it cannot', async () => {
    const { estimateCost } = mockHappyPath();
    const instance = adapter();

    expect(await instance.estimateJobCost({ totalCredits: 96, breakdown: [] }, undefined, cookies)).toBe(14);
    expect(await instance.estimateJobCost({ totalCredits: 96, breakdown: [] }, { quantity: 3 }, cookies)).toBe(42);
    // The preflight prices the request that would be submitted, so the mode and
    // the model reach it.
    expect(estimateCost).toHaveBeenCalledWith(expect.objectContaining({ model: 'seedance_2_5' }));

    estimateCost.mockResolvedValue(undefined);
    expect(await instance.estimateJobCost({ totalCredits: 96, breakdown: [] }, undefined, cookies)).toBeUndefined();
    // Without a credential there is nothing to ask with.
    expect(await instance.estimateJobCost({ totalCredits: 96, breakdown: [] }, undefined, [])).toBeUndefined();
  });

  // A quote carries no media, and video_edit with no video to bill falls back
  // to pricing `duration` — several times what the job pays, since it is really
  // edited on the two-second seed. Quoting the requested length made a batch
  // reserve ~6x its bill and declare paid-up accounts broke.
  it('quotes video_edit at the seed clip it will be billed by, not the length asked for', async () => {
    const { estimateCost } = mockHappyPath();
    const editing = new HiggsfieldAdapter({
      video: { model: 'seedance_2_5', mode: 'video_edit', resolution: '720p', durationSeconds: 10, aspectRatio: '16:9' },
      editSeedVideoSeconds: 2,
      pollTimeoutMs: 5_000,
      pollIntervalMs: 1
    });

    await editing.estimateJobCost({ totalCredits: 96, breakdown: [] }, { durationSeconds: 10 }, cookies);
    expect(estimateCost).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: 'video_edit', params: expect.objectContaining({ duration: 2 }) })
    );

    // The job itself still asks for the length the caller wanted.
    await editing.runWithoutBrowser(cookies, { text: 'a cat', imagePath, options: { durationSeconds: 10 } });
    expect(HiggsfieldMcpClient.prototype.generateVideo).toHaveBeenCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ duration: 10 }) }),
      undefined
    );

    // Every other mode is billed by what it was asked for, so that is the quote.
    const t2v = new HiggsfieldAdapter({
      video: { model: 'seedance_2_5', mode: 't2v', resolution: '720p', durationSeconds: 10, aspectRatio: '16:9' },
      editSeedVideoSeconds: 2,
      pollTimeoutMs: 5_000,
      pollIntervalMs: 1
    });
    await t2v.estimateJobCost({ totalCredits: 96, breakdown: [] }, { durationSeconds: 10 }, cookies);
    expect(estimateCost).toHaveBeenLastCalledWith(
      expect.objectContaining({ params: expect.objectContaining({ duration: 10 }) })
    );
  });

  // The pool must not refuse a job on this number: it prices the request as
  // known before an account is picked, not always the one that is submitted.
  it('does not let its own quote refuse a job', () => {
    expect(adapter().costEstimateIsBinding).toBe(false);
  });
});

describe('higgsfieldJobBudgetMs', () => {
  it('leaves room for every render attempt plus the waits between them', () => {
    const budget = higgsfieldJobBudgetMs({ pollTimeoutMs: 900_000, retryDelaysMs: [10_000, 30_000, 60_000] });
    expect(budget).toBe(900_000 * 4 + 100_000 * 4 + 60_000);
  });

  it('is one poll budget when retries are disabled', () => {
    expect(higgsfieldJobBudgetMs({ pollTimeoutMs: 900_000, retryDelaysMs: [] })).toBe(960_000);
  });
});
