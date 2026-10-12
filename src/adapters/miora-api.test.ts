import { describe, expect, it } from 'vitest';
import { MioraApiError } from './miora-api.js';
import { classifyMioraError } from './miora-retry.js';
import {
  cosAuth,
  describeMioraToken,
  hasUsableScopes,
  mioraSessionId,
  mioraTokenCookies,
  prepareCosUpload,
  parseCreditBalance,
  readMioraTokens,
  tokenExpiresAt,
  tokenLifetimeMs
} from './miora-api.js';

describe('COS upload request', () => {
  it('signs one exact key and never returns the STS secret', () => {
    const request = prepareCosUpload({ prefix: 'refs/user', bucket: 'bucket', region: 'ap-shanghai',
      token: 'temporary-token', secret_id: 'temporary-id', secret_key: 'must-not-leak' },
    'abc.png', 'image/png', 123, 1_700_000_000);
    expect(request.key).toBe('refs/user/abc.png');
    expect(request.headers['content-length']).toBe('123');
    expect(JSON.stringify(request)).not.toContain('must-not-leak');
    expect(request.headers.authorization).toContain('q-header-list=content-length;content-type;host;x-cos-security-token');
  });
});

/** A syntactically valid JWT with arbitrary claims (signature is not verified). */
function makeToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${payload}.AAAA`;
}

describe('token decoding', () => {
  const now = Math.floor(Date.now() / 1000);
  const token = makeToken({ sub: '727634066104300', iat: now, exp: now + 15 * 86400, scopes: ['*'] });

  it('reads the subject and expiry', () => {
    const account = describeMioraToken(token);
    expect(account?.userId).toBe('727634066104300');
    expect(Date.parse(account!.expiresAt!)).toBeGreaterThan(Date.now());
  });

  it('derives a stable session id from the subject', () => {
    expect(mioraSessionId(token)).toBe('miora-727634066104300');
  });

  it('distinguishes scoped from scopeless tokens', () => {
    expect(hasUsableScopes(token)).toBe(true);
    expect(hasUsableScopes(makeToken({ sub: 'x', scopes: [] }))).toBe(false);
    expect(hasUsableScopes(makeToken({ sub: 'x' }))).toBe(false);
  });

  it('reports expiry and lifetime', () => {
    expect(tokenExpiresAt(token)).toBeGreaterThan(Date.now());
    expect(tokenLifetimeMs(token)).toBe(15 * 86400 * 1000);
  });
});

describe('credit balance', () => {
  it('accepts numeric strings and real zero balances', () => {
    expect(parseCreditBalance({ data: { total_amount: '100', used_amount: '40', nextExpiring: { credit: '0' } } }).totalCredits).toBe(0);
    expect(parseCreditBalance({ total_amount: 0, used_amount: 0 }).totalCredits).toBe(0);
    expect(parseCreditBalance({ total_amount: '100', used_amount: '40' }).totalCredits).toBe(60);
  });

  it.each([
    null, {}, [], { data: null }, { message: 'Too many requests' },
    { total_amount: '', used_amount: 0 },
    { total_amount: null, used_amount: 0 },
    { total_amount: true, used_amount: 0 },
    { total_amount: 'invalid', used_amount: 0 },
    { total_amount: Infinity, used_amount: 0 },
    { total_amount: -1, used_amount: 0 },
    { total_amount: 100 },
    { total_amount: 100, used_amount: 0, nextExpiring: { credit: 'invalid' } }
  ])('rejects invalid credit payload %j', (payload) => {
    expect(() => parseCreditBalance(payload)).toThrow(MioraApiError);
  });

  it('preserves API error information rather than returning zero', () => {
    try {
      parseCreditBalance({ code: 'RATE_LIMIT', message: 'Too many requests' }, 429);
      throw new Error('Expected credit parsing to fail');
    } catch (error) {
      expect(error).toMatchObject({ name: 'MioraApiError', status: 429, apiCode: 'RATE_LIMIT', apiMessage: 'Too many requests' });
    }
  });

  it('uses the next-expiring figure as the spendable amount', () => {
    const balance = parseCreditBalance({
      data: { total_amount: 500, used_amount: 100, nextExpiring: { credit: 380 } }
    });
    expect(balance.totalCredits).toBe(380);
  });

  it('falls back to total minus used', () => {
    const balance = parseCreditBalance({ total_amount: 100, used_amount: 40 });
    expect(balance.totalCredits).toBe(60);
  });

  it('uses total minus used when next-expiring credit is null', () => {
    const balance = parseCreditBalance({
      data: { total_amount: 100, used_amount: 40, nextExpiring: { credit: null } }
    });
    expect(balance.totalCredits).toBe(60);
  });
});

describe('session cookies', () => {
  it('round-trips both tokens', () => {
    const cookies = mioraTokenCookies({ authToken: 'eyJ.a.b', refreshToken: 'def50200xyz' });
    expect(cookies.every((cookie) => cookie.domain === 'miora.design')).toBe(true);
    const read = readMioraTokens(cookies);
    expect(read).toEqual({ authToken: 'eyJ.a.b', refreshToken: 'def50200xyz' });
  });

  it('works with only an authToken', () => {
    const cookies = mioraTokenCookies({ authToken: 'eyJ.a.b' });
    expect(readMioraTokens(cookies)).toEqual({ authToken: 'eyJ.a.b' });
  });

  it('round-trips the site cookie string', () => {
    const cookie = 'TDID=1; 4bbe2d16=abc; authToken=eyJ.a.b';
    const cookies = mioraTokenCookies({ authToken: 'eyJ.a.b', refreshToken: 'def50200x', cookie });
    expect(readMioraTokens(cookies)).toEqual({ authToken: 'eyJ.a.b', refreshToken: 'def50200x', cookie });
  });
});

describe('error classification', () => {
  it('does not retry the platform prompt-length limit', () => {
    const error = new MioraApiError(
      400,
      undefined,
      'Model minimax-h3 prompt length 2871 exceeds the limit of 2000 characters; please shorten your prompt',
      '/media-generate/video'
    );
    const failure = classifyMioraError(error);
    expect(failure.retryable).toBe(false);
  });
});

describe('cosAuth', () => {
  const input = {
    secretId: 'AKIDxxx',
    secretKey: 'sk-yyy',
    method: 'put' as const,
    pathname: '/prefix/a1.png',
    headers: {
      host: 'bucket.cos.ap-shanghai.myqcloud.com',
      'content-type': 'image/png',
      'content-length': '1024',
      'x-cos-security-token': 'tok'
    },
    keyTime: '1700000000;1700000600'
  };

  it('is deterministic for the same inputs', () => {
    expect(cosAuth(input)).toBe(cosAuth(input));
  });

  it('lists the signed headers lowercased and sorted', () => {
    const signature = cosAuth(input);
    expect(signature).toContain('q-sign-algorithm=sha1&q-ak=AKIDxxx');
    expect(signature).toContain(
      'q-header-list=content-length;content-type;host;x-cos-security-token'
    );
    expect(signature).toMatch(/&q-signature=[0-9a-f]{40}$/);
  });
});
