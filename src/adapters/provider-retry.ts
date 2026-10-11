/**
 * Retry machinery shared by every provider adapter.
 *
 * Only the classification of an error is provider-specific; the schedule, the
 * failure vocabulary and the error the runner finally sees are not. A provider
 * module supplies its own `FailureClassifier` and gets the rest from here —
 * see `hailuo-retry.ts` and `dreammaker-retry.ts`.
 */

/** Server-side retry schedule: three retries after the first try, at 10s / 30s / 60s. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000, 60_000];

/**
 * Why a provider call failed, reduced to what the runner and the caller need to
 * decide: retry here, switch account, or give up and say so plainly.
 */
export type ProviderFailureKind =
  /** Connection problems between this service and the provider or its storage; nothing was decided upstream. */
  | 'network'
  /** The provider accepted nothing because it is overloaded or rate-limiting us. */
  | 'provider_busy'
  /** The provider accepted the submission, then the render itself failed. */
  | 'render_failed'
  /** The job is not listed yet / any more; usually a moment of eventual consistency right after submit. */
  | 'not_found'
  /** Prompt or image rejected by moderation. Such verdicts are not always stable, so it is tried again. */
  | 'content_rejected'
  /** The account cannot pay; the runner moves the job to another account. */
  | 'insufficient_credits'
  /** Token expired or revoked. */
  | 'auth'
  /** The render did not settle within the poll budget. */
  | 'render_timeout'
  | 'unknown';

export interface ProviderFailure {
  kind: ProviderFailureKind;
  /** Stable machine code reported in `job.error.code`. */
  code: string;
  /**
   * Whether the service retries this itself. The caller came for a video, so
   * everything is retried except the one verdict that will not change by
   * asking again: an account that cannot pay (the runner moves the job to
   * another account). Moderation rejections are retried too; if all tries are
   * rejected the job fails as CONTENT_REJECTED and the text has to change.
   */
  retryable: boolean;
  /** The provider's own status code or the HTTP status, when there was one. */
  providerCode?: number | string;
  /** The provider's own message, untouched. */
  providerMessage?: string;
  message: string;
}

const FAILURE_CODES: Record<ProviderFailureKind, { code: string; retryable: boolean }> = {
  network: { code: 'PROVIDER_NETWORK_ERROR', retryable: true },
  provider_busy: { code: 'PROVIDER_BUSY', retryable: true },
  render_failed: { code: 'PROVIDER_RENDER_FAILED', retryable: true },
  not_found: { code: 'PROVIDER_JOB_NOT_FOUND', retryable: true },
  content_rejected: { code: 'CONTENT_REJECTED', retryable: true },
  insufficient_credits: { code: 'INSUFFICIENT_CREDITS', retryable: false },
  auth: { code: 'AUTH_FAILED', retryable: true },
  // A timed-out render is still rendering: the retry keeps polling the same
  // video instead of paying for a second one.
  render_timeout: { code: 'RENDER_TIMEOUT', retryable: true },
  unknown: { code: 'AUTOMATION_FAILED', retryable: true }
};

export function providerFailure(
  kind: ProviderFailureKind,
  message: string,
  detail: { providerCode?: number | string; providerMessage?: string } = {}
): ProviderFailure {
  return { kind, ...FAILURE_CODES[kind], message, ...detail };
}

/**
 * What an adapter throws once it has given up: the classified failure plus how
 * many tries it made, so the job record can say "we already retried this".
 */
export class ProviderJobError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly kind: ProviderFailureKind;
  readonly providerCode?: number | string;
  readonly providerMessage?: string;

  constructor(
    readonly failure: ProviderFailure,
    readonly attempts: number,
    readonly step: string,
    options?: { cause?: unknown }
  ) {
    super(
      attempts > 1
        ? `${failure.message} (${step}: gave up after ${attempts} attempts)`
        : failure.message,
      options
    );
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.kind = failure.kind;
    this.providerCode = failure.providerCode;
    this.providerMessage = failure.providerMessage;
  }
}

const NETWORK_MESSAGE = /fetch failed|terminated|socket hang up|network|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|UND_ERR|other side closed|Unexpected (?:token|end of JSON)|Body Timeout|Headers Timeout/i;

/** Connection-level failures anywhere in the chain (undici, DNS, TLS, storage 5xx, truncated JSON). */
export function isNetworkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const record = current as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (record.name === 'AbortError') return false;
    const text = [record.name, record.code, record.message].filter((v) => typeof v === 'string').join(' ');
    if (/^(?:OSS|Storage) (?:PUT|POST) .* failed: HTTP (?:5\d\d|408|429)/.test(String(record.message ?? ''))) return true;
    if (NETWORK_MESSAGE.test(text)) return true;
    current = record.cause;
  }
  return false;
}

export function isHttpStatus(code: number | string): boolean {
  return typeof code === 'number' && code >= 100 && code < 600;
}

export type FailureClassifier = (error: unknown) => ProviderFailure;

export interface RetryAttemptInfo {
  step: string;
  /** The try that just failed, 1-based. */
  attempt: number;
  /** First try plus every scheduled retry. */
  maxAttempts: number;
  delayMs: number;
  failure: ProviderFailure;
}

export interface RetryOptions {
  delaysMs?: readonly number[];
  signal?: AbortSignal;
  /** Defaults to the failure's own `retryable` flag. */
  shouldRetry?: (failure: ProviderFailure, error: unknown) => boolean;
  onRetry?: (info: RetryAttemptInfo) => void;
}

/**
 * Run `step` and, when it fails in a way that may pass next time, run it again
 * after each delay in turn. The last error is rethrown as a `ProviderJobError`
 * carrying the classification and the attempt count.
 */
export async function withProviderRetries<T>(
  step: string,
  run: (attempt: number) => Promise<T>,
  classify: FailureClassifier,
  options: RetryOptions = {}
): Promise<T> {
  const delays = options.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = delays.length + 1;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run(attempt);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const failure = classify(error);
      const retry = options.shouldRetry ? options.shouldRetry(failure, error) : failure.retryable;
      if (!retry || attempt >= maxAttempts) {
        throw error instanceof ProviderJobError
          ? error
          : new ProviderJobError(failure, attempt, step, { cause: error });
      }
      const delayMs = delays[attempt - 1]!;
      options.onRetry?.({ step, attempt, maxAttempts, delayMs, failure });
      await sleep(delayMs, options.signal);
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Parse `<ENV>=10000,30000,60000`; blank keeps the default, `none` disables retries. */
export function parseRetryDelays(
  value: string | undefined,
  fallback: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
  envName = 'HAILUO_RETRY_DELAYS_MS'
): number[] {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '') return [...fallback];
  if (/^(none|off|0)$/i.test(trimmed)) return [];
  const delays = trimmed.split(',').map((part) => Number(part.trim()));
  if (delays.some((delay) => !Number.isInteger(delay) || delay < 0)) {
    throw new Error(`${envName} must be comma-separated non-negative integers (got "${value}")`);
  }
  return delays;
}
