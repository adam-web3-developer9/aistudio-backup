import { MioraApiError, MioraAuthError } from './miora-api.js';
import {
  ProviderJobError,
  isNetworkError,
  providerFailure as failure,
  withProviderRetries,
  type FailureClassifier,
  type ProviderFailure,
  type RetryOptions
} from './provider-retry.js';

/**
 * Miora reports most failures as a message string rather than a stable code, so
 * classification leans on the text. The few things it does name — platform
 * concurrency, rate limits — arrive as HTTP 429 or a message we match here.
 */
const INSUFFICIENT_CREDITS_MESSAGE =
  /(?:积分|余额|额度|credit).{0,8}(?:不足|不够|已用尽)|insufficient.{0,12}(?:credits?|balance)|余额不足/i;
const BUSY_MESSAGE =
  /并发|排队|繁忙|资源较忙|稍后再?试|too many requests|busy|try again later|rate ?limit|maximum concurrency|max concurrency/i;
const CONTENT_REJECTED_MESSAGE =
  /违规|违反|敏感|不合规|合规|审核未通过|sensitive|violat|moderation|policy/i;
/**
 * Deterministic input rejections from the platform — the same request will fail
 * the same way, so they must not be retried. minimax-h3 caps the prompt at 2000
 * characters and answers `prompt length N exceeds the limit …`; other invalid
 * parameters read similarly. The caller has to change the input, not wait.
 */
const INVALID_INPUT_MESSAGE =
  /exceeds the limit|prompt length|too long|please shorten|字符|超过|过长|invalid (?:parameter|param|value|request)|unsupported/i;

/** A task Miora accepted and then reported as failed. */
export class MioraTaskFailedError extends Error {
  constructor(
    readonly taskId: string,
    readonly errorMessage: string
  ) {
    super(`Miora task ${taskId} failed: ${errorMessage}`);
    this.name = 'MioraTaskFailedError';
  }
}

/** The task id is not (or not yet) known to the platform. */
export class MioraTaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`Miora task ${taskId} not found`);
    this.name = 'MioraTaskNotFoundError';
  }
}

/** The poll budget ran out while the task was still rendering. */
export class MioraRenderTimeoutError extends Error {
  constructor(readonly taskId: string, readonly timeoutMs: number) {
    super(`Miora task ${taskId} did not finish within ${timeoutMs}ms`);
    this.name = 'MioraRenderTimeoutError';
  }
}

/** The account-wide balance gate blocked a read of an already submitted task. */
export function isMioraProgressCreditBlocked(error: unknown): boolean {
  return error instanceof MioraApiError
    && error.path === '/media-generate/progress'
    && error.apiCode === '10005';
}

const classifyMioraFailure: FailureClassifier = (error: unknown): ProviderFailure => {
  if (error instanceof ProviderJobError) return error.failure;
  if (error instanceof MioraTaskNotFoundError) return failure('not_found', error.message);
  if (error instanceof MioraRenderTimeoutError) return failure('render_timeout', error.message);

  if (error instanceof MioraTaskFailedError) {
    const detail = { providerMessage: error.errorMessage };
    if (INSUFFICIENT_CREDITS_MESSAGE.test(error.errorMessage)) {
      return failure('insufficient_credits', error.message, detail);
    }
    if (INVALID_INPUT_MESSAGE.test(error.errorMessage)) {
      // Deterministic: retrying the same input changes nothing.
      return { ...failure('content_rejected', error.message, detail), retryable: false };
    }
    if (CONTENT_REJECTED_MESSAGE.test(error.errorMessage)) {
      return failure('content_rejected', error.message, detail);
    }
    if (BUSY_MESSAGE.test(error.errorMessage)) {
      return failure('provider_busy', error.message, detail);
    }
    return failure('render_failed', error.message, detail);
  }

  if (error instanceof MioraAuthError) {
    return failure('auth', error.message, { providerCode: 401 });
  }

  if (error instanceof MioraApiError) {
    const message = error.apiMessage.replace(/\s+/g, ' ').trim();
    const detail = { providerCode: error.apiCode ?? error.status, providerMessage: message };
    if (isMioraProgressCreditBlocked(error)) {
      return { ...failure('network', error.message, detail), code: 'PROVIDER_QUERY_BLOCKED' };
    }
    if (error.status === 402 || INSUFFICIENT_CREDITS_MESSAGE.test(message)) {
      return failure('insufficient_credits', error.message, detail);
    }
    if (INVALID_INPUT_MESSAGE.test(message)) {
      // Deterministic input rejection (e.g. prompt over the model's char limit).
      return { ...failure('content_rejected', error.message, detail), retryable: false };
    }
    if (error.status === 401 || error.status === 403) return failure('auth', error.message, detail);
    if (error.status === 429 || BUSY_MESSAGE.test(message)) return failure('provider_busy', error.message, detail);
    if (error.status === 408 || error.status >= 500) return failure('network', error.message, detail);
    if (CONTENT_REJECTED_MESSAGE.test(message)) return failure('content_rejected', error.message, detail);
    return failure('unknown', error.message, detail);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isNetworkError(error)) return failure('network', message);
  return failure('unknown', message || 'Unknown Miora error');
};

export const classifyMioraError: FailureClassifier = (error: unknown): ProviderFailure => {
  const classified = classifyMioraFailure(error);
  return { ...classified, providerTerminal: classified.providerTerminal ?? error instanceof MioraTaskFailedError };
};

/** The account cannot pay for this job — the runner should try another one. */
export function isMioraInsufficientCreditsError(error: unknown): boolean {
  return classifyMioraError(error).kind === 'insufficient_credits';
}

export function withMioraRetries<T>(
  step: string,
  run: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  return withProviderRetries(step, run, classifyMioraError, options);
}
