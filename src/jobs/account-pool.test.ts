import { describe, expect, it, vi } from 'vitest';
import {
  AccountBalanceUnavailableError,
  AccountPool,
  InsufficientCreditsError,
  NoAccountsError
} from './account-pool.js';
import { AdapterRegistry, type BrowserAdapter } from '../adapters/adapter.js';
import type { SessionStore } from '../stores/session-store.js';
import type { CreditBalance, SessionRecord } from '../types.js';

function session(id: string): SessionRecord {
  return {
    id,
    adapterId: 'test-v1',
    cookies: [{ name: '_token', value: `token-${id}`, domain: '.example.com', path: '/' }],
    updatedAt: '2026-08-20T00:00:00.000Z'
  };
}

function sessionStore(records: SessionRecord[]): SessionStore {
  return { list: async () => records } as unknown as SessionStore;
}

/** Adapter whose balance per session id is scripted by the test. */
function registry(
  balances: Record<string, number | Error>,
  cost = 10,
  costEstimateIsBinding?: boolean
): { adapters: AdapterRegistry; calls: string[] } {
  const calls: string[] = [];
  const adapter: BrowserAdapter = {
    id: 'test-v1',
    allowedCookieDomains: ['example.com'],
    ...(costEstimateIsBinding === undefined ? {} : { costEstimateIsBinding }),
    async getCreditsFromCookies(cookies): Promise<CreditBalance | undefined> {
      const token = cookies.find((c) => c.name === '_token')?.value ?? '';
      const id = token.replace('token-', '');
      calls.push(id);
      const value = balances[id];
      if (value instanceof Error) throw value;
      return { totalCredits: value ?? 0, breakdown: [] };
    },
    estimateJobCost: () => cost,
    run: async () => ({}),
    runWithoutBrowser: () => Promise.resolve({})
  };

  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  return { adapters, calls };
}

describe('AccountPool', () => {
  it('hands out two leases per account and queues the rest locally', async () => {
    const { adapters } = registry({ a: 100 });
    const pool = new AccountPool(sessionStore([session('a')]), adapters);

    const first = await pool.acquire({ adapterId: 'test-v1' });
    const second = await pool.acquire({ adapterId: 'test-v1' });
    expect(first.sessionId).toBe('a');
    expect(second.sessionId).toBe('a');

    let thirdResolved = false;
    const third = pool.acquire({ adapterId: 'test-v1' }).then((lease) => {
      thirdResolved = true;
      return lease;
    });

    await Promise.resolve();
    expect(thirdResolved).toBe(false);

    first.release();
    expect((await third).sessionId).toBe('a');
  });

  it('reserves credits so two slots cannot overspend one balance', async () => {
    const { adapters } = registry({ a: 50 }, 28);
    const pool = new AccountPool(sessionStore([session('a')]), adapters);

    const first = await pool.acquire({ adapterId: 'test-v1' });
    expect(first.sessionId).toBe('a');
    // 50 - 28 reserved leaves 22: the account is short of credits, not of
    // slots, so the job fails now instead of waiting for the first render.
    await expect(pool.acquire({ adapterId: 'test-v1' })).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('still waits for a busy account whose ledger can pay once a slot frees', async () => {
    const { adapters } = registry({ a: 100 }, 30);
    const pool = new AccountPool(sessionStore([session('a')]), adapters);

    const first = await pool.acquire({ adapterId: 'test-v1' });
    await pool.acquire({ adapterId: 'test-v1' });
    let thirdResolved = false;
    const third = pool.acquire({ adapterId: 'test-v1' }).then((lease) => { thirdResolved = true; return lease; });

    await Promise.resolve();
    expect(thirdResolved).toBe(false);
    first.release();
    expect((await third).sessionId).toBe('a');
  });

  it('fails at once when every account, busy or not, is short after reservations', async () => {
    const { adapters } = registry({ a: 120, b: 30 }, 100, false);
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters);

    expect((await pool.acquire({ adapterId: 'test-v1' })).sessionId).toBe('a');
    // Non-binding quote: accounts with anything left are still tried, fullest first…
    expect((await pool.acquire({ adapterId: 'test-v1' })).sessionId).toBe('b');
    expect((await pool.acquire({ adapterId: 'test-v1' })).sessionId).toBe('a');
    // …but once nothing is left to try, there is no waiting for renders.
    await expect(pool.acquire({ adapterId: 'test-v1' })).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('spreads first slots across accounts before using a second slot', async () => {
    const { adapters } = registry({ a: 100, b: 100 });
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters);

    const first = await pool.acquire({ adapterId: 'test-v1' });
    const second = await pool.acquire({ adapterId: 'test-v1' });

    expect([first.sessionId, second.sessionId].sort()).toEqual(['a', 'b']);

    first.release();
    const third = await pool.acquire({ adapterId: 'test-v1' });
    expect(third.sessionId).toBe(second.sessionId);
  });

  it('uses the affordable account that leaves the fewest credits after the job', async () => {
    const { adapters } = registry({ large: 100, almostEmpty: 50 }, 49);
    const pool = new AccountPool(
      sessionStore([session('large'), session('almostEmpty')]),
      adapters
    );

    const lease = await pool.acquire({ adapterId: 'test-v1' });

    expect(lease.sessionId).toBe('almostEmpty');
    expect(lease.credits).toBe(50);
  });

  it('skips accounts already rejected by the provider for this job', async () => {
    const { adapters } = registry({ low: 32, medium: 74, high: 91 }, 28);
    const pool = new AccountPool(
      sessionStore([session('low'), session('medium'), session('high')]),
      adapters
    );

    const lease = await pool.acquire({
      adapterId: 'test-v1',
      excludeSessionIds: new Set(['low'])
    });

    expect(lease.sessionId).toBe('medium');
  });

  it('does not lease the same account to concurrent acquires', async () => {
    const { adapters } = registry({ a: 50, b: 100 }, 49);
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters);

    const [first, second] = await Promise.all([
      pool.acquire({ adapterId: 'test-v1' }),
      pool.acquire({ adapterId: 'test-v1' })
    ]);

    expect(new Set([first.sessionId, second.sessionId])).toEqual(new Set(['a', 'b']));
  });

  it('reports the current balance for every configured token', async () => {
    const { adapters } = registry({ a: 50, b: 140 });
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters);

    const snapshot = await pool.snapshot({ refresh: true });

    expect(snapshot.map(({ sessionId, credits }) => ({ sessionId, credits })))
      .toEqual([
        { sessionId: 'a', credits: 50 },
        { sessionId: 'b', credits: 140 }
      ]);
  });

  it('reports active jobs and the two-job provider capacity', async () => {
    const { adapters } = registry({ a: 100 });
    const pool = new AccountPool(sessionStore([session('a')]), adapters);

    const first = await pool.acquire({ adapterId: 'test-v1' });
    const second = await pool.acquire({ adapterId: 'test-v1' });

    expect((await pool.snapshot())[0]).toMatchObject({
      busy: true,
      activeJobs: 2,
      capacity: 2
    });

    first.release();
    second.release();
  });

  it('skips an account that cannot pay and uses one that can', async () => {
    const { adapters } = registry({ a: 0, b: 100 }, 10);
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters);

    const lease = await pool.acquire({ adapterId: 'test-v1' });
    expect(lease.sessionId).toBe('b');
  });

  it('reports an account the first time it reads zero, and only once', async () => {
    const onExhausted = vi.fn();
    const { adapters } = registry({ a: 0 });
    const pool = new AccountPool(sessionStore([session('a')]), adapters, {
      creditsTtlMs: 0,
      onExhausted
    });

    await pool.snapshot({ refresh: true });
    await pool.snapshot({ refresh: true });

    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted.mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'a',
      credits: 0,
      exhausted: true,
      depleted: true
    });
  });

  it('reports balances below the retained-credit minimum once, but keeps the boundary', async () => {
    const onBelowMinimum = vi.fn();
    const { adapters } = registry({ zero: 0, low: 27, boundary: 28, high: 29 });
    const pool = new AccountPool(
      sessionStore([session('zero'), session('low'), session('boundary'), session('high')]),
      adapters,
      { creditsTtlMs: 0, minimumRetainedCredits: 28, onBelowMinimum }
    );

    await pool.snapshot({ refresh: true });
    await pool.snapshot({ refresh: true });

    expect(onBelowMinimum).toHaveBeenCalledTimes(2);
    expect(onBelowMinimum.mock.calls.map(([account]) => account.sessionId).sort())
      .toEqual(['low', 'zero']);
  });

  it('fails with the per-account detail when nothing can pay', async () => {
    const { adapters } = registry({ a: 0, b: 3 }, 10);
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters);

    await expect(pool.acquire({ adapterId: 'test-v1' })).rejects.toBeInstanceOf(InsufficientCreditsError);

    const error = await pool.acquire({ adapterId: 'test-v1' })
      .then(() => undefined, (e: unknown) => e) as InsufficientCreditsError;
    expect(error.code).toBe('INSUFFICIENT_CREDITS');
    expect(error.requiredCredits).toBe(10);
    expect(error.accounts.map((a) => [a.sessionId, a.credits])).toEqual([['a', 0], ['b', 3]]);
  });

  it('cleans only successfully read balances below the channel minimum', async () => {
    const balances: Record<string, number | Error> = { low: 26.47, boundary: 26.48, fractional: 26.9, failed: new Error('credits load failed'), other: 0 };
    const { adapters } = registry(balances);
    adapters.register({ id: 'other-v1', allowedCookieDomains: [],
      getCreditsFromCookies: async () => ({ totalCredits: 0, breakdown: [] }), run: async () => ({}) });
    const onBelowMinimum = vi.fn().mockResolvedValue(false);
    const pool = new AccountPool(sessionStore([
      ...['low', 'boundary', 'fractional', 'failed'].map(session),
      { ...session('other'), adapterId: 'other-v1' }
    ]), adapters, { creditsTtlMs: 0,
      minimumRetainedCredits: (id) => id === 'test-v1' ? 26.48 : undefined, onBelowMinimum });
    await pool.snapshot({ refresh: true });
    expect(onBelowMinimum).toHaveBeenCalledTimes(1);
    expect(onBelowMinimum.mock.calls[0]?.[0]).toMatchObject({ sessionId: 'low', credits: 26.47 });
    // A failed read after a previously low balance must not use the old reading to clean again.
    balances.low = new Error('later load failed');
    await pool.snapshot({ refresh: true });
    expect(onBelowMinimum).toHaveBeenCalledTimes(1);
  });

  it('retries cleanup on the next successful read if the file edit failed', async () => {
    const { adapters } = registry({ low: 1 });
    const onBelowMinimum = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const pool = new AccountPool(sessionStore([session('low')]), adapters,
      { creditsTtlMs: 0, minimumRetainedCredits: 26.48, onBelowMinimum });
    await pool.snapshot({ refresh: true });
    await pool.snapshot({ refresh: true });
    expect(onBelowMinimum).toHaveBeenCalledTimes(2);
  });

  it('does not lease an account retired by its successful credit read', async () => {
    const { adapters } = registry({ low: 20 }, 100, false);
    const pool: AccountPool = new AccountPool(sessionStore([session('low')]), adapters, {
      minimumRetainedCredits: 26.48,
      onBelowMinimum: (account) => pool.retire(account.sessionId)
    });
    await expect(pool.acquire({ adapterId: 'test-v1' })).rejects.toBeInstanceOf(InsufficientCreditsError);
    expect(pool.activeJobs('low')).toBe(0);
  });

  // Higgsfield prices a request that carries no media yet, so its quote can be
  // several times the bill. Refusing a batch on that number leaves accounts that
  // could have paid for all of it sitting idle; the provider is the judge.
  it('tries the fullest account anyway when the adapter says its quote is a guess', async () => {
    const { adapters } = registry({ a: 3, b: 40, c: 0 }, 90, false);
    const pool = new AccountPool(sessionStore([session('a'), session('b'), session('c')]), adapters);

    const lease = await pool.acquire({ adapterId: 'test-v1' });
    expect(lease.sessionId).toBe('b');

    // An account with nothing left is still no answer: with `b` excluded and the
    // rest empty or nearly so, only `a` can be tried, and then nothing remains.
    expect((await pool.acquire({ adapterId: 'test-v1', excludeSessionIds: new Set(['b']) })).sessionId).toBe('a');
    await expect(pool.acquire({ adapterId: 'test-v1', excludeSessionIds: new Set(['a', 'b']) }))
      .rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('rejects an unknown session and an adapter with no accounts', async () => {
    const { adapters } = registry({ a: 100 });
    const pool = new AccountPool(sessionStore([session('a')]), adapters);

    await expect(pool.acquire({ adapterId: 'test-v1', sessionId: 'nope' }))
      .rejects.toBeInstanceOf(NoAccountsError);
    await expect(pool.acquire({ adapterId: 'other-v1' }))
      .rejects.toBeInstanceOf(NoAccountsError);
  });

  it('re-reads the balance after a job releases the account', async () => {
    const { adapters, calls } = registry({ a: 100 });
    const pool = new AccountPool(sessionStore([session('a')]), adapters, { creditsTtlMs: 60_000 });

    (await pool.acquire({ adapterId: 'test-v1' })).release();
    await pool.acquire({ adapterId: 'test-v1' });

    // Cached within the TTL it would be 1; the release invalidates it.
    expect(calls).toEqual(['a', 'a']);
  });

  it('publishes the refreshed account balance after a job finishes', async () => {
    const balances = { a: 50 };
    const { adapters } = registry(balances);
    const updates: Array<Array<{ sessionId: string; credits?: number; busy: boolean }>> = [];
    const pool = new AccountPool(sessionStore([session('a')]), adapters, {
      onBalancesChanged: (accounts) => { updates.push(accounts); }
    });

    const lease = await pool.acquire({ adapterId: 'test-v1' });
    balances.a = 1;
    lease.release();

    await vi.waitFor(() => {
      expect(updates.at(-1)?.[0]).toMatchObject({ sessionId: 'a', credits: 1, busy: false });
    });
  });

  it('refreshes the displayed balance while other jobs on the account are still running', async () => {
    const balances = { a: 100 };
    const { adapters } = registry(balances);
    const updates: Array<Array<{ sessionId: string; credits?: number; busy: boolean }>> = [];
    const pool = new AccountPool(sessionStore([session('a')]), adapters, {
      creditsTtlMs: 60_000,
      onBalancesChanged: (accounts) => { updates.push(accounts); }
    });

    const first = await pool.acquire({ adapterId: 'test-v1' });
    await pool.acquire({ adapterId: 'test-v1' });
    balances.a = 90;
    first.release();

    await vi.waitFor(() => {
      expect(updates.at(-1)?.[0]).toMatchObject({ sessionId: 'a', credits: 90, busy: true });
    });
  });

  it('picks up accounts added to the session store and forgets removed ones', async () => {
    const records = [session('a')];
    const { adapters, calls } = registry({ a: 100, b: 40 });
    const pool = new AccountPool(sessionStore(records), adapters);
    await pool.snapshot({ refresh: true });

    records.push(session('b'));
    const refreshed = await pool.refresh(['b']);
    expect(refreshed.map(({ sessionId, credits }) => ({ sessionId, credits }))).toEqual([{ sessionId: 'b', credits: 40 }]);
    expect((await pool.snapshot()).map((a) => a.sessionId)).toEqual(['a', 'b']);

    records.shift();
    await pool.refresh([]);
    expect((await pool.snapshot()).map((a) => a.sessionId)).toEqual(['b']);
    expect(calls).toEqual(['a', 'b']);
  });

  it('re-reads the balance when an account gets a new token', async () => {
    const records = [session('a')];
    const { adapters, calls } = registry({ a: 100, 'a-rotated': 100 });
    const pool = new AccountPool(sessionStore(records), adapters, { creditsTtlMs: 60_000 });
    await pool.snapshot({ refresh: true });
    expect((await pool.snapshot())[0]?.creditsCheckedAt).toBeDefined();
    expect(calls).toEqual(['a']);

    records[0] = { ...session('a'), cookies: [{ name: '_token', value: 'token-a-rotated', domain: '.example.com', path: '/' }] };
    expect((await pool.snapshot())[0]?.creditsCheckedAt).toBeUndefined();

    // Cached reading is gone, so the next lease reads the new token's balance.
    await pool.acquire({ adapterId: 'test-v1' });
    expect(calls).toEqual(['a', 'a-rotated']);
  });

  it('does not pick an account whose balance cannot be read', async () => {
    const { adapters } = registry({ a: new Error('token expired'), b: 100 });
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters);

    const lease = await pool.acquire({ adapterId: 'test-v1' });
    expect(lease.sessionId).toBe('b');

    const snapshot = await pool.snapshot();
    expect(snapshot.find((a) => a.sessionId === 'a')?.lastError).toBe('token expired');
  });

  it('reports unreadable balances as a retryable outage, not as insufficient credits', async () => {
    const { adapters } = registry({ a: new Error('fetch failed'), b: new Error('fetch failed') });
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters, {
      creditsRetryDelaysMs: []
    });

    const error = await pool.acquire({ adapterId: 'test-v1' })
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(AccountBalanceUnavailableError);
    expect(error).toMatchObject({ code: 'ACCOUNT_BALANCE_UNAVAILABLE', retryable: true, attempts: 1 });
    expect((error as AccountBalanceUnavailableError).accounts.map((a) => [a.sessionId, a.lastError]))
      .toEqual([['a', 'fetch failed'], ['b', 'fetch failed']]);
    expect((error as Error).message).not.toMatch(/credits this job needs/);
  });

  it('does not cache a failed balance read for the TTL', async () => {
    const balances: Record<string, number | Error> = { a: new Error('fetch failed') };
    const { adapters, calls } = registry(balances);
    const pool = new AccountPool(sessionStore([session('a')]), adapters, {
      creditsTtlMs: 60_000,
      creditsRetryDelaysMs: []
    });

    await expect(pool.acquire({ adapterId: 'test-v1' })).rejects.toBeInstanceOf(AccountBalanceUnavailableError);

    // Hailuo answers again: the very next job must ask, not inherit the failure.
    balances.a = 100;
    const lease = await pool.acquire({ adapterId: 'test-v1' });
    expect(lease.sessionId).toBe('a');
    expect(calls).toEqual(['a', 'a']);
    expect((await pool.snapshot())[0]).toMatchObject({ credits: 100, lastError: undefined });
  });

  it('retries a network failure on the balance read before giving up on a job', async () => {
    // Hailuo is unreachable for the first two reads, then answers.
    let reads = 0;
    const adapter: BrowserAdapter = {
      id: 'test-v1',
      allowedCookieDomains: ['example.com'],
      async getCreditsFromCookies(): Promise<CreditBalance | undefined> {
        reads += 1;
        if (reads <= 2) throw new Error('fetch failed');
        return { totalCredits: 100, breakdown: [] };
      },
      estimateJobCost: () => 10,
      run: async () => ({}),
      runWithoutBrowser: () => Promise.resolve({})
    };
    const adapters = new AdapterRegistry();
    adapters.register(adapter);
    const pool = new AccountPool(sessionStore([session('a')]), adapters, {
      creditsRetryDelaysMs: [1, 1, 1]
    });

    const lease = await pool.acquire({ adapterId: 'test-v1' });
    expect(lease.sessionId).toBe('a');
    expect(lease.credits).toBe(100);
    expect(reads).toBe(3);
  });

  it('does not retry a balance read that failed for a non-network reason', async () => {
    const { adapters, calls } = registry({ a: new Error('token expired') });
    const pool = new AccountPool(sessionStore([session('a')]), adapters, {
      creditsRetryDelaysMs: [5, 5, 5]
    });

    await expect(pool.acquire({ adapterId: 'test-v1' })).rejects.toBeInstanceOf(AccountBalanceUnavailableError);
    expect(calls).toEqual(['a']);
  });

  it('still reports insufficient credits when every balance was read and none can pay', async () => {
    const { adapters } = registry({ a: 5, b: 3 }, 10);
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters, {
      creditsRetryDelaysMs: []
    });

    await expect(pool.acquire({ adapterId: 'test-v1' })).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('keeps a retired account for its running jobs and pinned resumes, but offers it to no new job', async () => {
    const { adapters } = registry({ a: 100, b: 100 });
    const pool = new AccountPool(sessionStore([session('a'), session('b')]), adapters);
    const running = await pool.acquire({ adapterId: 'test-v1', sessionId: 'a' });

    pool.retire('a');

    expect(pool.isRetired('a')).toBe(true);
    expect(pool.activeJobs('a')).toBe(1);
    expect((await pool.acquire({ adapterId: 'test-v1' })).sessionId).toBe('b');
    expect((await pool.acquire({ adapterId: 'test-v1' })).sessionId).toBe('b');
    // A resume pins its own session and must still get it.
    expect((await pool.acquire({ adapterId: 'test-v1', sessionId: 'a', requiredCredits: 0 })).sessionId).toBe('a');
    expect((await pool.snapshot()).find((account) => account.sessionId === 'a')).toMatchObject({ retired: true, activeJobs: 2 });

    running.release();
    pool.unretire('a');
    expect((await pool.snapshot()).find((account) => account.sessionId === 'a')?.retired).toBe(false);
  });
});
