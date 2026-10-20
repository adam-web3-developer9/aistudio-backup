import { afterEach, describe, expect, it, vi } from 'vitest';
import { AigateClient, AigateError } from './aigate-client.js';

const instanceId = '1096749550260588544';
const token = 'private-test-token';
const instance = { instanceId, operationStatus: '2', instanceUtilList: [] };

function setup(body: unknown = { code: 0, data: instance, ok: true }, status = 200) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
  return { fetchMock, client: new AigateClient({ token, fetch: fetchMock }) };
}

afterEach(() => vi.useRealTimers());

describe('AigateClient', () => {
  it('does not request at construction and preserves int64 IDs and the official service fields', async () => {
    const { client, fetchMock } = setup({ code: 0, ok: true, data: {
      ...instance,
      instanceUtilList: [{ host: 'comfy.example', port: 8188, instancePort: '42429',
        protocol: 'TCP', httpType: '1', password: token, userAccount: 'root', config: 'secret' }]
    } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await client.getInstance(instanceId)).toEqual({ id: instanceId, status: '2', operationStatus: '2',
      services: [{ host: 'comfy.example', port: 8188, instancePort: 42429, protocol: 'TCP', httpType: '1' }] });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(`https://waas.aigate.cc/api/openapi/instance/get?instanceId=${instanceId}`);
    expect(init).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${token}` },
      redirect: 'error', cache: 'no-store' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['openInstance', 'closeInstance'] as const)('%s performs exactly one GET and returns void', async method => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 0, ok: true, data: null }));
    const client = new AigateClient({ token, fetch: fetchMock, baseUrl: 'https://control.example/' });
    expect(await client[method](instanceId)).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `https://control.example/api/openapi/instance/${method === 'openInstance' ? 'open' : 'close'}?instanceId=${instanceId}`
    );
  });

  describe('setGpuIdleShutdown', () => {
    it.each([null, true])('posts the fixed GPU idle policy with raw int64 precision and accepts data %s', async data => {
      vi.useFakeTimers();
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 0, ok: true, data }));
      const client = new AigateClient({ token, fetch: fetchMock, baseUrl: 'https://control.example/' });
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(client.setGpuIdleShutdown(instanceId)).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(String(url)).toBe('https://control.example/api/openapi/instance/setTimerStop');
      expect(init).toMatchObject({ method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: `{"instanceId":${instanceId},"stopType":"2","utilizationRate":10,"leisureTime":30}`,
        redirect: 'error', cache: 'no-store' });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body).replace(instanceId, '123'))).toEqual({ instanceId: 123, stopType: '2', utilizationRate: 10, leisureTime: 30 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['0', '1', '9007199254740993', '9223372036854775807'])('preserves canonical int64 %s as an unquoted JSON number', async id => {
      const { client, fetchMock } = setup({ code: 0, data: null });
      await client.setGpuIdleShutdown(id);
      const body = String(fetchMock.mock.calls[0]![1]?.body);
      expect(body).toBe(`{"instanceId":${id},"stopType":"2","utilizationRate":10,"leisureTime":30}`);
      expect(() => JSON.parse(body)).not.toThrow();
    });

    it.each(['', ' ', '01', '00', '-1', '+1', '1.0', '1e3', '0x10', '1\n', '1\r', ' 1', '1 ',
      '1,"stopType":"0"', '1&other=value', '9223372036854775808', '9999999999999999999', '1'.repeat(100),
      123, Number(instanceId), 1n, null, undefined])('rejects non-canonical or out-of-range IDs before transport %#', async id => {
      const { client, fetchMock } = setup();
      await expect(client.setGpuIdleShutdown(id as string)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([undefined, false, 'true', '2', 0, 1, {}, []])('rejects undocumented success data %#', async data => {
      const { client, fetchMock } = setup({ code: 0, ok: true, data });
      await expect(client.setGpuIdleShutdown(instanceId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([null, [], {}, { code: '0', data: true }, { code: 0.5, data: true }, { code: 0, ok: 'true', data: true }])(
      'rejects malformed setter envelopes %#', async body => {
        const { client, fetchMock } = setup(body);
        await expect(client.setGpuIdleShutdown(instanceId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      }
    );

    it.each([
      { code: 1, errCode: 'TEST_ONLY_CAPACITY_CODE', msg: 'GPU资源不足' },
      { code: 0, ok: false, msg: '无可用显卡' },
      { code: 1, msg: '实例未运行' },
      { code: 1, msg: '周期租用实例不支持该接口' },
      { code: 1, msg: token }
    ])('never classifies a rejected setter as unavailable capacity or exposes the provider message %#', async body => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
      const client = new AigateClient({ token, fetch: fetchMock, capacityErrorCodes: ['TEST_ONLY_CAPACITY_CODE'] });
      const error = await client.setGpuIdleShutdown(instanceId).catch(error => error);
      expect(error).toBeInstanceOf(AigateError);
      expect(error).toMatchObject({ code: 'BUSINESS_REJECTED', message: 'AIGate explicitly rejected the request' });
      expect(String(error)).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
      expect(error.cause).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each([302, 401, 403, 429, 500, 503])('rejects setter HTTP %i without retry or redirect', async status => {
      const { client, fetchMock } = setup({ code: 0, ok: true, data: true, msg: token }, status);
      await expect(client.setGpuIdleShutdown(instanceId)).rejects.toMatchObject({ code: 'HTTP_ERROR' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('error');
    });

    it('rejects non-JSON setter responses without exposing the response', async () => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(token));
      const client = new AigateClient({ token, fetch: fetchMock });
      await expect(client.setGpuIdleShutdown(instanceId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: 'Invalid AIGate response' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['fetch', 'body'])('sanitizes setter %s transport failures without retries', async phase => {
      const fetchMock = vi.fn<typeof fetch>();
      if (phase === 'fetch') fetchMock.mockRejectedValue(new Error(token));
      else fetchMock.mockResolvedValue({ ok: true, text: () => Promise.reject(new Error(token)) } as unknown as Response);
      const client = new AigateClient({ token, fetch: fetchMock });
      const error = await client.setGpuIdleShutdown(instanceId).catch(error => error);
      expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
      expect(String(error)).not.toContain(token);
      expect(error.cause).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it.each(['fetch', 'body'])('bounds setter %s time even if the transport ignores abort', async phase => {
      vi.useFakeTimers();
      const stalled = new Promise<never>(() => {});
      const fetchMock = vi.fn<typeof fetch>();
      if (phase === 'fetch') fetchMock.mockReturnValue(stalled);
      else fetchMock.mockResolvedValue({ ok: true, text: () => stalled } as unknown as Response);
      const client = new AigateClient({ token, fetch: fetchMock, timeoutMs: 20 });
      const result = expect(client.setGpuIdleShutdown(instanceId)).rejects.toMatchObject({ code: 'TIMEOUT' });
      await vi.advanceTimersByTimeAsync(20);
      await result;
      expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('returns the actual area without inferring a GPU model from skuId or maxGpuCount', async () => {
    const { client } = setup({ code: 0, data: { ...instance, areaName: '华东二区', skuId: 'test-sku',
      skuList: [{ maxGpuCount: 0 }], gpuModel: 'unverified' } });
    const actual = await client.getInstance(instanceId);
    expect(actual).toMatchObject({ areaName: '华东二区' });
    expect(actual).not.toHaveProperty('gpuModel');
    const absent = setup({ code: 0, data: { ...instance, areaName: null, gpuModel: null } });
    const details = await absent.client.getInstance(instanceId);
    expect(details).not.toHaveProperty('areaName');
    expect(details).not.toHaveProperty('gpuModel');
  });

  it.each([{ areaName: 1 }, { areaName: '' }, { areaName: {} }])(
    'rejects malformed upstream metadata %#', async metadata => {
      const { client } = setup({ code: 0, data: { ...instance, ...metadata } });
      await expect(client.getInstance(instanceId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  );

  it('prefers official instanceStatus over legacy status and operationStatus', async () => {
    const { client } = setup({ code: 0, data: { ...instance, instanceStatus: '22', status: '26', operationStatus: '11' } });
    expect(await client.getInstance(instanceId)).toMatchObject({ status: '22', operationStatus: '11' });
  });

  it.each([2, '', {}])('rejects malformed instanceStatus rather than silently falling back %#', async instanceStatus => {
    const { client } = setup({ code: 0, data: { ...instance, instanceStatus } });
    await expect(client.getInstance(instanceId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each(['TEST_ONLY_CAPACITY_CODE', 1234])('classifies an explicitly configured capacity errCode %s on open only', async errCode => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 1, errCode, msg: token }));
    const client = new AigateClient({ token, fetch: fetchMock, capacityErrorCodes: [String(errCode)] });
    const error = await client.openInstance(instanceId).catch(error => error);
    expect(error).toBeInstanceOf(AigateError);
    expect(error).toMatchObject({ code: 'CAPACITY_UNAVAILABLE', errCode: String(errCode) });
    expect(String(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
    expect(error.cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const method of ['getInstance', 'getInstanceStatus', 'closeInstance', 'setGpuIdleShutdown'] as const) {
      await expect(client[method](instanceId)).rejects.toMatchObject({ code: 'BUSINESS_REJECTED', errCode: String(errCode) });
    }
  });

  it.each([
    { errCode: 'TEST_ONLY_UNKNOWN', msg: 'GPU capacity unavailable' },
    { msg: '库存不足' }, { errCode: 1234, msg: '资源不足' }
  ])('does not infer capacity from undocumented codes or arbitrary messages %#', async rejection => {
    const { client, fetchMock } = setup({ code: 1, ...rejection });
    const error = await client.openInstance(instanceId).catch(error => error);
    expect(error).toMatchObject({ code: 'BUSINESS_REJECTED' });
    expect(error.errCode).toBe(rejection.errCode === undefined ? undefined : String(rejection.errCode));
    expect(error.message).toBe('AIGate explicitly rejected the request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['显卡资源不足', 'GPU库存已售罄', '算力暂无库存', '暂无可用的GPU', '无可用显卡', 'GPU资源暂时不可用'])(
    'recognizes explicit missing-GPU msg only on open: %s', async msg => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 1, msg }));
      const client = new AigateClient({ token, fetch: fetchMock });
      await expect(client.openInstance(instanceId)).rejects.toMatchObject({ code: 'CAPACITY_UNAVAILABLE' });
      for (const method of ['getInstance', 'getInstanceStatus', 'closeInstance', 'setGpuIdleShutdown'] as const) {
        await expect(client[method](instanceId)).rejects.toMatchObject({ code: 'BUSINESS_REJECTED' });
      }
      expect(fetchMock).toHaveBeenCalledTimes(5);
    }
  );

  it.each(['余额不足', '账户余额不足，无法开机', 'GPU实例开机失败：账户余额不足', '算力账户余额不足', 'GPU资源余额不足'])(
    'does not mistake insufficient balance for missing GPUs: %s', async msg => {
      const { client, fetchMock } = setup({ code: 1, msg });
      await expect(client.openInstance(instanceId)).rejects.toMatchObject({ code: 'BUSINESS_REJECTED' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('leaves unmatched rejections as business errors even with a configured capacity list', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code: 1, errCode: 'TEST_ONLY_DENIED' }));
    const client = new AigateClient({ token, fetch: fetchMock, capacityErrorCodes: ['TEST_ONLY_CAPACITY_CODE'] });
    await expect(client.openInstance(instanceId)).rejects.toMatchObject({ code: 'BUSINESS_REJECTED', errCode: 'TEST_ONLY_DENIED' });
  });

  it.each([token, token.toUpperCase(), 'PREFIX_' + token, 'Bearer ' + token,
    'message with spaces', 'unsafe\r\ncode', 'x'.repeat(101), {}, [], null, 1.5])(
    'drops unsafe upstream errCode without exposing messages %#', async errCode => {
      const { client } = setup({ code: 1, errCode, msg: token });
      const error = await client.openInstance(instanceId).catch(error => error);
      expect(error).toMatchObject({ code: 'BUSINESS_REJECTED' });
      expect(error.errCode).toBeUndefined();
      expect(String(error)).not.toContain(token);
      expect(JSON.stringify(error)).not.toContain(token);
    }
  );

  it('preserves unquoted int64 errCode without rounding or inventing a capacity classification', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"code":1,"errCode":9007199254740993}'));
    const client = new AigateClient({ token, fetch: fetchMock });
    await expect(client.openInstance(instanceId)).rejects.toMatchObject({ code: 'BUSINESS_REJECTED', errCode: '9007199254740993' });
  });

  it.each([['bad code'], [token], ['x'.repeat(101)], [1234], Array(101).fill('TEST_ONLY'), 'TEST_ONLY'].map(capacityErrorCodes => ({ capacityErrorCodes })))(
    'rejects an unsafe capacity code list without any request %#', async ({ capacityErrorCodes }) => {
      const fetchMock = vi.fn<typeof fetch>();
      expect(() => new AigateClient({ token, fetch: fetchMock, capacityErrorCodes: capacityErrorCodes as string[] })).toThrow(AigateError);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    null, [], {}, { code: '0' }, { code: 0, ok: 'true' },
    { code: 0, data: null }, { code: 0, data: { ...instance, instanceId: Number(instanceId) } },
    { code: 0, data: { ...instance, instanceId: '123' } },
    { code: 0, data: { ...instance, operationStatus: 2 } },
    { code: 0, data: { ...instance, instanceUtilList: {} } },
    { code: 0, data: { ...instance, instanceUtilList: [null] } },
    { code: 0, data: { ...instance, instanceUtilList: [{ host: '' }] } },
    { code: 0, data: { ...instance, instanceUtilList: [{ host: 'host', port: 65536 }] } },
    { code: 0, data: { ...instance, instanceUtilList: [{ host: 'host', instancePort: '8188bad' }] } },
    { code: 0, data: { ...instance, instanceUtilList: [{ host: 'host', protocol: 1 }] } }
  ])('rejects malformed envelopes and instance data %#', async body => {
    const { client } = setup(body);
    await expect(client.getInstance(instanceId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('accepts safe numeric IDs without precision loss and optional service fields', async () => {
    const { client } = setup({ code: 0, data: { instanceId: 123, status: 'running',
      instanceUtilList: [{ host: 'host', port: null, protocol: null }] } });
    expect(await client.getInstance('123')).toEqual({ id: '123', status: 'running', services: [{ host: 'host' }] });
  });

  it.each(['109674955026058855', instanceId])('preserves the unquoted int64 instanceId %s from raw JSON', async id => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(`{
      "code": 0, "ok": true, "data": {
        "instanceId": ${id}, "operationStatus": "22", "instanceUtilList": null
      }
    }`));
    const client = new AigateClient({ token, fetch: fetchMock });
    expect(await client.getInstance(id)).toEqual({ id, status: '22', operationStatus: '22', services: [] });
    expect(String(fetchMock.mock.calls[0]![0])).toContain(`instanceId=${id}`);
  });

  it.each([null, undefined, []])('normalizes absent tools on a stopped instance %#', async instanceUtilList => {
    const { client } = setup({ code: 0, data: { ...instance, operationStatus: '26', instanceUtilList } });
    expect(await client.getInstance(instanceId)).toMatchObject({ status: '26', services: [] });
  });

  it.each(['2', '22', '26', '13', '11', '4', 'unknown'])('reads status %s without implicitly opening', async status => {
    const { client, fetchMock } = setup({ code: 0, ok: true, data: status });
    expect(await client.getInstanceStatus(instanceId)).toBe(status);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      `https://waas.aigate.cc/api/openapi/instance/status?instanceId=${instanceId}`
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  });

  it.each([null, undefined, 2, {}, [], '', ' '])('rejects malformed status data %#', async data => {
    const { client } = setup({ code: 0, ok: true, data });
    await expect(client.getInstanceStatus(instanceId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([{ code: 1, msg: token }, { code: 0, ok: false, msg: token }])(
    'distinguishes explicit business rejection without exposing provider messages', async body => {
      const { client, fetchMock } = setup(body);
      const error = await client.openInstance(instanceId).catch(error => error);
      expect(error).toBeInstanceOf(AigateError);
      expect(error.code).toBe('BUSINESS_REJECTED');
      expect(String(error)).not.toContain(token);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each([401, 403, 429, 500, 503])('rejects HTTP %i even with a success envelope, without retries', async status => {
    const { client, fetchMock } = setup({ code: 0, ok: true, msg: token }, status);
    await expect(client.closeInstance(instanceId)).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects non-JSON without exposing the response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(token));
    await expect(new AigateClient({ token, fetch: fetchMock }).openInstance(instanceId))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE', message: 'Invalid AIGate response' });
  });

  it.each([undefined, {}, [], 2])('validates the operation response data %#', async data => {
    const { client } = setup({ code: 0, ok: true, data });
    await expect(client.openInstance(instanceId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('accepts the documented string operation response', async () => {
    const { client } = setup({ code: 0, data: '2' });
    await expect(client.openInstance(instanceId)).resolves.toBeUndefined();
  });

  it('sanitizes interrupted response body failures', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({ ok: true,
      text: () => Promise.reject(new Error(token)) } as unknown as Response);
    const error = await new AigateClient({ token, fetch: fetchMock }).closeInstance(instanceId).catch(error => error);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(error)).not.toContain(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('distinguishes unknown network outcomes without leaking errors or retrying', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error(token));
    const client = new AigateClient({ token, fetch: fetchMock });
    const error = await client.openInstance(instanceId).catch(error => error);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(String(error)).not.toContain(token);
    expect(error.cause).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['fetch', 'body'])('bounds %s time even if the injected transport ignores abort', async phase => {
    vi.useFakeTimers();
    const stalled = new Promise<never>(() => {});
    const fetchMock = vi.fn<typeof fetch>();
    if (phase === 'fetch') fetchMock.mockReturnValue(stalled);
    else fetchMock.mockResolvedValue({ ok: true, text: () => stalled } as unknown as Response);
    const client = new AigateClient({ token, fetch: fetchMock, timeoutMs: 20 });
    const result = expect(client.openInstance(instanceId)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await result;
    expect(fetchMock.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up the deadline on success', async () => {
    vi.useFakeTimers();
    const { client } = setup();
    await client.getInstance(instanceId);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['', ' ', '1&other=value', 123, Number(instanceId)])('rejects invalid or numeric input IDs %#', async id => {
    const { client, fetchMock } = setup();
    await expect(client.getInstance(id as string)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { token: '' }, { token: 'secret\r\n' }, { token, timeoutMs: 0 }, { token, timeoutMs: Infinity },
    { token, timeoutMs: 2_147_483_648 }, { token, baseUrl: 'invalid' },
    { token, baseUrl: 'https://user:secret@host' }
  ])('validates constructor options without a request %#', options => {
    const fetchMock = vi.fn<typeof fetch>();
    expect(() => new AigateClient({ ...options, fetch: fetchMock })).toThrow(AigateError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
