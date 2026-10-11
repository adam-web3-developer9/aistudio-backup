import { describe, expect, it } from 'vitest';
import {
  describeDreamMakerToken,
  dreamMakerSessionId,
  dreamMakerTokenCookies,
  estimateVideoCost,
  parseCreditBalance,
  readDreamMakerToken,
  tokenExpiresAt,
  type DreamMakerPricingTable
} from './dreammaker-api.js';

/** A DreamMaker JWT: `sub` is the account, `exp` the deadline. The signature is irrelevant here. */
function jwt(sub: string, exp = 1_790_512_134): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub, iat: 1_789_907_334, exp })).toString('base64url');
  return `${header}.${payload}.sig`;
}

const pricing: DreamMakerPricingTable = {
  video: { unit: 'per_second', models: { 'minimax-h3': 500, 'doubao-seedance-2-5-260628': 1512 } },
  text2image: { unit: 'per_image', models: { 'doubao-seedream-5-0-lite-260128': 300 } }
};

describe('parseCreditBalance', () => {
  it('reads the decimal string total and keeps the buckets as breakdown', () => {
    const balance = parseCreditBalance({
      scope: 'personal',
      total: '45684.000000',
      buckets: [
        { credit_class: 'free', balance: '45684.000000' },
        { credit_class: 'recharge', balance: '0' }
      ]
    });

    expect(balance.totalCredits).toBe(45_684);
    expect(balance.breakdown).toEqual([
      { creditType: 0, credits: 45_684, record: { credit_class: 'free', balance: '45684.000000' } },
      { creditType: 1, credits: 0, record: { credit_class: 'recharge', balance: '0' } }
    ]);
  });

  it('rejects a response without a usable total', () => {
    expect(() => parseCreditBalance({ buckets: [] })).toThrow(/missing total/);
    expect(() => parseCreditBalance(null)).toThrow(/invalid response/);
  });
});

describe('estimateVideoCost', () => {
  it('bills video per second, so duration multiplies the unit price', () => {
    expect(estimateVideoCost(pricing, { modelId: 'minimax-h3', durationSeconds: 5 })).toBe(2_500);
    expect(estimateVideoCost(pricing, { modelId: 'minimax-h3', durationSeconds: 10 })).toBe(5_000);
    expect(estimateVideoCost(pricing, { modelId: 'doubao-seedance-2-5-260628', durationSeconds: 5 })).toBe(7_560);
  });

  it('multiplies by quantity', () => {
    expect(estimateVideoCost(pricing, { modelId: 'minimax-h3', durationSeconds: 5, quantity: 2 })).toBe(5_000);
  });

  it('has no opinion about a model or a table it does not know', () => {
    expect(estimateVideoCost(pricing, { modelId: 'not-listed', durationSeconds: 5 })).toBeUndefined();
    expect(estimateVideoCost(undefined, { modelId: 'minimax-h3', durationSeconds: 5 })).toBeUndefined();
    expect(estimateVideoCost(pricing, { modelId: 'minimax-h3', durationSeconds: 0 })).toBeUndefined();
  });
});

describe('access tokens', () => {
  it('decodes the account and the expiry from the JWT payload', () => {
    expect(describeDreamMakerToken(jwt('21574'))).toEqual({
      userId: '21574',
      expiresAt: new Date(1_790_512_134 * 1000).toISOString()
    });
    expect(tokenExpiresAt(jwt('21574'))).toBe(1_790_512_134 * 1000);
    expect(describeDreamMakerToken('not-a-jwt')).toBeUndefined();
  });

  it('derives a stable session id from the account, and hashes an opaque token', () => {
    expect(dreamMakerSessionId(jwt('21574'))).toBe('dreammaker-21574');
    // A re-login returns a different token for the same account: same id.
    expect(dreamMakerSessionId(jwt('21574', 1_799_999_999))).toBe('dreammaker-21574');
    expect(dreamMakerSessionId('opaque')).toMatch(/^dreammaker-[0-9a-f]{12}$/);
  });

  it('round-trips through the session cookie', () => {
    const cookies = dreamMakerTokenCookies('token-1', 'https://dreammaker.vobile.com.cn');
    expect(cookies[0]).toMatchObject({ name: 'access_token', domain: 'dreammaker.vobile.com.cn' });
    expect(readDreamMakerToken(cookies)).toBe('token-1');
    expect(readDreamMakerToken([])).toBeUndefined();
  });
});
