import type { AdapterRegistry } from '../adapters/adapter.js';
import type { SessionStore } from '../stores/session-store.js';
import { DEFAULT_RETRY_DELAYS_MS, classifyHailuoError, sleep } from '../adapters/hailuo-retry.js';
import type {
  BrowserCookie,
  CreditBalance,
  JobOptions,
  ProviderAccount,
  SessionRecord
} from '../types.js';

export interface AccountSnapshot {
  sessionId: string;
  adapterId: string;
  /** Safe operator-facing token identifier: first 8 and last 8 characters. */
  tokenMasked?: string;
  account?: ProviderAccount;
  /** At least one job is running or queued at the provider on this account. */
  busy: boolean;
  /** Jobs currently submitted or being submitted with this account. */
  activeJobs: number;
  /** Maximum provider-side jobs allowed for this account. */
  capacity: number;
  credits?: number;
  creditsCheckedAt?: string;
  /** Last known balance was below what the pending job needs. */
  depleted: boolean;
  /** Balance is exactly 0 — the account is spent, not just short for one job. */
  exhausted: boolean;
  /**
   * Removed from the token file while jobs were still running on it. It keeps
   * serving those jobs (and resumes after a restart) but takes no new ones.
   */
  retired?: boolean;
  lastError?: string;
}

interface AccountState {
  session: SessionRecord;
  activeLeases: number;
  capacity: number;
  refreshing: boolean;
  /** Local spend ledger used while provider jobs overlap. */
  dispatchCredits?: number;
  balance?: CreditBalance;
  creditsCheckedAt?: number;
  depleted: boolean;
  exhausted: boolean;
  retired: boolean;
  lastUsedAt: number;
  lastError?: string;
  /** So a drained account is only announced once, not on every poll. */
  reportedExhausted: boolean;
  /** So a low-balance account is only offered for pruning once per low period. */
  reportedBelowMinimum: boolean;
}

export interface AccountLease {
  sessionId: string;
  cookies: BrowserCookie[];
  credits?: number;
  release(): void;
}

export interface AcquireRequest {
  adapterId: string;
  /** Pin to one account; otherwise the pool picks the free account with the least credits left after the job. */
  sessionId?: string;
  /** Accounts already rejected by the provider for this job. */
  excludeSessionIds?: ReadonlySet<string>;
  /** Overrides the adapter's own price estimate. */
  requiredCredits?: number;
  /** Passed to the adapter so it can price this specific job. */
  jobOptions?: JobOptions;
  signal?: AbortSignal;
}

export class NoAccountsError extends Error {
  readonly code = 'NO_ACCOUNTS_AVAILABLE';
  constructor(adapterId: string, sessionId?: string) {
    super(sessionId
      ? `Session ${sessionId} is not a usable ${adapterId} account`
      : `No ${adapterId} account is configured`);
  }
}

export class InsufficientCreditsError extends Error {
  readonly code = 'INSUFFICIENT_CREDITS';
  readonly retryable = false;
  constructor(readonly requiredCredits: number, readonly accounts: AccountSnapshot[]) {
    const detail = accounts
      .map((a) => `${a.sessionId}=${a.credits ?? '?'}`)
      .join(', ');
    super(`No account has the ${requiredCredits} credits this job needs (${detail})`);
  }
}

/**
 * The balance of every candidate account could not be read (network trouble
 * between this service and Hailuo, typically), so nothing can be said about
 * credits at all. Unlike `InsufficientCreditsError` this is transient: the
 * same job may go through once Hailuo answers again.
 */
export class AccountBalanceUnavailableError extends Error {
  readonly code = 'ACCOUNT_BALANCE_UNAVAILABLE';
  readonly retryable = true;
  constructor(readonly accounts: AccountSnapshot[], readonly attempts: number) {
    const detail = accounts
      .map((a) => `${a.sessionId}: ${a.lastError ?? (a.depleted ? `${a.credits ?? '?'} credits, not enough` : 'ok')}`)
      .join('; ');
    super(
      `Could not read the balance of any account${attempts > 1 ? ` after ${attempts} attempts` : ''}; `
      + `the job was not submitted (${detail})`
    );
  }
}

export interface AccountPoolOptions {
  /** How long a balance reading stays trusted. */
  creditsTtlMs?: number;
  /**
   * Back-off between tries of a balance read that failed on the network while
   * picking an account for a job; default 10s / 30s / 60s, `[]` disables it.
   * Operator-facing refreshes (`snapshot`, `refresh`) never wait.
   */
  creditsRetryDelaysMs?: readonly number[];
  /** One rendering job plus one provider-queued job. */
  maxJobsPerAccount?: number;
  /** Fired the first time an account is seen at exactly 0 credits. */
  onExhausted?: (snapshot: AccountSnapshot) => void;
  /** Accounts below this balance are no longer useful and may be removed from the source file. */
  minimumRetainedCredits?: number | ((adapterId: string) => number | undefined);
  onBelowMinimum?: (snapshot: AccountSnapshot, cookies: readonly BrowserCookie[]) => void | boolean | Promise<void | boolean>;
  /** Persists or publishes the latest balance table. */
  onBalancesChanged?: (snapshots: AccountSnapshot[]) => void | Promise<void>;
}

/**
 * Chooses which Hailuo account runs a job.
 *
 * Hailuo accepts two unfinished videos per account: one rendering and one in
 * its own queue. Further work remains queued locally until a lease is released.
 */
export class AccountPool {
  private readonly states = new Map<string, AccountState>();
  /** Session ids that finish their running jobs but are offered to no new one. */
  private readonly retiredIds = new Set<string>();
  private readonly waiters: Array<() => void> = [];
  private readonly creditsTtlMs: number;
  private readonly creditsRetryDelaysMs: readonly number[];
  private readonly maxJobsPerAccount: number;

  constructor(
    private readonly sessions: SessionStore,
    private readonly adapters: AdapterRegistry,
    private readonly options: AccountPoolOptions = {}
  ) {
    this.creditsTtlMs = options.creditsTtlMs ?? 60_000;
    this.creditsRetryDelaysMs = options.creditsRetryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.maxJobsPerAccount = options.maxJobsPerAccount ?? 2;
  }

  /** Pull in sessions added since the last call; drop ones that disappeared. */
  async sync(): Promise<void> {
    const stored = await this.sessions.list();
    const seen = new Set<string>();

    for (const session of stored) {
      seen.add(session.id);
      const existing = this.states.get(session.id);
      if (existing) {
        if (!sameCookies(existing.session.cookies, session.cookies)) {
          // Re-credentialed account: the cached balance belonged to the old token.
          existing.creditsCheckedAt = undefined;
          existing.lastError = undefined;
          existing.depleted = false;
          existing.exhausted = false;
          existing.reportedExhausted = false;
          existing.reportedBelowMinimum = false;
        }
        existing.session = session;
        continue;
      }
      this.states.set(session.id, {
        session,
        activeLeases: 0,
        capacity: this.maxJobsPerAccount,
        refreshing: false,
        depleted: false,
        exhausted: false,
        retired: this.retiredIds.has(session.id),
        reportedExhausted: false,
        reportedBelowMinimum: false,
        lastUsedAt: 0
      });
    }

    for (const [id, state] of this.states) {
      if (!seen.has(id) && state.activeLeases === 0) this.states.delete(id);
    }
  }

  /**
   * Stop handing this account to new automatic jobs while letting the ones
   * already running (or resuming after a restart) finish on it. Explicitly
   * pinned requests still get it — a resume pins its own session.
   */
  retire(sessionId: string): void {
    this.retiredIds.add(sessionId);
    const state = this.states.get(sessionId);
    if (state) state.retired = true;
  }

  /** The account is configured again (or gone for good): drop the retirement. */
  unretire(sessionId: string): void {
    this.retiredIds.delete(sessionId);
    const state = this.states.get(sessionId);
    if (state) state.retired = false;
  }

  isRetired(sessionId: string): boolean {
    return this.retiredIds.has(sessionId);
  }

  /** Jobs currently leased on this account, 0 when unknown. */
  activeJobs(sessionId: string): number {
    return this.states.get(sessionId)?.activeLeases ?? 0;
  }

  /**
   * Current state of every account. `refresh` forces a live balance check
   * (that is what surfaces a 0-credit account before any job is submitted).
   */
  async snapshot(options: { refresh?: boolean; adapterId?: string } = {}): Promise<AccountSnapshot[]> {
    await this.sync();
    const states = [...this.states.values()]
      .filter((state) => !options.adapterId || state.session.adapterId === options.adapterId);

    if (options.refresh) {
      await Promise.all(states.map((state) => this.readCredits(state, { force: true })));
      await this.publishBalances();
    }
    return states.map((state) => this.toSnapshot(state));
  }

  /**
   * Re-sync with the session store and force a live balance read for the named
   * accounts (typically ones just added or re-credentialed from the token file).
   * Accounts that disappeared are dropped and the balance table republished.
   */
  async refresh(sessionIds: readonly string[]): Promise<AccountSnapshot[]> {
    await this.sync();
    const states = sessionIds
      .map((id) => this.states.get(id))
      .filter((state): state is AccountState => Boolean(state));
    await Promise.all(states.map((state) => this.readCredits(state, { force: true })));
    await this.publishBalances();
    this.wakeWaiters();
    return states.map((state) => this.toSnapshot(state));
  }

  async acquire(request: AcquireRequest): Promise<AccountLease> {
    await this.sync();

    for (;;) {
      request.signal?.throwIfAborted();

      const candidates = [...this.states.values()].filter((state) =>
        state.session.adapterId === request.adapterId
        && (!request.sessionId || state.session.id === request.sessionId)
        && (request.sessionId !== undefined || !state.retired)
        && !request.excludeSessionIds?.has(state.session.id));

      if (!candidates.length) {
        throw new NoAccountsError(request.adapterId, request.sessionId);
      }

      // Keep LRU as the tie-breaker, but prefer the account that will have the
      // fewest credits left after this job. That drains small balances before
      // spending a large account (for example, a 49-credit job uses 50 first).
      // Accounts at capacity are priced too (from their cached balance): one
      // whose ledger cannot pay for this job is short of credits, not of slots,
      // and is not worth waiting for.
      const pricable = candidates
        .filter((state) => !state.refreshing)
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

      let required = request.requiredCredits ?? 1;
      const affordable: Array<{ state: AccountState; cost: number; remainingCredits: number }> = [];
      // Every account that could be priced at all, affordable or not: an adapter
      // whose quote is not binding draws its last resort from here.
      const considered: Array<{ state: AccountState; cost: number; spendableCredits: number }> = [];
      /** Busy accounts whose ledger, after what is already reserved, cannot pay for this job. */
      const shortOfCredits = new Set<AccountState>();
      const priced = await Promise.all(pricable.map(async (state) => {
        const balance = state.activeLeases > 0 && state.balance
          ? state.balance
          : await this.readCredits(state, { retry: true, signal: request.signal });
        if (!balance) return undefined; // unreadable; error recorded on the state

        // Price the job against this account's own table — it varies by plan,
        // and some providers can only answer over the network, hence the await.
        const estimated = request.requiredCredits
          ?? await this.adapters.get(request.adapterId)
            ?.estimateJobCost?.(balance, request.jobOptions, state.session.cookies);
        return { state, balance, cost: estimated ?? 1 };
      }));

      for (const item of priced) {
        if (!item) continue;
        const { state, balance, cost } = item;
        if (request.sessionId === undefined && state.retired) continue;
        required = Math.max(required, cost);

        const spendableCredits = state.activeLeases > 0
          ? state.dispatchCredits ?? 0
          : balance.totalCredits;
        if (spendableCredits < cost) {
          state.depleted = true;
          if (state.activeLeases > 0) shortOfCredits.add(state);
          if (state.activeLeases < this.maxJobsPerAccount) considered.push({ state, cost, spendableCredits });
          continue;
        }
        state.depleted = false;
        if (state.activeLeases >= this.maxJobsPerAccount) continue; // can pay, needs a free slot
        considered.push({ state, cost, spendableCredits });
        affordable.push({ state, cost, remainingCredits: spendableCredits - cost });
      }

      await this.publishBalances();

      if (affordable.length) {
        affordable.sort((a, b) =>
          a.state.activeLeases - b.state.activeLeases
          || a.remainingCredits - b.remainingCredits
          || a.state.lastUsedAt - b.state.lastUsedAt
          || a.state.session.id.localeCompare(b.state.session.id));
        // Another concurrent acquire may have leased a candidate while the
        // balance requests above were in flight. Check again before leasing.
        const selected = affordable.find(({ state, cost }) =>
          !state.refreshing
          && (request.sessionId !== undefined || !state.retired)
          && state.activeLeases < this.maxJobsPerAccount
          && (state.dispatchCredits ?? state.balance?.totalCredits ?? 0) >= cost);
        if (selected) return this.lease(selected.state, selected.cost);
      }

      // Wait only for an account that could still pay once a slot frees up.
      // Waiting on renders of an account that is short anyway would just delay
      // the same INSUFFICIENT_CREDITS by minutes; failing now lets the operator
      // add accounts instead.
      const anyUsable = candidates.some((state) =>
        (request.sessionId !== undefined || !state.retired) && (state.refreshing
        || (state.activeLeases > 0 && !shortOfCredits.has(state))
        || (!state.depleted && !state.lastError)));
      if (!anyUsable) {
        const snapshots = candidates.map((state) => this.toSnapshot(state));
        // "Cannot pay" is only a verdict when every balance was actually read.
        // A balance that could not be read says nothing about credits, so the
        // failure is reported as the outage it is, and as retryable.
        const unreadable = candidates.some((state) => state.lastError !== undefined && !state.depleted);
        if (unreadable) throw new AccountBalanceUnavailableError(snapshots, this.creditsRetryDelaysMs.length + 1);

        // Nothing clears the estimate — but for some adapters the estimate is a
        // guess at a request the job will not submit in that form, and failing
        // a whole batch on it strands work on accounts that could have paid for
        // every job in it. Hand the job to the account with the most credits and
        // let the provider be the judge: it charges what the job really costs,
        // and when it does refuse, the runner moves the job to the next account
        // and reports that refusal instead of this guess. Accounts with nothing
        // left are still no answer, and neither is a cost nobody could price.
        const speculative = this.adapters.get(request.adapterId)?.costEstimateIsBinding === false
          ? considered
            .filter(({ state, spendableCredits }) => spendableCredits > 0
              && (request.sessionId !== undefined || !state.retired)
              && !state.refreshing
              && state.activeLeases < this.maxJobsPerAccount)
            // Richest first: when the number cannot be trusted, the account most
            // likely to pay is the fullest one, not the one being drained.
            .sort((a, b) => b.spendableCredits - a.spendableCredits
              || a.state.lastUsedAt - b.state.lastUsedAt
              || a.state.session.id.localeCompare(b.state.session.id))[0]
          : undefined;
        if (speculative) {
          speculative.state.depleted = false;
          return this.lease(speculative.state, Math.min(speculative.cost, speculative.spendableCredits));
        }

        throw new InsufficientCreditsError(required, snapshots);
      }

      await this.waitForRelease(request.signal);
    }
  }

  private lease(state: AccountState, reservedCredits: number): AccountLease {
    const spendableCredits = state.dispatchCredits ?? state.balance?.totalCredits ?? 0;
    state.activeLeases += 1;
    state.dispatchCredits = spendableCredits - reservedCredits;
    state.lastUsedAt = Date.now();
    void this.publishBalances().catch(() => undefined);
    let released = false;

    return {
      sessionId: state.session.id,
      cookies: state.session.cookies,
      credits: state.balance?.totalCredits,
      release: () => {
        if (released) return;
        released = true;
        this.refreshAfterRelease(state);
      }
    };
  }

  private waitForRelease(signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        const index = this.waiters.indexOf(wake);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      this.waiters.push(wake);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Live balance unless a reading within the TTL exists. A failed read is never
   * cached: `creditsCheckedAt` is cleared so the next caller asks Hailuo again
   * instead of inheriting a stale "unreadable" verdict for a whole TTL. With
   * `retry`, network-class failures are tried again on the retry schedule
   * (what a job dispatch wants; operator refreshes return at once).
   */
  private async readCredits(
    state: AccountState,
    options: { force?: boolean; retry?: boolean; ledger?: boolean; signal?: AbortSignal } = {}
  ): Promise<CreditBalance | undefined> {
    const fresh = state.creditsCheckedAt !== undefined
      && Date.now() - state.creditsCheckedAt < this.creditsTtlMs;
    if (fresh && !options.force) return state.balance;

    const adapter = this.adapters.get(state.session.adapterId);
    const lookup = adapter?.getCreditsFromCookies;
    if (!lookup) {
      state.lastError = 'Adapter cannot read credits without a browser';
      state.creditsCheckedAt = undefined;
      return undefined;
    }

    const delays = options.retry ? this.creditsRetryDelaysMs : [];
    for (let attempt = 1; ; attempt += 1) {
      try {
        const cookies = state.session.cookies;
        const balance = await lookup.call(adapter, cookies);
        if (!balance) {
          state.lastError = 'Session is missing the credentials needed to read credits';
          state.creditsCheckedAt = undefined;
          return undefined;
        }
        state.balance = balance;
        state.creditsCheckedAt = Date.now();
        if (state.activeLeases === 0 && options.ledger !== false) state.dispatchCredits = balance.totalCredits;
        state.lastError = undefined;
        await this.trackBalanceStatus(state, cookies);
        return balance;
      } catch (error) {
        state.lastError = error instanceof Error ? error.message : String(error);
        state.creditsCheckedAt = undefined;
        if (options.signal?.aborted) return undefined;
        const kind = classifyHailuoError(error).kind;
        const transient = kind === 'network' || kind === 'provider_busy';
        if (!transient || attempt > delays.length) return undefined;
        try {
          await sleep(delays[attempt - 1]!, options.signal);
        } catch {
          return undefined; // aborted while waiting; the caller checks its own signal
        }
      }
    }
  }

  /**
   * Operator-facing view of one account. Who the credential belongs to is the
   * adapter's business: each channel stores a different kind of token.
   */
  private toSnapshot(state: AccountState): AccountSnapshot {
    const identity = this.adapters.get(state.session.adapterId)?.describeSession?.(state.session.cookies);
    return {
      sessionId: state.session.id,
      adapterId: state.session.adapterId,
      tokenMasked: identity?.tokenMasked,
      account: identity?.account,
      busy: state.activeLeases > 0,
      retired: state.retired,
      activeJobs: state.activeLeases,
      capacity: state.capacity,
      credits: state.balance?.totalCredits,
      creditsCheckedAt: state.creditsCheckedAt === undefined
        ? undefined
        : new Date(state.creditsCheckedAt).toISOString(),
      depleted: state.depleted,
      exhausted: state.exhausted,
      lastError: state.lastError
    };
  }

  private async publishBalances(): Promise<void> {
    await this.options.onBalancesChanged?.(
      [...this.states.values()].map((state) => this.toSnapshot(state))
    );
  }

  /** Refresh the account that just finished, then update the local balance table. */
  private refreshAfterRelease(state: AccountState): void {
    if (state.activeLeases > 1) {
      state.activeLeases -= 1;
      void this.publishBalances().catch(() => undefined);
      this.wakeWaiters();
      // An account that is never idle would otherwise show its first reading
      // forever. Refresh what the table displays, but leave the dispatch
      // ledger alone: other jobs on this account have not settled yet.
      void this.readCredits(state, { force: true, ledger: false })
        .then(() => this.publishBalances())
        .catch(() => undefined);
      return;
    }

    // Keep the local ledger until all overlapping provider jobs have settled;
    // only then can a live balance safely replace it without double counting.
    state.refreshing = true;
    state.creditsCheckedAt = undefined;
    void (async () => {
      const balance = await this.readCredits(state, { force: true });
      if (balance) state.dispatchCredits = balance.totalCredits;
      await this.publishBalances();
    })().catch(() => {
    }).finally(() => {
      state.refreshing = false;
      state.activeLeases = Math.max(0, state.activeLeases - 1);
      void this.publishBalances().catch(() => undefined);
      this.wakeWaiters();
    });
  }

  /** Capacity changes can satisfy different pinned waiters, so wake all to re-check. */
  private wakeWaiters(): void {
    const waiters = this.waiters.splice(0);
    waiters.forEach((wake) => wake());
  }

  /** Announce drained and permanently-too-small balances once per low period. */
  private async trackBalanceStatus(state: AccountState, cookies: readonly BrowserCookie[]): Promise<void> {
    const exhausted = state.balance?.totalCredits === 0;
    state.exhausted = exhausted;
    if (exhausted) state.depleted = true;

    if (exhausted && !state.reportedExhausted) {
      state.reportedExhausted = true;
      this.options.onExhausted?.(this.toSnapshot(state));
    }
    if (!exhausted) state.reportedExhausted = false;

    const configuredMinimum = this.options.minimumRetainedCredits;
    const minimum = typeof configuredMinimum === 'function'
      ? configuredMinimum(state.session.adapterId)
      : configuredMinimum;
    const belowMinimum = minimum !== undefined
      && state.balance !== undefined
      && state.balance.totalCredits < minimum;
    if (belowMinimum && !state.reportedBelowMinimum) {
      state.reportedBelowMinimum = true;
      const cleaned = await this.options.onBelowMinimum?.(this.toSnapshot(state), cookies);
      if (cleaned === false) state.reportedBelowMinimum = false;
    }
    if (!belowMinimum) state.reportedBelowMinimum = false;
  }
}

function sameCookies(a: readonly BrowserCookie[], b: readonly BrowserCookie[]): boolean {
  return a.length === b.length
    && a.every((cookie, index) => cookie.name === b[index]?.name && cookie.value === b[index]?.value);
}
