import { describe, expect, it } from 'vitest';
import {
  CREDIT_UNITS_PER_CREDIT,
  classifyClerkToken,
  describeHiggsfieldToken,
  higgsfieldSessionId,
  higgsfieldTokenCookies,
  parseCostTable,
  parseWallet,
  readHiggsfieldClientToken,
  readHiggsfieldSessionToken,
  tokenExpiresAt,
  walletToCreditBalance
} from './higgsfield-api.js';

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

/** What Clerk puts in the `__session` cookie: the user, the session, an expiry. */
const sessionToken = jwt({ sub: 'user_31abc', sid: 'sess_31xyz', iat: 1_789_907_334, exp: 1_789_907_394 });
/** What Clerk puts in the `__client` cookie: the client and its rotating token. */
const clientToken = jwt({ id: 'client_31kkk', rotating_token: 'rt_abc' });

describe('classifyClerkToken', () => {
  it('tells the two Clerk cookies apart by their claims', () => {
    expect(classifyClerkToken(sessionToken)).toBe('session');
    expect(classifyClerkToken(clientToken)).toBe('client');
  });

  it('recognises a client token that only carries a rotating token', () => {
    expect(classifyClerkToken(jwt({ rotating_token: 'rt_abc' }))).toBe('client');
  });

  it('has no opinion about a JWT that is neither', () => {
    expect(classifyClerkToken(jwt({ aud: 'someone-else' }))).toBeUndefined();
    expect(classifyClerkToken('not-a-jwt')).toBeUndefined();
  });
});

describe('higgsfieldSessionId', () => {
  it('names the account after the Clerk user or client, so it survives a new cookie', () => {
    expect(higgsfieldSessionId(sessionToken)).toBe('higgsfield-user_31abc');
    expect(higgsfieldSessionId(clientToken)).toBe('higgsfield-client_31kkk');
  });

  it('falls back to a hash when the token carries no identity', () => {
    expect(higgsfieldSessionId('opaque')).toMatch(/^higgsfield-[0-9a-f]{12}$/);
  });
});

describe('describeHiggsfieldToken / tokenExpiresAt', () => {
  it('reads the identity and the deadline off the payload', () => {
    expect(describeHiggsfieldToken(sessionToken)).toEqual({
      userId: 'user_31abc',
      expiresAt: new Date(1_789_907_394_000).toISOString()
    });
    expect(tokenExpiresAt(sessionToken)).toBe(1_789_907_394_000);
    expect(tokenExpiresAt(clientToken)).toBeUndefined();
  });
});

describe('higgsfieldTokenCookies', () => {
  it('stores the credential under its own cookie name', () => {
    const cookies = higgsfieldTokenCookies({ clientToken }, 'https://higgsfield.ai');
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: '__client', value: clientToken, domain: 'higgsfield.ai' });
    expect(readHiggsfieldClientToken(cookies)).toBe(clientToken);
    expect(readHiggsfieldSessionToken(cookies)).toBeUndefined();
  });

  it('carries a session token when that is all there is', () => {
    const cookies = higgsfieldTokenCookies({ sessionToken }, 'https://higgsfield.ai');
    expect(readHiggsfieldSessionToken(cookies)).toBe(sessionToken);
    expect(readHiggsfieldClientToken(cookies)).toBeUndefined();
  });
});

describe('parseWallet', () => {
  it('converts credit units to the whole credits the site shows', () => {
    const wallet = parseWallet({
      workspace_id: 'ws_1',
      subscription_balance: 250_000,
      credits_balance: 12_500,
      on_demand_credits: 5_000,
      next_credit_allocation_date: '2026-10-01T00:00:00Z'
    });

    expect(CREDIT_UNITS_PER_CREDIT).toBe(100);
    expect(wallet).toEqual({
      subscriptionCredits: 2_500,
      purchasedCredits: 125,
      onDemandCredits: 50,
      workspaceId: 'ws_1',
      nextAllocationAt: '2026-10-01T00:00:00Z'
    });
  });

  it('reads the camelCase spelling the web app also accepts', () => {
    expect(parseWallet({ subscriptionBalance: 100, creditsBalance: 100, onDemandCredits: 0 }))
      .toMatchObject({ subscriptionCredits: 1, purchasedCredits: 1, onDemandCredits: 0 });
  });

  it('treats a missing or negative field as nothing rather than failing', () => {
    expect(parseWallet({})).toMatchObject({ subscriptionCredits: 0, purchasedCredits: 0, onDemandCredits: 0 });
    expect(parseWallet({ credits_balance: -5 })).toMatchObject({ purchasedCredits: 0 });
  });

  it('rejects a response that is not an object', () => {
    expect(() => parseWallet(null)).toThrow(/invalid response/);
    expect(() => parseWallet([])).toThrow(/invalid response/);
  });
});

describe('walletToCreditBalance', () => {
  it('counts subscription and purchased credits, and only reports the on-demand meter', () => {
    const balance = walletToCreditBalance({
      subscriptionCredits: 2_500,
      purchasedCredits: 125,
      onDemandCredits: 50
    });

    expect(balance.totalCredits).toBe(2_625);
    expect(balance.breakdown.map((entry) => entry.credits)).toEqual([2_500, 125, 50]);
    expect(balance.breakdown[2]!.record).toEqual({ source: 'on_demand', spendable: false });
  });
});

describe('parseCostTable', () => {
  it('reads a list of generators and converts the units', () => {
    expect(parseCostTable([
      { job_set_type: 'seedance', cost: 3_000 },
      { type: 'minimax_hailuo', credits: 2_500 }
    ])).toEqual({ seedance: 30, minimax_hailuo: 25 });
  });

  it('unwraps the {data} envelope', () => {
    expect(parseCostTable({ data: [{ jobSetType: 'kling', price: 800 }] })).toEqual({ kling: 8 });
  });

  it('skips a row it cannot read rather than guessing a price', () => {
    expect(parseCostTable([{ job_set_type: 'seedance' }, { cost: 100 }, 'nonsense', null]))
      .toEqual({});
    expect(parseCostTable(undefined)).toEqual({});
  });
});
