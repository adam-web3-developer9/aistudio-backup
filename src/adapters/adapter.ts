import type { Page } from 'playwright';
import type {
  BrowserCookie,
  CreditBalance,
  JobOptions,
  JobProgress,
  JobProgressUpdate,
  ProviderAccount
} from '../types.js';
export type { JobOptions };

/** How an account shows up in operator-facing listings. */
export interface SessionIdentity {
  /** Safe identifier for the stored credential — never the credential itself. */
  tokenMasked?: string;
  account?: ProviderAccount;
}

/** Enough of a token to tell accounts apart in a log, not enough to use it. */
export function maskToken(token: string): string {
  return `${token.slice(0, 8)}…${token.slice(-8)}`;
}

export interface AdapterInput {
  text: string;
  imagePath: string;
  mimeType?: string;
  originalName?: string;
  referenceImages?: Array<{
    imagePath: string;
    mimeType?: string;
    originalName?: string;
  }>;
  options?: JobOptions;
  /**
   * Called as the job advances (submitted at the provider, render percent...).
   * The runner persists what it receives, so report the provider job id as soon
   * as it exists — that is what makes the job resumable after a restart.
   */
  onProgress?: (progress: JobProgressUpdate) => void;
}

/** What a resumed job still knows about itself: no image files are needed to poll. */
export type ResumeInput = Pick<AdapterInput, 'text' | 'options' | 'onProgress'>;

export interface BrowserAdapter {
  readonly id: string;
  readonly allowedCookieDomains: readonly string[];
  /**
   * Who the stored credential belongs to, for `/v1/sessions` and `/v1/accounts`.
   * Each adapter keeps its credential in its own cookie under its own format,
   * so only the adapter can read it.
   */
  describeSession?(cookies: readonly BrowserCookie[]): SessionIdentity | undefined;
  getCredits?(page: Page): Promise<CreditBalance>;
  /** Optional browser-free credit lookup; returns undefined when the cookies are not enough. */
  getCreditsFromCookies?(cookies: readonly BrowserCookie[]): Promise<CreditBalance | undefined>;
  /**
   * What this job will cost on the account the balance belongs to — pricing is
   * per-plan, so it has to be asked per account. Undefined when unknown.
   *
   * `cookies` is the account's own credentials: some providers only price a
   * job through an authenticated call (DreamMaker quotes per model and
   * resolution), so the estimate may be asynchronous.
   */
  estimateJobCost?(
    balance: CreditBalance,
    options?: JobOptions,
    cookies?: readonly BrowserCookie[]
  ): number | undefined | Promise<number | undefined>;
  /**
   * Whether `estimateJobCost` may refuse a job on its own. Absent means yes.
   *
   * An adapter sets this false when its quote can price a different request
   * than the job will actually submit. The pool then stops treating the number
   * as a verdict: rather than failing a job no account can afford on paper, it
   * hands the job to the account with the most credits and lets the provider
   * be the judge, since only the provider knows the bill.
   * `isInsufficientCreditsError` is what catches a refusal that follows.
   */
  readonly costEstimateIsBinding?: boolean;
  /** True when the provider rejected a submission because this account cannot pay for it. */
  isInsufficientCreditsError?(error: unknown): boolean;
  /**
   * Optional browser-free job path. When present and the session carries the
   * credentials it needs, the runner uses it and never touches the browser pool.
   * Returns undefined to fall back to `run`.
   */
  runWithoutBrowser?(
    cookies: readonly BrowserCookie[],
    input: AdapterInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined;
  /**
   * Continue a job whose submission a previous process already made, using the
   * `progress` it persisted. Returns undefined when the progress lacks what is
   * needed (no provider id, no credentials).
   */
  resumeWithoutBrowser?(
    cookies: readonly BrowserCookie[],
    progress: JobProgress,
    input: ResumeInput,
    signal?: AbortSignal
  ): Promise<unknown> | undefined;
  run(page: Page, input: AdapterInput): Promise<unknown>;
}

export class AdapterRegistry {
  private readonly adapters = new Map<string, BrowserAdapter>();

  register(adapter: BrowserAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Duplicate adapter: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): BrowserAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): string[] {
    return [...this.adapters.keys()];
  }
}
