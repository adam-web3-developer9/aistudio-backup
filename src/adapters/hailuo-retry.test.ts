import { describe, expect, it, vi } from 'vitest';
import { HailuoApiError } from './hailuo-api.js';
import {
  HailuoCreationNotFoundError,
  HailuoJobError,
  HailuoRenderFailedError,
  HailuoRenderTimeoutError,
  classifyHailuoError,
  isNetworkError,
  parseRetryDelays,
  withHailuoRetries
} from './hailuo-retry.js';

const GENERATE = '/v2/api/multimodal/generate/video';

describe('classifyHailuoError', () => {
  it('treats undici connection failures as retryable network errors', () => {
    const fetchFailed = new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    expect(classifyHailuoError(fetchFailed)).toMatchObject({ kind: 'network', code: 'PROVIDER_NETWORK_ERROR', retryable: true });
    expect(classifyHailuoError(new Error('terminated'))).toMatchObject({ kind: 'network', retryable: true });
    expect(classifyHailuoError(Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }))).toMatchObject({ kind: 'network' });
    expect(classifyHailuoError(new Error('OSS PUT dir/x.png failed: HTTP 503 '))).toMatchObject({ kind: 'network' });
    expect(isNetworkError(new Error('OSS PUT dir/x.png failed: HTTP 403 forbidden'))).toBe(false);
  });

  it('maps Hailuo HTTP statuses: 5xx/429 are network trouble, 401/403 an auth failure', () => {
    expect(classifyHailuoError(new HailuoApiError(502, '<html>bad gateway</html>', GENERATE))).toMatchObject({ kind: 'network', retryable: true, providerCode: 502 });
    expect(classifyHailuoError(new HailuoApiError(429, '', GENERATE))).toMatchObject({ kind: 'network', retryable: true });
    expect(classifyHailuoError(new HailuoApiError(401, '', GENERATE))).toMatchObject({ kind: 'auth', code: 'AUTH_FAILED', retryable: true });
  });

  it('keeps only the credit rejection final; a moderation rejection is retried', () => {
    expect(classifyHailuoError(new HailuoApiError(2400002, '文案违反社区规范，请更换文案后重试', GENERATE))).toMatchObject({
      kind: 'content_rejected', code: 'CONTENT_REJECTED', retryable: true, providerCode: 2400002,
      providerMessage: '文案违反社区规范，请更换文案后重试'
    });
    expect(classifyHailuoError(new HailuoApiError(1001, '贝壳不足', GENERATE))).toMatchObject({
      kind: 'insufficient_credits', code: 'INSUFFICIENT_CREDITS', retryable: false
    });
  });

  it('retries a busy provider, a failed render and a poll timeout', () => {
    expect(classifyHailuoError(new HailuoApiError(2400003, '当前资源较忙，请重试', GENERATE))).toMatchObject({ kind: 'provider_busy', code: 'PROVIDER_BUSY', retryable: true });
    expect(classifyHailuoError(new HailuoRenderFailedError('v1', '内容生成失败。请重试。 (生成过程中出现错误，请重试)'))).toMatchObject({
      kind: 'render_failed', code: 'PROVIDER_RENDER_FAILED', retryable: true,
      providerMessage: '内容生成失败。请重试。 (生成过程中出现错误，请重试)'
    });
    expect(classifyHailuoError(new HailuoCreationNotFoundError('v1'))).toMatchObject({ kind: 'not_found', retryable: true });
    expect(classifyHailuoError(new HailuoRenderTimeoutError('v1', 900_000))).toMatchObject({ kind: 'render_timeout', code: 'RENDER_TIMEOUT', retryable: true });
  });

  it('falls back to AUTOMATION_FAILED for anything else, still retried', () => {
    expect(classifyHailuoError(new Error('Hailuo credit API response is missing totalCredits'))).toMatchObject({ kind: 'unknown', code: 'AUTOMATION_FAILED', retryable: true });
  });
});

describe('withHailuoRetries', () => {
  it('retries a transient failure on the schedule and returns the eventual result', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn()
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new HailuoApiError(503, '', GENERATE))
        .mockResolvedValue('ok');
      const onRetry = vi.fn();
      const pending = withHailuoRetries('submit', run, { delaysMs: [10_000, 30_000, 60_000], onRetry });

      await vi.advanceTimersByTimeAsync(10_000);
      expect(run).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(run).toHaveBeenCalledTimes(3);
      await expect(pending).resolves.toBe('ok');

      expect(onRetry.mock.calls.map(([info]) => [info.attempt, info.delayMs, info.failure.kind])).toEqual([
        [1, 10_000, 'network'],
        [2, 30_000, 'network']
      ]);
      expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ step: 'submit', maxAttempts: 4 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the last delay with a classified error that counts the attempts', async () => {
    const run = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const error = await withHailuoRetries('upload', run, { delaysMs: [0, 0, 0] }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HailuoJobError);
    expect(error).toMatchObject({ code: 'PROVIDER_NETWORK_ERROR', retryable: true, attempts: 4, step: 'upload' });
    expect((error as HailuoJobError).message).toBe('fetch failed (upload: gave up after 4 attempts)');
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('does not retry a credit rejection and reports it after one attempt', async () => {
    const rejected = new HailuoApiError(1001, '贝壳不足', GENERATE);
    const run = vi.fn().mockRejectedValue(rejected);
    const error = await withHailuoRetries('submit', run, { delaysMs: [0, 0, 0] }).catch((e: unknown) => e);

    expect(run).toHaveBeenCalledOnce();
    expect(error).toMatchObject({ code: 'INSUFFICIENT_CREDITS', retryable: false, attempts: 1, providerCode: 1001 });
    expect((error as HailuoJobError).cause).toBe(rejected);
  });

  it('retries a moderation rejection on the schedule and reports CONTENT_REJECTED after the last try', async () => {
    const run = vi.fn().mockRejectedValue(new HailuoApiError(2400002, '文案违反社区规范，请更换文案后重试', GENERATE));
    const error = await withHailuoRetries('submit', run, { delaysMs: [0, 0, 0] }).catch((e: unknown) => e);

    expect(run).toHaveBeenCalledTimes(4);
    expect(error).toMatchObject({ code: 'CONTENT_REJECTED', retryable: true, attempts: 4, providerCode: 2400002 });
  });

  it('lets a moderation rejection through once Hailuo accepts a later try', async () => {
    const run = vi.fn()
      .mockRejectedValueOnce(new HailuoApiError(2400002, '文案违反社区规范，请更换文案后重试', GENERATE))
      .mockResolvedValue('ok');
    await expect(withHailuoRetries('submit', run, { delaysMs: [0, 0, 0] })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('stops retrying once the job is aborted', async () => {
    const controller = new AbortController();
    const run = vi.fn().mockImplementation(async () => {
      controller.abort(new Error('cancelled'));
      throw new TypeError('fetch failed');
    });
    await expect(withHailuoRetries('poll', run, { delaysMs: [0], signal: controller.signal })).rejects.toThrow('fetch failed');
    expect(run).toHaveBeenCalledOnce();
  });
});

describe('parseRetryDelays', () => {
  it('defaults to 10s/30s/60s, accepts a list, and lets `none` switch retries off', () => {
    expect(parseRetryDelays(undefined)).toEqual([10_000, 30_000, 60_000]);
    expect(parseRetryDelays('')).toEqual([10_000, 30_000, 60_000]);
    expect(parseRetryDelays('5000, 15000')).toEqual([5_000, 15_000]);
    expect(parseRetryDelays('none')).toEqual([]);
    expect(() => parseRetryDelays('10s')).toThrow(/HAILUO_RETRY_DELAYS_MS/);
  });
});
