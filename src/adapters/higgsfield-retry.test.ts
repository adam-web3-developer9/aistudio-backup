import { describe, expect, it } from 'vitest';
import { HiggsfieldApiError, HiggsfieldAuthError } from './higgsfield-api.js';
import {
  HiggsfieldJobFailedError,
  HiggsfieldJobNotFoundError,
  HiggsfieldNoResultError,
  HiggsfieldRenderTimeoutError,
  classifyHiggsfieldError,
  isHiggsfieldInsufficientCreditsError
} from './higgsfield-retry.js';
import { ProviderJobError, providerFailure } from './provider-retry.js';

function apiError(status: number, message: string, code?: string) {
  return new HiggsfieldApiError(status, code, message, '/jobs/seedance');
}

describe('classifyHiggsfieldError', () => {
  it('passes an already-classified failure through untouched', () => {
    const failure = providerFailure('content_rejected', 'nope');
    expect(classifyHiggsfieldError(new ProviderJobError(failure, 3, 'render'))).toBe(failure);
  });

  it('reads the account-cannot-pay verdict from the code, the status or the text', () => {
    expect(classifyHiggsfieldError(apiError(400, 'nope', 'not_enough_credits')).kind).toBe('insufficient_credits');
    expect(classifyHiggsfieldError(apiError(402, 'Payment required')).kind).toBe('insufficient_credits');
    expect(classifyHiggsfieldError(apiError(400, 'Not enough credits for this generation')).kind)
      .toBe('insufficient_credits');
  });

  it('never retries an account that cannot pay, so the runner moves the job', () => {
    expect(isHiggsfieldInsufficientCreditsError(apiError(402, 'Payment required'))).toBe(true);
    expect(classifyHiggsfieldError(apiError(402, 'Payment required')).retryable).toBe(false);
  });

  it('classifies a rate limit as busy and a server error as network', () => {
    expect(classifyHiggsfieldError(apiError(429, 'slow down')).kind).toBe('provider_busy');
    expect(classifyHiggsfieldError(apiError(503, 'unavailable')).kind).toBe('network');
    expect(classifyHiggsfieldError(apiError(408, 'timeout')).kind).toBe('network');
  });

  it('treats an expired credential as auth, which is retried after a fresh mint', () => {
    expect(classifyHiggsfieldError(apiError(401, 'Unauthenticated')).kind).toBe('auth');
    expect(classifyHiggsfieldError(new HiggsfieldAuthError(401, 'signed out')).kind).toBe('auth');
    expect(classifyHiggsfieldError(new HiggsfieldAuthError(401, 'signed out')).retryable).toBe(true);
  });

  it('maps the platform job statuses onto the shared vocabulary', () => {
    expect(classifyHiggsfieldError(new HiggsfieldJobFailedError('job_1', 'nsfw', 'blocked')).kind)
      .toBe('content_rejected');
    expect(classifyHiggsfieldError(new HiggsfieldJobFailedError('job_1', 'failed', 'upstream died')).kind)
      .toBe('render_failed');
    expect(classifyHiggsfieldError(new HiggsfieldJobFailedError('job_1', 'failed', 'not enough credits')).kind)
      .toBe('insufficient_credits');
  });

  it('keeps a timed-out render separate from a failed one, so the retry keeps polling', () => {
    const failure = classifyHiggsfieldError(new HiggsfieldRenderTimeoutError('js_1', 1_000));
    expect(failure.kind).toBe('render_timeout');
    expect(failure.retryable).toBe(true);
  });

  it('classifies a set that is not there yet and one that finished empty', () => {
    expect(classifyHiggsfieldError(new HiggsfieldJobNotFoundError('js_1')).kind).toBe('not_found');
    expect(classifyHiggsfieldError(new HiggsfieldNoResultError('js_1')).kind).toBe('render_failed');
  });

  it('recognises a connection failure anywhere in the chain', () => {
    expect(classifyHiggsfieldError(new TypeError('fetch failed')).kind).toBe('network');
    expect(classifyHiggsfieldError(new Error('Storage PUT media_1 failed: HTTP 503')).kind).toBe('network');
  });

  it('carries the platform code and message through for the job record', () => {
    const failure = classifyHiggsfieldError(apiError(400, 'prompt violates the content policy', 'moderation'));
    expect(failure).toMatchObject({
      kind: 'content_rejected',
      providerCode: 'moderation',
      providerMessage: 'prompt violates the content policy'
    });
  });
});
