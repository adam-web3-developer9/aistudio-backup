import { HailuoApiError } from './hailuo-api.js';
import {
  ProviderJobError,
  isHttpStatus,
  isNetworkError,
  providerFailure as failure,
  withProviderRetries,
  type FailureClassifier,
  type ProviderFailure,
  type ProviderFailureKind,
  type RetryOptions
} from './provider-retry.js';

export {
  DEFAULT_RETRY_DELAYS_MS,
  isNetworkError,
  parseRetryDelays,
  sleep,
  type RetryAttemptInfo,
  type RetryOptions
} from './provider-retry.js';

/** The shared failure vocabulary, under the names this module has always used. */
export type HailuoFailureKind = ProviderFailureKind;
export type HailuoFailure = ProviderFailure;
export { ProviderJobError as HailuoJobError } from './provider-retry.js';

const GENERATE_VIDEO_PATH = '/v2/api/multimodal/generate/video';
const CONTENT_REJECTED_CODES = new Set<number | string>([2400002]);
const PROVIDER_BUSY_CODES = new Set<number | string>([2400003]);
const CONTENT_REJECTED_MESSAGE = /违反社区规范|违规|敏感|不合规|sensitive|violat|moderation|policy/i;
const PROVIDER_BUSY_MESSAGE = /资源较忙|繁忙|排队人数过多|稍后再?试|too many requests|busy|try again later|rate ?limit/i;
const INSUFFICIENT_CREDITS_MESSAGE = /(?:贝壳|积分|余额).{0,8}(?:不足|不够)|insufficient.{0,12}(?:credits?|shells?|balance)/i;
const AUTH_MESSAGE = /登录|token.{0,10}(?:过期|失效|invalid|expired)|unauthori[sz]ed|请重新登录/i;

/** The render Hailuo ran for us ended in failure; carries Hailuo's own explanation. */
export class HailuoRenderFailedError extends Error {
  constructor(readonly videoId: string, readonly providerMessage: string, readonly canRetry?: boolean) {
    super(`Hailuo generation ${videoId} failed: ${providerMessage}`);
  }
}

/** Hailuo's creation lists did not contain the id — transient right after submit, real if it persists. */
export class HailuoCreationNotFoundError extends Error {
  constructor(readonly videoId: string) {
    super(`Hailuo creation ${videoId} not found in processing or recent creations`);
  }
}

/** The poll budget for one render ran out while Hailuo still reported it in progress. */
export class HailuoRenderTimeoutError extends Error {
  constructor(readonly videoId: string, readonly timeoutMs: number) {
    super(`Hailuo generation ${videoId} did not finish within ${timeoutMs}ms`);
  }
}

export const classifyHailuoError: FailureClassifier = (error: unknown): HailuoFailure => {
  if (error instanceof ProviderJobError) return error.failure;
  if (error instanceof HailuoRenderFailedError) {
    return failure('render_failed', error.message, { providerMessage: error.providerMessage });
  }
  if (error instanceof HailuoCreationNotFoundError) return failure('not_found', error.message);
  if (error instanceof HailuoRenderTimeoutError) return failure('render_timeout', error.message);

  if (error instanceof HailuoApiError) {
    const message = error.apiMessage.replace(/\s+/g, ' ').trim();
    const detail = { providerCode: error.code, providerMessage: message };
    if (isHttpStatus(error.code)) {
      const status = Number(error.code);
      if (status === 401 || status === 403) return failure('auth', error.message, detail);
      if (status === 408 || status === 429 || status >= 500) return failure('network', error.message, detail);
      return failure('unknown', error.message, detail);
    }
    if (error.path === GENERATE_VIDEO_PATH && INSUFFICIENT_CREDITS_MESSAGE.test(message)) {
      return failure('insufficient_credits', error.message, detail);
    }
    if (CONTENT_REJECTED_CODES.has(error.code) || CONTENT_REJECTED_MESSAGE.test(message)) {
      return failure('content_rejected', error.message, detail);
    }
    if (PROVIDER_BUSY_CODES.has(error.code) || PROVIDER_BUSY_MESSAGE.test(message)) {
      return failure('provider_busy', error.message, detail);
    }
    if (AUTH_MESSAGE.test(message)) return failure('auth', error.message, detail);
    return failure('unknown', error.message, detail);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isNetworkError(error)) return failure('network', message);
  return failure('unknown', message || 'Unknown automation error');
};

/**
 * Run `step` and, when it fails in a way that may pass next time, run it again
 * after each delay in turn. The last error is rethrown as a `HailuoJobError`
 * carrying the classification and the attempt count.
 */
export function withHailuoRetries<T>(
  step: string,
  run: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  return withProviderRetries(step, run, classifyHailuoError, options);
}
