import { describe, expect, it, vi } from 'vitest';
import { AdapterRegistry, type AdapterInput, type BrowserAdapter } from '../adapters/adapter.js';
import { HailuoApiError } from '../adapters/hailuo-api.js';
import { JobStore } from '../stores/job-store.js';
import type { AssetStore } from '../stores/asset-store.js';
import type { SessionStore } from '../stores/session-store.js';
import type { BrowserPool } from '../browser/browser-pool.js';
import { AccountPool, type AccountLease, type AcquireRequest } from './account-pool.js';
import { JobRunner } from './job-runner.js';

const creditError = () => new HailuoApiError(
  1001,
  '贝壳不足',
  '/v2/api/multimodal/generate/video'
);

function lease(sessionId: string, credits: number, release = vi.fn()): AccountLease {
  return { sessionId, credits, cookies: [], release };
}

function setup(options: { pinned?: boolean } = {}) {
  const jobs = new JobStore();
  const job = jobs.create({
    adapterId: 'hailuo-v1',
    text: 'test',
    assetId: 'asset-1',
    ...(options.pinned && { sessionId: 'low' }),
    options: { durationSeconds: 4, resolution: '768' }
  });
  const assets = {
    get: vi.fn().mockReturnValue({
      id: 'asset-1',
      originalName: 'image.png',
      mimeType: 'image/png',
      size: 1,
      path: 'image.png',
      createdAt: '2026-08-21T00:00:00.000Z'
    })
  } as unknown as AssetStore;
  const sessions = {
    get: vi.fn(async (id: string) => ({
      id,
      adapterId: 'hailuo-v1',
      cookies: [{ name: '_token', value: id, domain: '.hailuoai.com', path: '/' }],
      updatedAt: '2026-08-21T00:00:00.000Z'
    }))
  } as unknown as SessionStore;
  const lowRelease = vi.fn();
  const highRelease = vi.fn();
  const acquire = vi.fn(async (request: AcquireRequest) => {
    if (request.sessionId === 'low') return lease('low', 32, lowRelease);
    if (!request.excludeSessionIds?.has('low')) return lease('low', 32, lowRelease);
    if (!request.excludeSessionIds?.has('high')) return lease('high', 74, highRelease);
    throw new Error('unexpected acquire');
  });
  const accounts = { acquire } as unknown as AccountPool;
  const runWithoutBrowser = vi.fn(async (cookies: readonly { value: string }[]) => {
    if (cookies[0]?.value === 'low') throw creditError();
    return { status: 'succeeded' };
  });
  const adapter: BrowserAdapter = {
    id: 'hailuo-v1',
    allowedCookieDomains: ['.hailuoai.com'],
    isInsufficientCreditsError: (error) => error instanceof HailuoApiError
      && error.path === '/v2/api/multimodal/generate/video'
      && error.apiMessage.includes('贝壳不足'),
    runWithoutBrowser,
    run: vi.fn()
  };
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  const browsers = { use: vi.fn() } as unknown as BrowserPool;
  const runner = new JobRunner(jobs, assets, sessions, adapters, browsers, accounts, {
    timeoutMs: 1_000,
    directTimeoutMs: 1_000
  });

  return { jobs, job, runner, acquire, runWithoutBrowser, lowRelease, highRelease };
}

describe('JobRunner credit failover', () => {
  it('retries an automatic job on another account after provider credit rejection', async () => {
    const ctx = setup();

    ctx.runner.submit(ctx.job);
    await vi.waitFor(() => expect(ctx.jobs.get(ctx.job.id)?.status).toBe('succeeded'));

    expect(ctx.acquire).toHaveBeenCalledTimes(2);
    expect(ctx.acquire.mock.calls[1]?.[0].excludeSessionIds).toEqual(new Set(['low']));
    expect(ctx.runWithoutBrowser).toHaveBeenCalledTimes(2);
    expect(ctx.lowRelease).toHaveBeenCalledOnce();
    expect(ctx.highRelease).toHaveBeenCalledOnce();
    expect(ctx.jobs.get(ctx.job.id)?.sessionId).toBe('high');
  });

  it('does not switch accounts when the caller pinned a session', async () => {
    const ctx = setup({ pinned: true });

    ctx.runner.submit(ctx.job);
    await vi.waitFor(() => expect(ctx.jobs.get(ctx.job.id)?.status).toBe('failed'));

    expect(ctx.acquire).toHaveBeenCalledOnce();
    expect(ctx.runWithoutBrowser).toHaveBeenCalledOnce();
    expect(ctx.jobs.get(ctx.job.id)?.error?.code).toBe('INSUFFICIENT_CREDITS');
  });
});

describe('JobRunner recovery after a restart', () => {
  function recoverySetup(resume?: BrowserAdapter['resumeWithoutBrowser']) {
    const jobs = new JobStore();
    const assets = {
      get: vi.fn().mockReturnValue({
        id: 'asset-1', originalName: 'image.png', mimeType: 'image/png',
        size: 1, path: 'image.png', createdAt: '2026-08-21T00:00:00.000Z'
      })
    } as unknown as AssetStore;
    const session = {
      id: 'hailuo-1', adapterId: 'hailuo-v1',
      cookies: [{ name: '_token', value: 'token-1', domain: '.hailuoai.com', path: '/' }],
      updatedAt: '2026-08-21T00:00:00.000Z'
    };
    const sessions = {
      list: vi.fn(async () => [session]),
      get: vi.fn(async (id: string) => (id === session.id ? session : undefined))
    } as unknown as SessionStore;
    const runWithoutBrowser = vi.fn(async (_cookies: unknown, input: AdapterInput) => {
      input.onProgress?.({ providerJobId: 'video-new', creditsBefore: 100 });
      return { status: 'succeeded', videoId: 'video-new' };
    });
    const adapter: BrowserAdapter = {
      id: 'hailuo-v1',
      allowedCookieDomains: ['.hailuoai.com'],
      getCreditsFromCookies: vi.fn(async () => ({ totalCredits: 100, breakdown: [] })),
      estimateJobCost: () => 10,
      runWithoutBrowser,
      ...(resume && { resumeWithoutBrowser: resume }),
      run: vi.fn()
    };
    const adapters = new AdapterRegistry();
    adapters.register(adapter);
    const accounts = new AccountPool(sessions, adapters);
    const browsers = { use: vi.fn() } as unknown as BrowserPool;
    const runner = new JobRunner(jobs, assets, sessions, adapters, browsers, accounts, {
      timeoutMs: 1_000,
      directTimeoutMs: 1_000
    });
    return { jobs, runner, runWithoutBrowser, accounts };
  }

  it('reruns queued jobs, resumes submitted ones and fails the ambiguous rest', async () => {
    const resume = vi.fn<NonNullable<BrowserAdapter['resumeWithoutBrowser']>>(
      async () => ({ status: 'succeeded', videoId: 'video-old', resumed: true })
    );
    const ctx = recoverySetup(resume);
    const queued = ctx.jobs.create({ adapterId: 'hailuo-v1', text: 'queued', assetId: 'asset-1' });
    const submitted = ctx.jobs.create({ adapterId: 'hailuo-v1', text: 'submitted', assetId: 'asset-1' });
    ctx.jobs.update(submitted.id, {
      status: 'running',
      sessionId: 'hailuo-1',
      progress: { providerJobId: 'video-old', batchId: 'b1', creditsBefore: 90, updatedAt: '2026-09-10T00:00:00.000Z' }
    });
    const ambiguous = ctx.jobs.create({ adapterId: 'hailuo-v1', text: 'uploading', assetId: 'asset-1' });
    ctx.jobs.update(ambiguous.id, { status: 'running', sessionId: 'hailuo-1' });
    const done = ctx.jobs.create({ adapterId: 'hailuo-v1', text: 'done', assetId: 'asset-1' });
    ctx.jobs.update(done.id, { status: 'succeeded', result: { videoId: 'v0' } });

    const summary = ctx.runner.recover();

    expect(summary).toEqual({ requeued: [queued.id], resumed: [submitted.id], interrupted: [ambiguous.id] });
    expect(ctx.jobs.get(ambiguous.id)).toMatchObject({ status: 'failed', error: { code: 'INTERRUPTED' } });
    expect(ctx.jobs.get(done.id)?.status).toBe('succeeded');

    await vi.waitFor(() => {
      expect(ctx.jobs.get(queued.id)?.status).toBe('succeeded');
      expect(ctx.jobs.get(submitted.id)?.status).toBe('succeeded');
    });
    expect(resume).toHaveBeenCalledOnce();
    expect(resume.mock.calls[0]?.[1]).toMatchObject({ providerJobId: 'video-old' });
    expect(resume.mock.calls[0]?.[2]).toMatchObject({ text: 'submitted' });
    expect(ctx.jobs.get(submitted.id)?.result).toMatchObject({ videoId: 'video-old', resumed: true });
    expect(ctx.jobs.get(queued.id)?.progress).toMatchObject({ providerJobId: 'video-new', creditsBefore: 100 });
    expect(ctx.runWithoutBrowser).toHaveBeenCalledOnce();

    // Both leases were released: the account is free again.
    expect((await ctx.accounts.snapshot())[0]).toMatchObject({ activeJobs: 0 });
  });

  it('fails a resumable job cleanly when the adapter cannot resume', async () => {
    const ctx = recoverySetup();
    const submitted = ctx.jobs.create({ adapterId: 'hailuo-v1', text: 'submitted', assetId: 'asset-1' });
    ctx.jobs.update(submitted.id, {
      status: 'running',
      sessionId: 'hailuo-1',
      progress: { providerJobId: 'video-old', updatedAt: '2026-09-10T00:00:00.000Z' }
    });

    ctx.runner.recover();

    await vi.waitFor(() => expect(ctx.jobs.get(submitted.id)?.status).toBe('failed'));
    expect(ctx.jobs.get(submitted.id)?.error?.code).toBe('INTERRUPTED');
    expect(ctx.runWithoutBrowser).not.toHaveBeenCalled();
  });
});

describe('JobRunner local account queue', () => {
  it('submits only two jobs per account and leaves the third locally queued', async () => {
    const jobs = new JobStore();
    const records = Array.from({ length: 3 }, (_, index) => jobs.create({
      adapterId: 'hailuo-v1',
      text: `test-${index + 1}`,
      assetId: 'asset-1',
      options: { durationSeconds: 4, resolution: '768' }
    }));
    const assets = {
      get: vi.fn().mockReturnValue({
        id: 'asset-1', originalName: 'image.png', mimeType: 'image/png',
        size: 1, path: 'image.png', createdAt: '2026-08-21T00:00:00.000Z'
      })
    } as unknown as AssetStore;
    const account = {
      id: 'a', adapterId: 'hailuo-v1',
      cookies: [{ name: '_token', value: 'token-a', domain: '.hailuoai.com', path: '/' }],
      updatedAt: '2026-08-21T00:00:00.000Z'
    };
    const sessions = {
      list: vi.fn(async () => [account]),
      get: vi.fn(async () => account)
    } as unknown as SessionStore;
    const completions: Array<(value: unknown) => void> = [];
    const runWithoutBrowser = vi.fn(() => new Promise((resolve) => completions.push(resolve)));
    const adapter: BrowserAdapter = {
      id: 'hailuo-v1',
      allowedCookieDomains: ['.hailuoai.com'],
      getCreditsFromCookies: vi.fn(async () => ({ totalCredits: 100, breakdown: [] })),
      estimateJobCost: () => 10,
      runWithoutBrowser,
      run: vi.fn()
    };
    const adapters = new AdapterRegistry();
    adapters.register(adapter);
    const accounts = new AccountPool(sessions, adapters);
    const browsers = { use: vi.fn() } as unknown as BrowserPool;
    const runner = new JobRunner(jobs, assets, sessions, adapters, browsers, accounts, {
      timeoutMs: 1_000,
      directTimeoutMs: 1_000
    });

    records.forEach((job) => runner.submit(job));

    await vi.waitFor(() => expect(runWithoutBrowser).toHaveBeenCalledTimes(2));
    const initialStatuses = records.map((job) => jobs.get(job.id)?.status);
    expect(initialStatuses.filter((status) => status === 'running')).toHaveLength(2);
    expect(initialStatuses.filter((status) => status === 'queued')).toHaveLength(1);
    const queuedJob = records.find((job) => jobs.get(job.id)?.status === 'queued')!;

    completions[0]?.({ status: 'succeeded' });
    await vi.waitFor(() => expect(runWithoutBrowser).toHaveBeenCalledTimes(3));
    expect(jobs.get(queuedJob.id)?.status).toBe('running');

    completions[1]?.({ status: 'succeeded' });
    completions[2]?.({ status: 'succeeded' });
    await vi.waitFor(() => {
      expect(records.map((job) => jobs.get(job.id)?.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    });
  });
});
