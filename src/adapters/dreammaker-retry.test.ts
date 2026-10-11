import { describe, expect, it } from 'vitest';
import { DreamMakerApiError, GENERATE_VIDEO_PATH } from './dreammaker-api.js';
import {
  DreamMakerRenderTimeoutError,
  DreamMakerTaskFailedError,
  DreamMakerTaskNotFoundError,
  classifyDreamMakerError,
  isDreamMakerInsufficientCreditsError
} from './dreammaker-retry.js';

const apiError = (status: number, code: string | undefined, message: string, path = '/api/credits/balances') =>
  new DreamMakerApiError(status, code, message, path);

describe('classifyDreamMakerError on HTTP failures', () => {
  it.each([
    ['401 is an expired or revoked token', apiError(401, undefined, 'Missing bearer token'), 'auth', true],
    ['403 is an expired or revoked token', apiError(403, undefined, 'Forbidden'), 'auth', true],
    ['402 means the account cannot pay', apiError(402, undefined, '余额不足'), 'insufficient_credits', false],
    ['the platform names the credit failure', apiError(400, 'INSUFFICIENT_CREDIT', '积分余额不足'), 'insufficient_credits', false],
    ['a used-up team quota is also unpayable', apiError(403, 'MEMBER_QUOTA_EXCEEDED', '本月团队积分额度已用尽'), 'insufficient_credits', false],
    ['429 is back-pressure', apiError(429, undefined, 'Too Many Requests'), 'provider_busy', true],
    ['a queue limit is back-pressure', apiError(409, 'CONCURRENCY_LIMIT_EXCEEDED', '排队中'), 'provider_busy', true],
    ['5xx is treated as a connection problem', apiError(503, undefined, 'Service Unavailable'), 'network', true],
    ['anything else is unknown but retried', apiError(400, 'WHATEVER', 'nope'), 'unknown', true]
  ])('%s', (_name, error, kind, retryable) => {
    const failure = classifyDreamMakerError(error);
    expect(failure.kind).toBe(kind);
    expect(failure.retryable).toBe(retryable);
    expect(failure.providerMessage).toBe(error.apiMessage);
  });

  it('reads a credit rejection out of the submission message', () => {
    const failure = classifyDreamMakerError(
      apiError(400, undefined, '积分余额不足，请兑换积分后重试', GENERATE_VIDEO_PATH)
    );
    expect(failure.kind).toBe('insufficient_credits');
    expect(failure.code).toBe('INSUFFICIENT_CREDITS');
  });
});

describe('classifyDreamMakerError on task failures', () => {
  const failed = (code: string | undefined, message: string, action?: string) =>
    new DreamMakerTaskFailedError('cgt_1', code, message, action);

  it('takes the platform\'s own remedy as the verdict', () => {
    expect(classifyDreamMakerError(failed('X', '余额不足', 'recharge')).kind).toBe('insufficient_credits');
    expect(classifyDreamMakerError(failed('X', '描述不合适', 'edit_prompt')).kind).toBe('content_rejected');
    expect(classifyDreamMakerError(failed('X', '素材不合适', 'replace_image')).kind).toBe('content_rejected');
    expect(classifyDreamMakerError(failed('X', '需要校验素材', 'auto_compliance')).kind).toBe('content_rejected');
  });

  it('treats an ordinary submission failure as a retryable render failure', () => {
    const failure = classifyDreamMakerError(
      failed('PROVIDER_SUBMIT_FAILED', '生成任务提交失败，请稍后重试。', 'retry')
    );
    expect(failure).toMatchObject({
      kind: 'render_failed',
      code: 'PROVIDER_RENDER_FAILED',
      retryable: true,
      providerCode: 'PROVIDER_SUBMIT_FAILED'
    });
  });

  it('falls back to the message when no remedy is given', () => {
    expect(classifyDreamMakerError(failed(undefined, '内容涉嫌违规')).kind).toBe('content_rejected');
    expect(classifyDreamMakerError(failed(undefined, '渲染出错')).kind).toBe('render_failed');
  });
});

describe('classifyDreamMakerError on local failures', () => {
  it('maps the client-side errors', () => {
    expect(classifyDreamMakerError(new DreamMakerTaskNotFoundError('cgt_1')).kind).toBe('not_found');
    expect(classifyDreamMakerError(new DreamMakerRenderTimeoutError('cgt_1', 1000)).kind).toBe('render_timeout');
    expect(classifyDreamMakerError(new TypeError('fetch failed')).kind).toBe('network');
    expect(classifyDreamMakerError(new Error('something else')).kind).toBe('unknown');
  });

  it('recognises an OSS upload that failed on a 5xx as a connection problem', () => {
    expect(classifyDreamMakerError(new Error('OSS POST key failed: HTTP 503 busy')).kind).toBe('network');
  });
});

describe('isDreamMakerInsufficientCreditsError', () => {
  it('is what the runner uses to move a job to another account', () => {
    expect(isDreamMakerInsufficientCreditsError(apiError(402, undefined, '余额不足'))).toBe(true);
    expect(isDreamMakerInsufficientCreditsError(
      new DreamMakerTaskFailedError('cgt_1', undefined, '余额不足', 'recharge')
    )).toBe(true);
    expect(isDreamMakerInsufficientCreditsError(apiError(503, undefined, 'busy'))).toBe(false);
  });
});
