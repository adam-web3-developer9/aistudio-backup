import { DreamMakerApiError, GENERATE_VIDEO_PATH } from './dreammaker-api.js';
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
 * Error codes the web app knows by name (`INSUFFICIENT_CREDIT`,
 * `PAYMENT_REQUIRED`, `MEMBER_QUOTA_EXCEEDED`, `CONCURRENCY_LIMIT_EXCEEDED`)
 * plus the `errorAction` a failed task carries, which is the platform's own
 * verdict on what would make the job pass: `recharge` means this account
 * cannot pay, `edit_prompt` / `replace_image` / `auto_compliance` mean the
 * content was rejected.
 */
const CANNOT_PAY_CODES = new Set(['INSUFFICIENT_CREDIT', 'PAYMENT_REQUIRED', 'MEMBER_QUOTA_EXCEEDED']);
const BUSY_CODES = new Set(['CONCURRENCY_LIMIT_EXCEEDED', 'RATE_LIMIT_EXCEEDED']);
const CONTENT_ACTIONS = new Set(['edit_prompt', 'replace_image', 'replace_asset', 'auto_compliance']);
const CONTENT_REJECTED_MESSAGE = /违规|违反|敏感|不合规|合规|审核未通过|sensitive|violat|moderation|policy/i;
const INSUFFICIENT_CREDITS_MESSAGE = /(?:积分|余额|额度).{0,8}(?:不足|不够|已用尽)|insufficient.{0,12}(?:credits?|balance)/i;
const BUSY_MESSAGE = /排队|繁忙|资源较忙|稍后再?试|too many requests|busy|try again later|rate ?limit/i;

/** A task DreamMaker accepted and then failed; carries the platform's own verdict. */
export class DreamMakerTaskFailedError extends Error {
  constructor(
    readonly taskId: string,
    readonly errorCode: string | undefined,
    readonly errorMessage: string,
    /** `retry`, `recharge`, `edit_prompt`, `replace_image`, `auto_compliance`, … */
    readonly errorAction: string | undefined
  ) {
    super(`DreamMaker task ${taskId} failed${errorCode ? ` (${errorCode})` : ''}: ${errorMessage}`);
  }
}

/** The task id is not (or no longer) known to the platform. */
export class DreamMakerTaskNotFoundError extends Error {
  constructor(readonly taskId: string) {
    super(`DreamMaker task ${taskId} not found`);
  }
}

/** The poll budget ran out while the task was still queued or running. */
export class DreamMakerRenderTimeoutError extends Error {
  constructor(readonly taskId: string, readonly timeoutMs: number) {
    super(`DreamMaker task ${taskId} did not finish within ${timeoutMs}ms`);
  }
}

/** The task was cancelled — by us on timeout, or elsewhere on the account. */
export class DreamMakerTaskCanceledError extends Error {
  constructor(readonly taskId: string) {
    super(`DreamMaker task ${taskId} was canceled`);
  }
}

export const classifyDreamMakerError: FailureClassifier = (error: unknown): ProviderFailure => {
  if (error instanceof ProviderJobError) return error.failure;
  if (error instanceof DreamMakerTaskNotFoundError) return failure('not_found', error.message);
  if (error instanceof DreamMakerRenderTimeoutError) return failure('render_timeout', error.message);
  if (error instanceof DreamMakerTaskCanceledError) return failure('render_failed', error.message);

  if (error instanceof DreamMakerTaskFailedError) {
    const detail = { providerCode: error.errorCode ?? undefined, providerMessage: error.errorMessage };
    if (error.errorAction === 'recharge' || (error.errorCode && CANNOT_PAY_CODES.has(error.errorCode))) {
      return failure('insufficient_credits', error.message, detail);
    }
    if (error.errorAction && CONTENT_ACTIONS.has(error.errorAction)) {
      return failure('content_rejected', error.message, detail);
    }
    if (CONTENT_REJECTED_MESSAGE.test(error.errorMessage)) {
      return failure('content_rejected', error.message, detail);
    }
    if (error.errorCode && BUSY_CODES.has(error.errorCode)) {
      return failure('provider_busy', error.message, detail);
    }
    return failure('render_failed', error.message, detail);
  }

  if (error instanceof DreamMakerApiError) {
    const message = error.apiMessage.replace(/\s+/g, ' ').trim();
    const detail = { providerCode: error.apiCode ?? error.status, providerMessage: message };
    if (error.apiCode && CANNOT_PAY_CODES.has(error.apiCode)) {
      return failure('insufficient_credits', error.message, detail);
    }
    if (error.status === 402) return failure('insufficient_credits', error.message, detail);
    if (error.status === 401 || error.status === 403) return failure('auth', error.message, detail);
    if (error.apiCode && BUSY_CODES.has(error.apiCode)) return failure('provider_busy', error.message, detail);
    if (error.status === 429) return failure('provider_busy', error.message, detail);
    if (error.status === 408 || error.status >= 500) return failure('network', error.message, detail);
    if (error.path === GENERATE_VIDEO_PATH && INSUFFICIENT_CREDITS_MESSAGE.test(message)) {
      return failure('insufficient_credits', error.message, detail);
    }
    if (CONTENT_REJECTED_MESSAGE.test(message)) return failure('content_rejected', error.message, detail);
    if (BUSY_MESSAGE.test(message)) return failure('provider_busy', error.message, detail);
    return failure('unknown', error.message, detail);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isNetworkError(error)) return failure('network', message);
  return failure('unknown', message || 'Unknown automation error');
};

/** The account cannot pay for this job — the runner should try another one. */
export function isDreamMakerInsufficientCreditsError(error: unknown): boolean {
  return classifyDreamMakerError(error).kind === 'insufficient_credits';
}

export function withDreamMakerRetries<T>(
  step: string,
  run: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  return withProviderRetries(step, run, classifyDreamMakerError, options);
}
