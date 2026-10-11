import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  estimateVideoCost,
  HailuoApiError,
  isHailuoInsufficientCreditsError,
  signRequest
} from './hailuo-api.js';

const md5 = (value: string) => createHash('md5').update(value).digest('hex');

/** Independent re-implementation of the bundle's signer, to catch drift. */
function expectedYy(pathWithQuery: string, body: string, unix: string): string {
  return md5(`${encodeURIComponent(pathWithQuery)}_${body}${md5(unix)}ooui`);
}

describe('signRequest', () => {
  it('signs a GET with an empty body and the public params', () => {
    const { pathWithQuery, yy, body } = signRequest({
      path: '/v1/api/user/equity',
      method: 'GET',
      unix: '1777777777777'
    });

    expect(pathWithQuery).toBe(
      '/v1/api/user/equity?device_platform=web&app_id=3001&version_code=22203&biz_id=0&unix=1777777777777&lang=zh-Hans'
    );
    expect(body).toBe('{}');
    expect(yy).toBe(expectedYy(pathWithQuery, '{}', '1777777777777'));
  });

  it('signs a POST over the serialized body', () => {
    const payload = { quantity: 1, parameter: { modelID: 'hailuo3.0-i2v' } };
    const { pathWithQuery, yy, body } = signRequest({
      path: '/v2/api/multimodal/generate/video',
      method: 'POST',
      unix: '1777777777777',
      body: payload
    });

    expect(body).toBe(JSON.stringify(payload));
    expect(yy).toBe(expectedYy(pathWithQuery, body, '1777777777777'));
  });

  it('keeps a GET body out of the signature', () => {
    const withBody = signRequest({
      path: '/api/feed/detail',
      method: 'GET',
      unix: '1777777777777',
      body: { id: 'ignored' }
    });
    const withoutBody = signRequest({
      path: '/api/feed/detail',
      method: 'GET',
      unix: '1777777777777'
    });

    expect(withBody.yy).toBe(withoutBody.yy);
    expect(withBody.body).toBe('{}');
  });

  it('folds extra query params into the signed path', () => {
    const { pathWithQuery, yy } = signRequest({
      path: '/api/feed/detail',
      method: 'GET',
      unix: '1777777777777',
      query: { id: '546702744619728905' }
    });

    expect(pathWithQuery).toContain('id=546702744619728905');
    expect(yy).toBe(expectedYy(pathWithQuery, '{}', '1777777777777'));
  });

  it('adds uuid and device_id only when supplied', () => {
    const bare = signRequest({ path: '/x', method: 'GET', unix: '1' });
    const identified = signRequest({
      path: '/x',
      method: 'GET',
      unix: '1',
      publicParams: { uuid: 'u-1', deviceId: 'd-1' }
    });

    expect(bare.pathWithQuery).not.toContain('uuid=');
    expect(identified.pathWithQuery).toContain('uuid=u-1');
    expect(identified.pathWithQuery).toContain('device_id=d-1');
  });
});

describe('isHailuoInsufficientCreditsError', () => {
  it('recognizes credit rejection from the video submission endpoint', () => {
    expect(isHailuoInsufficientCreditsError(new HailuoApiError(
      1001,
      '贝壳不足，请充值后重试',
      '/v2/api/multimodal/generate/video'
    ))).toBe(true);
  });

  it('does not retry the same text from an unrelated endpoint', () => {
    expect(isHailuoInsufficientCreditsError(new HailuoApiError(
      1001,
      '贝壳不足',
      '/v1/api/user/equity'
    ))).toBe(false);
  });

  it('recognizes an English provider credit rejection', () => {
    expect(isHailuoInsufficientCreditsError(new HailuoApiError(
      1001,
      'Insufficient account balance',
      '/v2/api/multimodal/generate/video'
    ))).toBe(true);
  });

  it('does not classify an unrelated generation error as a credit rejection', () => {
    expect(isHailuoInsufficientCreditsError(new HailuoApiError(
      500,
      '内容审核失败',
      '/v2/api/multimodal/generate/video'
    ))).toBe(false);
  });
});

describe('estimateVideoCost', () => {
  const balance = { totalCredits: 252, breakdown: [] };

  it('prices MiniMax H3 by per-second resolution rates', () => {
    expect(estimateVideoCost(balance, {
      modelId: 'hailuo3.0-i2v', resolution: '768', duration: 15, quantity: 1
    })).toBe(105);
    expect(estimateVideoCost(balance, {
      modelId: 'hailuo3.0-i2v', resolution: '1440', duration: 4, quantity: 1
    })).toBe(48);
    expect(estimateVideoCost(balance, {
      modelId: 'hailuo3.0-i2v', resolution: '1440', duration: 15, quantity: 1
    })).toBe(180);
  });

  it('rejects unsupported MiniMax H3 options', () => {
    expect(estimateVideoCost(balance, {
      modelId: 'hailuo3.0-i2v', resolution: '1080', duration: 15, quantity: 1
    })).toBeUndefined();
    expect(estimateVideoCost(balance, {
      modelId: 'hailuo3.0-i2v', resolution: '768', duration: 16, quantity: 1
    })).toBeUndefined();
  });
});
