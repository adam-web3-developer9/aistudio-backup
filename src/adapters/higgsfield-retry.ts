import { HiggsfieldApiError, HiggsfieldAuthError } from './higgsfield-api.js';
import { HiggsfieldMcpError } from './higgsfield-mcp.js';
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
 * Codes the gateway answers with by name. Higgsfield has no single documented
 * list, so these are the ones the web app branches on plus the HTTP statuses
 * that mean the same thing.
 */
const CANNOT_PAY_CODES = new Set([
  'not_enough_credits',
  'insufficient_credits',
  'no_credits',
  'out_of_credits',
  'payment_required',
  'not_enough_boost_credits'
]);
const BUSY_CODES = new Set(['rate_limit_exceeded', 'too_many_requests', 'concurrency_limit_exceeded']);
const CONTENT_CODES = new Set(['nsfw', 'nsfw_detected', 'moderation', 'content_policy', 'ip_detected']);

const INSUFFICIENT_CREDITS_MESSAGE = /(?:not enough|insufficient|out of).{0,12}credits?|credits?.{0,12}(?:exhausted|depleted)/i;
const CONTENT_REJECTED_MESSAGE = /\bnsfw\b|moderation|content policy|prohibited|violat|copyright|rights holder/i;
const BUSY_MESSAGE = /too many requests|rate ?limit|server is busy|try again later|queue is full/i;

/** A job Higgsfield accepted and then failed, or refused on content grounds. */
export class HiggsfieldJobFailedError extends Error {
  constructor(
    readonly jobId: string,
    /** The platform's own job status: `failed`, `nsfw`, `canceled`, … */
    readonly status: string,
    readonly reason: string
  ) {
    super(`Higgsfield job ${jobId} ended as ${status}: ${reason}`);
  }
}

/** The job set id is not (or not yet) known to the platform. */
export class HiggsfieldJobNotFoundError extends Error {
  constructor(readonly jobSetId: string) {
    super(`Higgsfield job set ${jobSetId} not found`);
  }
}

/** The poll budget ran out while the render was still queued or running. */
export class HiggsfieldRenderTimeoutError extends Error {
  constructor(readonly jobSetId: string, readonly timeoutMs: number) {
    super(`Higgsfield job set ${jobSetId} did not finish within ${timeoutMs}ms`);
  }
}

/** The render finished but carried no video to hand back. */
export class HiggsfieldNoResultError extends Error {
  constructor(readonly jobSetId: string) {
    super(`Higgsfield job set ${jobSetId} completed without a video result`);
  }
}

export const classifyHiggsfieldError: FailureClassifier = (error: unknown): ProviderFailure => {
  if (error instanceof ProviderJobError) return error.failure;
  if (error instanceof HiggsfieldJobNotFoundError) return failure('not_found', error.message);
  if (error instanceof HiggsfieldRenderTimeoutError) return failure('render_timeout', error.message);
  if (error instanceof HiggsfieldNoResultError) return failure('render_failed', error.message);

  if (error instanceof HiggsfieldJobFailedError) {
    const detail = { providerCode: error.status, providerMessage: error.reason };
    if (error.status === 'nsfw' || CONTENT_REJECTED_MESSAGE.test(error.reason)) {
      return failure('content_rejected', error.message, detail);
    }
    if (INSUFFICIENT_CREDITS_MESSAGE.test(error.reason)) {
      return failure('insufficient_credits', error.message, detail);
    }
    return failure('render_failed', error.message, detail);
  }

  // A dead `__client` cookie is not something a retry fixes, but it is also not
  // a verdict about this job: report it as auth so the operator replaces the
  // line rather than seeing an unexplained automation failure.
  if (error instanceof HiggsfieldAuthError) {
    return failure('auth', error.message, { providerCode: error.status, providerMessage: error.detail });
  }

  /*
   * The MCP server reports in prose, so the message carries as much of the
   * verdict as the status does: a refusal to pay and a content rejection both
   * arrive as a tool error with no HTTP status of their own.
   */
  if (error instanceof HiggsfieldMcpError) {
    const message = error.message.replace(/\s+/g, ' ').trim();
    const detail = { providerCode: error.tool ?? error.status, providerMessage: message };
    if (error.status === 402 || INSUFFICIENT_CREDITS_MESSAGE.test(message)) {
      return failure('insufficient_credits', message, detail);
    }
    if (error.status === 401 || error.status === 403) return failure('auth', message, detail);
    if (error.status === 429 || BUSY_MESSAGE.test(message)) return failure('provider_busy', message, detail);
    if (error.status === 404) return failure('not_found', message, detail);
    if (error.status === 408 || error.status >= 500) return failure('network', message, detail);
    if (CONTENT_REJECTED_MESSAGE.test(message)) return failure('content_rejected', message, detail);
    return failure('unknown', message, detail);
  }

  if (error instanceof HiggsfieldApiError) {
    const message = error.apiMessage.replace(/\s+/g, ' ').trim();
    const code = error.apiCode?.toLowerCase();
    const detail = { providerCode: error.apiCode ?? error.status, providerMessage: message };
    if (code && CANNOT_PAY_CODES.has(code)) return failure('insufficient_credits', error.message, detail);
    if (error.status === 402) return failure('insufficient_credits', error.message, detail);
    if (error.status === 401 || error.status === 403) return failure('auth', error.message, detail);
    if (code && BUSY_CODES.has(code)) return failure('provider_busy', error.message, detail);
    if (error.status === 429) return failure('provider_busy', error.message, detail);
    if (error.status === 404) return failure('not_found', error.message, detail);
    if (error.status === 408 || error.status >= 500) return failure('network', error.message, detail);
    if (code && CONTENT_CODES.has(code)) return failure('content_rejected', error.message, detail);
    if (INSUFFICIENT_CREDITS_MESSAGE.test(message)) return failure('insufficient_credits', error.message, detail);
    if (CONTENT_REJECTED_MESSAGE.test(message)) return failure('content_rejected', error.message, detail);
    if (BUSY_MESSAGE.test(message)) return failure('provider_busy', error.message, detail);
    return failure('unknown', error.message, detail);
  }

  const message = error instanceof Error ? error.message : String(error);
  if (isNetworkError(error)) return failure('network', message);
  return failure('unknown', message || 'Unknown automation error');
};

/** The account cannot pay for this job — the runner should try another one. */
export function isHiggsfieldInsufficientCreditsError(error: unknown): boolean {
  return classifyHiggsfieldError(error).kind === 'insufficient_credits';
}

export function withHiggsfieldRetries<T>(
  step: string,
  run: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  return withProviderRetries(step, run, classifyHiggsfieldError, options);
}
