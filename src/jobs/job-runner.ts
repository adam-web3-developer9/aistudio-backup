import type { BrowserPool } from '../browser/browser-pool.js';
import type { AdapterRegistry } from '../adapters/adapter.js';
import type { AssetStore } from '../stores/asset-store.js';
import type { JobStore } from '../stores/job-store.js';
import type { SessionStore } from '../stores/session-store.js';
import type { JobProgressUpdate, JobRecord } from '../types.js';
import type { AccountLease, AccountPool } from './account-pool.js';
import { AccountBalanceUnavailableError, InsufficientCreditsError, NoAccountsError } from './account-pool.js';

export interface JobRunnerOptions {
  /** Service-owned asynchronous diagnostic context, including recovered jobs. */
  runInContext?: (jobId:string, run:() => Promise<void>) => Promise<void>;
  /** Budget for a browser-driven job. */
  timeoutMs: number;
  /** Budget for a direct API job, which polls a render that takes minutes. */
  directTimeoutMs: number;
  /** Fired once a job has reached succeeded/failed and its lease is released. */
  onJobSettled?: (job: JobRecord) => void;
  /** Independent submit guard for explicitly authorized video-gateway work. */
  beforeSubmitGuard?: (job: JobRecord) => Promise<void> | void;
  /** Transfers any durable pre-dispatch reservation after AccountPool owns it. */
  onAccountLeaseAcquired?: (job: JobRecord) => Promise<void> | void;
}

export interface RecoverySummary {
  /** Never reached an account before the restart; run again from scratch. */
  requeued: string[];
  /** Submitted at the provider; polling continues where it left off. */
  resumed: string[];
  /** Was running but had not reported a provider id, so the outcome is unknown. */
  interrupted: string[];
}

/**
 * Runs jobs as soon as they arrive; the wait happens on a resource, not a queue.
 *
 * Account jobs block on AccountPool capacity: each Hailuo account may hold
 * one rendering video plus one video in the provider queue.
 * Browser jobs block on the browser pool as before.
 */
export class JobRunner {
  private executionGuard?: (job: JobRecord) => Promise<void> | void;
  private readonly executing = new Set<string>();
  setExecutionGuard(guard: (job: JobRecord) => Promise<void> | void) { this.executionGuard = guard; }
  private async assertSubmitAllowed(job: JobRecord) {
    if (job.id.startsWith('job_system_') && !this.executionGuard) throw new JobError('EXECUTION_OWNER_REQUIRED', 'System execution owner is unavailable');
    if (job.id.startsWith('job_gateway_') && !this.options.beforeSubmitGuard) throw new JobError('EXECUTION_OWNER_REQUIRED', 'Video gateway execution is disabled');
    await this.options.beforeSubmitGuard?.(job);
    return this.executionGuard?.(job);
  }
  constructor(
    private readonly jobs: JobStore,
    private readonly assets: AssetStore,
    private readonly sessions: SessionStore,
    private readonly adapters: AdapterRegistry,
    private readonly browsers: BrowserPool,
    private readonly accounts: AccountPool,
    private readonly options: JobRunnerOptions
  ) {}

  submit(job: JobRecord): void {
    if (this.executing.has(job.id)) return;
    this.executing.add(job.id);
    void this.execute(job.id).finally(() => this.executing.delete(job.id));
  }

  /**
   * Pick up whatever a previous process left unfinished. Call once after the
   * stores are loaded and before the API starts accepting new work.
   */
  recover(): RecoverySummary {
    const summary: RecoverySummary = { requeued: [], resumed: [], interrupted: [] };

    for (const job of this.jobs.list()) {
      if (job.status === 'queued' && job.id.startsWith('job_system_')) {
        summary.interrupted.push(job.id);
        this.jobs.update(job.id, { status: 'failed', error: { code: 'INTERRUPTED', message: 'System execution requires reconciliation after restart' }, finishedAt: new Date().toISOString() });
      } else if (job.status === 'queued') {
        summary.requeued.push(job.id);
        this.submit(job);
      } else if (job.status === 'running') {
        if (job.progress?.providerJobId && job.sessionId) {
          summary.resumed.push(job.id);
          void this.resume(job.id);
        } else {
          // Re-running could pay for a second render if the submission did go
          // out; the caller can decide, we cannot.
          summary.interrupted.push(job.id);
          this.jobs.update(job.id, {
            status: 'failed',
            error: {
              code: 'INTERRUPTED',
              message: 'Service restarted before the job reached the provider; submit it again'
            },
            finishedAt: new Date().toISOString()
          });
        }
      }
    }
    return summary;
  }

  private async execute(jobId: string): Promise<void> {
    const run = () => this.executeInContext(jobId);
    return this.options.runInContext ? this.options.runInContext(jobId, run) : run();
  }

  private async executeInContext(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;

    let lease: AccountLease | undefined;
    let lastProviderCreditsError: Error | undefined;
    try {
      const adapter = this.adapters.get(job.adapterId);
      if (!adapter) throw new JobError('ADAPTER_NOT_FOUND', `Unknown adapter: ${job.adapterId}`);

      // No cap here: how many references a provider takes is the provider's
      // business, and each adapter trims to its own limit (Hailuo: 9).
      const preparedReferences = job.preparedReferences ?? [];
      const assetIds = preparedReferences.length ? [] : Array.from(new Set([job.assetId, ...(job.assetIds ?? [])]));
      const jobAssets = assetIds.map((assetId) => this.assets.get(assetId));
      const missingAssetIndex = jobAssets.findIndex((asset) => !asset);
      if (missingAssetIndex >= 0) {
        throw new JobError('ASSET_NOT_FOUND', `Unknown asset: ${assetIds[missingAssetIndex]}`);
      }
      const [asset, ...referenceAssets] = jobAssets;
      if (!preparedReferences.length && !asset) throw new JobError('ASSET_NOT_FOUND', `Unknown asset: ${job.assetId}`);

      const input = {
        text: job.text,
        imagePath: asset?.path ?? '',
        mimeType: asset?.mimeType,
        originalName: asset?.originalName,
        referenceImages: referenceAssets.map((referenceAsset) => ({
          imagePath: referenceAsset!.path,
          mimeType: referenceAsset!.mimeType,
          originalName: referenceAsset!.originalName
        })),
        preparedReferences,
        options: job.options,
        onProgress: (progress: JobProgressUpdate) => this.recordProgress(jobId, progress),
        beforeSubmit: async () => { await this.assertSubmitAllowed(this.jobs.get(jobId)!); },
        allowPaidRetries: !job.id.startsWith('job_system_') && !job.id.startsWith('job_gateway_')
      };

      // An adapter that can run over the API always needs an account; a browser
      // adapter only needs one when the caller asked for a specific session.
      const needsAccount = Boolean(adapter.runWithoutBrowser) || job.sessionId !== undefined;
      const rejectedSessionIds = new Set<string>();
      let started = false;
      let result: unknown;

      for (;;) {
        try {
          if (needsAccount) {
            lease = await this.accounts.acquire({
              adapterId: job.adapterId,
              sessionId: job.sessionId,
              excludeSessionIds: rejectedSessionIds,
              jobOptions: job.options
            });
            this.jobs.update(jobId, { sessionId: lease.sessionId });
            try { await this.options.onAccountLeaseAcquired?.(this.jobs.get(jobId)!); }
            catch { /* The expiring durable reservation may safely remain conservative. */ }
          }
        } catch (error) {
          if (error instanceof InsufficientCreditsError && job.id.startsWith('job_gateway_') && job.sessionId) {
            throw new JobError('ACCOUNT_INSUFFICIENT_CREDITS', error.message);
          }
          // Exclusions can leave no candidates after every provider-side credit
          // rejection. Preserve the useful upstream error instead of reporting
          // that the configured account pool disappeared.
          if (lastProviderCreditsError && error instanceof NoAccountsError) {
            throw new JobError('INSUFFICIENT_CREDITS', lastProviderCreditsError.message);
          }
          throw error;
        }

        const session = lease ? await this.sessions.get(lease.sessionId) : undefined;
        if (lease && !session) {
          throw new JobError('SESSION_NOT_FOUND', `Unknown session: ${lease.sessionId}`);
        }
        if (session && session.adapterId !== job.adapterId) {
          throw new JobError('SESSION_ADAPTER_MISMATCH', 'Session belongs to another adapter');
        }

        // Queue time is not run time: the clock starts once an account is held.
        this.jobs.update(jobId, {
          status: 'running',
          ...(!started && { startedAt: new Date().toISOString() }),
          creditsBefore: lease?.credits
        });
        started = true;

        try {
          await this.assertSubmitAllowed(this.jobs.get(jobId)!);
          const direct = session?.cookies.length
            ? adapter.runWithoutBrowser?.(session.cookies, input)
            : undefined;

          result = direct
            ? await withTimeout(direct, this.options.directTimeoutMs)
            : await this.browsers.use(async (browser) => {
              const context = await browser.newContext();
              try {
                if (session?.cookies.length) await context.addCookies(session.cookies);
                const page = await context.newPage();
                return await withTimeout(adapter.run(page, input), this.options.timeoutMs);
              } finally {
                await context.close();
              }
            });
          break;
        } catch (error) {
          if (error instanceof JobTimeoutError && lease) {
            // Promise.race timing out does not stop the provider-side render.
            // Keep this account slot occupied until the underlying operation
            // really settles, otherwise a third remote video could be submitted.
            const timedOutLease = lease;
            lease = undefined;
            void error.pending.finally(() => timedOutLease.release()).catch(() => undefined);
            throw error;
          }
          const insufficientCredits = adapter.isInsufficientCreditsError?.(error) === true;
          if (!insufficientCredits) throw error;
          if (!lease || job.sessionId !== undefined) {
            throw new JobError(
              job.id.startsWith('job_gateway_') ? 'ACCOUNT_INSUFFICIENT_CREDITS' : 'INSUFFICIENT_CREDITS',
              error instanceof Error ? error.message : String(error),
              (error as { providerTerminal?: boolean })?.providerTerminal
            );
          }

          lastProviderCreditsError = error instanceof Error ? error : new Error(String(error));
          rejectedSessionIds.add(lease.sessionId);
          lease.release();
          lease = undefined;
        }
      }

      this.jobs.update(jobId, {
        status: 'succeeded',
        result,
        finishedAt: new Date().toISOString()
      });
    } catch (error) {
      this.jobs.update(jobId, {
        status: 'failed',
        error: normalizeError(error),
        finishedAt: new Date().toISOString()
      });
    } finally {
      lease?.release();
      this.settled(jobId);
    }
  }

  /** Explicit reconciliation only: requires recorded upstream identity; never starts a new generation. */
  async resumeRecorded(jobId: string): Promise<void> {
    if (!this.jobs.get(jobId)?.progress?.providerJobId) throw new JobError('UPSTREAM_ID_REQUIRED', 'Recorded upstream identity is required');
    await this.resume(jobId);
  }

  /** An authorized gateway read can resume only an unresolved, already submitted task. */
  async resumeGatewayQuery(jobId: string): Promise<boolean> {
    const eligible = (job: JobRecord | undefined): job is JobRecord => !!job
      && job.id.startsWith('job_gateway_') && job.adapterId === 'miora-v1'
      && job.status === 'failed' && !!job.sessionId && !!job.progress?.providerJobId
      && (job.error?.providerTerminal === false || job.error?.providerTerminal === undefined
        && job.error?.code === 'ACCOUNT_INSUFFICIENT_CREDITS'
        && job.error.message === 'Miora /media-generate/progress failed (10005): Insufficient AI credits');
    const job = this.jobs.get(jobId);
    if (!eligible(job) || this.executing.has(jobId)) return false;
    await this.assertSubmitAllowed(job);
    if (!eligible(this.jobs.get(jobId)) || this.executing.has(jobId)) return false;
    this.jobs.update(jobId, { status:'running', error:undefined, finishedAt:undefined });
    void this.resume(jobId);
    return true;
  }

  /** Continue polling a render that the previous process had already submitted. */
  private async resume(jobId: string): Promise<void> {
    if (this.executing.has(jobId)) return;
    this.executing.add(jobId);
    const run = () => this.resumeInContext(jobId);
    try {
      await (this.options.runInContext ? this.options.runInContext(jobId, run) : run());
    } finally {
      this.executing.delete(jobId);
    }
  }

  private async resumeInContext(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job?.progress?.providerJobId || !job.sessionId) return;

    let lease: AccountLease | undefined;
    try {
      const adapter = this.adapters.get(job.adapterId);
      if (!adapter) throw new JobError('ADAPTER_NOT_FOUND', `Unknown adapter: ${job.adapterId}`);
      if (!adapter.resumeWithoutBrowser) {
        throw new JobError('INTERRUPTED', 'Adapter cannot resume a job after a restart; submit it again');
      }

      // The render still occupies one of this account's provider slots, so hold
      // a lease while it finishes. Credits were spent before the restart, hence
      // no price check. If the pool cannot lease (balance unreadable, account
      // removed) fall back to the stored session: the result matters more than
      // the slot accounting.
      lease = await this.accounts.acquire({
        adapterId: job.adapterId,
        sessionId: job.sessionId,
        requiredCredits: 0
      }).catch(() => undefined);
      if (lease) {
        try { await this.options.onAccountLeaseAcquired?.(job); }
        catch { /* The expiring durable reservation may safely remain conservative. */ }
      }

      const session = await this.sessions.get(job.sessionId);
      if (!session) {
        throw new JobError(
          'SESSION_NOT_FOUND',
          `Account ${job.sessionId} was removed while this job was running; `
          + `Hailuo video ${job.progress.providerJobId} may still have finished under that account`
        );
      }

      const pending = adapter.resumeWithoutBrowser(session.cookies, job.progress, {
        text: job.text,
        options: job.options,
        onProgress: (progress) => this.recordProgress(jobId, progress),
        beforeSubmit: async () => { await this.assertSubmitAllowed(this.jobs.get(jobId)!); },
        allowPaidRetries: !job.id.startsWith('job_system_') && !job.id.startsWith('job_gateway_')
      });
      if (!pending) {
        throw new JobError('INTERRUPTED', 'Session lacks the credentials needed to resume this job');
      }

      const result = await withTimeout(pending, this.options.directTimeoutMs);
      this.jobs.update(jobId, {
        status: 'succeeded',
        result,
        finishedAt: new Date().toISOString()
      });
    } catch (error) {
      if (error instanceof JobTimeoutError && lease) {
        const timedOutLease = lease;
        lease = undefined;
        void error.pending.finally(() => timedOutLease.release()).catch(() => undefined);
      }
      this.jobs.update(jobId, {
        status: 'failed',
        error: normalizeError(error),
        finishedAt: new Date().toISOString()
      });
    } finally {
      lease?.release();
      this.settled(jobId);
    }
  }

  private settled(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (job && this.options.onJobSettled) {
      try {
        this.options.onJobSettled(job);
      } catch {
        // A listener must not be able to break the runner.
      }
    }
  }

  private recordProgress(jobId: string, update: JobProgressUpdate): void {
    const current = this.jobs.get(jobId);
    if (!current) return;
    this.jobs.update(jobId, {
      progress: { ...current.progress, ...update, updatedAt: new Date().toISOString() }
    });
  }
}

class JobError extends Error {
  constructor(readonly code: string, message: string, readonly providerTerminal?: boolean) {
    super(message);
  }
}

class JobTimeoutError extends JobError {
  constructor(readonly pending: Promise<unknown>) {
    super('JOB_TIMEOUT', 'Automation timed out');
  }
}

type JobErrorRecord = NonNullable<JobRecord['error']>;

/**
 * An adapter error that already says what went wrong and whether it may pass
 * next time — the Hailuo adapter throws these once its own retries are spent.
 */
function isClassifiedError(error: unknown): error is Error & {
  code: string;
  retryable: boolean;
  attempts?: number;
  providerCode?: number | string;
  providerMessage?: string;
  providerTerminal?: boolean;
} {
  return error instanceof Error
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { retryable?: unknown }).retryable === 'boolean';
}

function normalizeError(error: unknown): JobErrorRecord {
  if (error instanceof JobError) return { code: error.code, message: error.message, retryable: false,
    ...(typeof error.providerTerminal === 'boolean' && { providerTerminal:error.providerTerminal }) };
  if (error instanceof InsufficientCreditsError) {
    return { code: error.code, message: error.message, retryable: false, accounts: error.accounts };
  }
  if (error instanceof AccountBalanceUnavailableError) {
    return {
      code: error.code,
      message: error.message,
      retryable: true,
      attempts: error.attempts,
      accounts: error.accounts
    };
  }
  if (error instanceof NoAccountsError) return { code: error.code, message: error.message, retryable: false };
  if (isClassifiedError(error)) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(typeof error.providerTerminal === 'boolean' && { providerTerminal:error.providerTerminal }),
      ...(error.attempts !== undefined && { attempts: error.attempts }),
      ...(error.providerCode !== undefined && { providerCode: error.providerCode }),
      ...(error.providerMessage !== undefined && { providerMessage: error.providerMessage })
    };
  }
  if (error instanceof Error) return { code: 'AUTOMATION_FAILED', message: error.message, retryable: false };
  return { code: 'AUTOMATION_FAILED', message: 'Unknown automation error', retryable: false };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new JobTimeoutError(promise)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
