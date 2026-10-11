import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock, readSystemProxyMock, proxyAgents } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  readSystemProxyMock: vi.fn(),
  proxyAgents: [] as Array<{ url: string; close: ReturnType<typeof vi.fn> }>
}));
vi.mock('undici', () => ({
  fetch: fetchMock,
  ProxyAgent: class {
    readonly url: string;
    close = vi.fn().mockResolvedValue(undefined);
    constructor(readonly options: string | { uri: string }) {
      this.url = typeof options === 'string' ? options : options.uri;
      proxyAgents.push(this);
    }
  }
}));
vi.mock('./system-proxy.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./system-proxy.js')>();
  return {
    ...original,
    readWindowsSystemProxy: readSystemProxyMock,
    createSystemProxyResolver: (read = readSystemProxyMock, ttlMs?: number) =>
      original.createSystemProxyResolver(read, ttlMs)
  };
});

import { mioraRequest, refreshAuthToken, uploadToCos, useMioraProxy } from './miora-api.js';

const PRIMARY = 'http://primary.test:12321';
const LOCAL = 'http://127.0.0.1:7897';
const TASK = 'original-provider-task';
const BODY = { videoTaskIds: [TASK] };
const progress = (options = {}) => mioraRequest('token', '/media-generate/progress', {
  method: 'POST', body: BODY, ...options
});
const response = (status = 200, body: unknown = { data: { tasks: {} } }) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const network = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
const routes = () => fetchMock.mock.calls.map(([, options]) => options.dispatcher?.url ?? 'direct');
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  useMioraProxy(undefined, '');
  fetchMock.mockReset();
  readSystemProxyMock.mockReset().mockResolvedValue(undefined);
  proxyAgents.length = 0;
  useMioraProxy(PRIMARY, LOCAL);
});
afterEach(() => {
  useMioraProxy(undefined, '');
  vi.restoreAllMocks();
});

describe('Miora automatic system proxy and agent lifecycle', () => {
  it('follows system proxy port changes and disabling after the resolver cache expires', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const nextLocal = 'http://127.0.0.1:8888';
    readSystemProxyMock.mockResolvedValueOnce(LOCAL).mockResolvedValueOnce(nextLocal)
      .mockResolvedValueOnce(undefined);
    useMioraProxy(undefined, 'auto');
    fetchMock.mockImplementation(async () => response());

    await progress();
    const oldAgent = fetchMock.mock.calls[0]![1].dispatcher;
    now += 2001;
    await progress();
    const newAgent = fetchMock.mock.calls[1]![1].dispatcher;
    expect(oldAgent.close).toHaveBeenCalledOnce();
    expect(newAgent.close).not.toHaveBeenCalled();
    now += 2001;
    await progress();

    expect(routes()).toEqual([LOCAL, nextLocal, 'direct']);
    expect(readSystemProxyMock).toHaveBeenCalledTimes(3);
    expect(newAgent.close).toHaveBeenCalledOnce();
  });

  it.each([LOCAL, ''])('does not read the registry with an explicit local override %j', async (local) => {
    useMioraProxy(PRIMARY, local, '192.0.2.10');
    fetchMock.mockResolvedValueOnce(response());
    await progress();
    expect(routes()).toEqual([PRIMARY]);
    expect(readSystemProxyMock).not.toHaveBeenCalled();
  });

  it('deduplicates an automatically detected local proxy matching the primary', async () => {
    readSystemProxyMock.mockResolvedValue(LOCAL);
    useMioraProxy(LOCAL, 'auto');
    fetchMock.mockRejectedValueOnce(network('ECONNREFUSED')).mockResolvedValueOnce(response());
    await progress();
    expect(routes()).toEqual([LOCAL, 'direct']);
    expect(proxyAgents.filter((agent) => agent.url === LOCAL)).toHaveLength(1);
    expect(readSystemProxyMock).toHaveBeenCalledOnce();
  });

  it('does not read the registry for auxiliary API calls, token renewal or COS uploads', async () => {
    useMioraProxy(PRIMARY, 'auto');
    fetchMock.mockImplementation(async () => response(200, { access_token: 'renewed' }));
    for (const [path, method] of [
      ['/cos/sts-tokens', 'GET'],
      ['/cos/cdn-sign-url', 'POST'], ['/workflow/create', 'POST']
    ] as const) {
      await mioraRequest('token', path, { method });
    }
    await refreshAuthToken('refresh');
    await uploadToCos({
      prefix: 'references', bucket: 'bucket', region: 'ap-shanghai',
      token: 'sts-token', secret_id: 'sts-id', secret_key: 'sts-key'
    }, Buffer.from('reference'), 'image.png', 'image/png');
    expect(routes()).toEqual(Array(5).fill('direct'));
    expect(readSystemProxyMock).not.toHaveBeenCalled();
  });

  it('reuses the detected local agent across cached and refreshed system settings', async () => {
    let now = 10_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    readSystemProxyMock.mockResolvedValue(LOCAL);
    useMioraProxy(undefined, 'auto');
    fetchMock.mockImplementation(async () => response());
    await progress();
    await progress();
    now += 2001;
    await progress();
    const agents = fetchMock.mock.calls.map(([, options]) => options.dispatcher);
    expect(agents[1]).toBe(agents[0]);
    expect(agents[2]).toBe(agents[0]);
    expect(readSystemProxyMock).toHaveBeenCalledTimes(2);
    expect(proxyAgents.filter((agent) => agent.url === LOCAL)).toHaveLength(1);
    expect(agents[0].close).not.toHaveBeenCalled();
    useMioraProxy(undefined, '');
    expect(agents[0].close).toHaveBeenCalledOnce();
  });

  it('closes idle primary and local agents when the configuration is replaced', async () => {
    fetchMock.mockResolvedValueOnce(response());
    await progress();
    const primary = proxyAgents.find((agent) => agent.url === PRIMARY)!;
    const local = proxyAgents.find((agent) => agent.url === LOCAL)!;
    expect(primary.close).not.toHaveBeenCalled();
    expect(local.close).not.toHaveBeenCalled();
    useMioraProxy('http://replacement.test:3128', '');
    expect(primary.close).toHaveBeenCalledOnce();
    expect(local.close).toHaveBeenCalledOnce();
  });

  it('keeps an in-flight request on its old routes and closes agents only after its body is read', async () => {
    const enteredPrimary = deferred<void>();
    const primaryResponse = deferred<Response>();
    const enteredLocal = deferred<void>();
    const localBody = deferred<string>();
    const replacement = 'http://replacement.test:3128';
    fetchMock.mockImplementation(async (_url, options) => {
      if (options.dispatcher?.url === PRIMARY) {
        enteredPrimary.resolve();
        return primaryResponse.promise;
      }
      if (options.dispatcher?.url === LOCAL) {
        enteredLocal.resolve();
        return { status: 200, text: () => localBody.promise };
      }
      return response();
    });
    const pending = progress();
    await enteredPrimary.promise;
    const primary = proxyAgents.find((agent) => agent.url === PRIMARY)!;
    const local = proxyAgents.find((agent) => agent.url === LOCAL)!;
    useMioraProxy(replacement, '');
    expect(primary.close).not.toHaveBeenCalled();
    expect(local.close).not.toHaveBeenCalled();
    await progress();
    primaryResponse.reject(network('ECONNREFUSED'));
    await enteredLocal.promise;
    expect(primary.close).not.toHaveBeenCalled();
    expect(local.close).not.toHaveBeenCalled();
    localBody.resolve(JSON.stringify({ data: { tasks: {} } }));
    expect((await pending).status).toBe(200);
    expect(routes()).toEqual([PRIMARY, replacement, LOCAL]);
    expect(primary.close).toHaveBeenCalledOnce();
    expect(local.close).toHaveBeenCalledOnce();
  });

  it('keeps retired shared agents open until all concurrent requests have settled', async () => {
    const firstEntered = deferred<void>();
    const secondEntered = deferred<void>();
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    fetchMock.mockImplementationOnce(() => { firstEntered.resolve(); return firstResponse.promise; })
      .mockImplementationOnce(() => { secondEntered.resolve(); return secondResponse.promise; })
      .mockResolvedValue(response());
    const first = progress();
    const second = progress();
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    const primary = proxyAgents.find((agent) => agent.url === PRIMARY)!;
    const local = proxyAgents.find((agent) => agent.url === LOCAL)!;
    useMioraProxy(undefined, '');
    firstResponse.resolve(response());
    await first;
    expect(primary.close).not.toHaveBeenCalled();
    expect(local.close).not.toHaveBeenCalled();
    secondResponse.reject(network('ECONNREFUSED'));
    await second;
    expect(routes()).toEqual([PRIMARY, PRIMARY, LOCAL]);
    expect(primary.close).toHaveBeenCalledOnce();
    expect(local.close).toHaveBeenCalledOnce();
  });
});

describe('Miora transport fallback', () => {
  it('reads credits through the submission proxy routes while preserving the request', async () => {
    const balance = { total_amount: 100, used_amount: 40 };
    fetchMock.mockRejectedValueOnce(network('ECONNREFUSED'))
      .mockResolvedValueOnce(response(503, { message: 'temporarily unavailable' }))
      .mockResolvedValueOnce(response(200, balance));
    expect((await mioraRequest('token', '/quota/credit', { cookie: 'risk=1' })).json).toEqual(balance);
    expect(routes()).toEqual([PRIMARY, LOCAL, 'direct']);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe('https://miora.design/api/ai/quota/credit');
      expect(options.method).toBe('GET');
      expect(options.body).toBeUndefined();
      expect(options.headers.authorization).toBe('Bearer token');
      expect(options.headers.cookie).toBe('risk=1');
    }
  });

  it.each([400, 401])('does not switch credit routes for HTTP %i', async (status) => {
    fetchMock.mockResolvedValueOnce(response(status, { message: 'rejected' }));
    const request = mioraRequest('token', '/quota/credit');
    if (status === 401) await expect(request).rejects.toMatchObject({ name: 'MioraAuthError', status: 401 });
    else expect((await request).status).toBe(status);
    expect(routes()).toEqual([PRIMARY]);
  });

  it('tries primary, local and direct while preserving the original task body', async () => {
    fetchMock.mockRejectedValueOnce(network('ECONNREFUSED'))
      .mockRejectedValueOnce(network('ECONNRESET')).mockResolvedValueOnce(response());
    expect((await mioraRequest('token', '/media-generate/progress', { method: 'POST', body: BODY })).status).toBe(200);
    expect(routes()).toEqual([PRIMARY, LOCAL, 'direct']);
    for (const [url, options] of fetchMock.mock.calls) {
      expect(url).toBe('https://miora.design/api/ai/media-generate/progress');
      expect(JSON.parse(options.body)).toEqual(BODY);
      expect(options.headers.authorization).toBe('Bearer token');
    }
  });

  it.each([1, 2])('stops after successful outlet %i', async (outlet) => {
    if (outlet === 2) fetchMock.mockRejectedValueOnce(network('ECONNREFUSED'));
    fetchMock.mockResolvedValueOnce(response());
    await progress();
    expect(routes()).toEqual(outlet === 1 ? [PRIMARY] : [PRIMARY, LOCAL]);
  });

  it('uses the local proxy before direct when no primary proxy is configured', async () => {
    useMioraProxy(undefined, LOCAL);
    fetchMock.mockRejectedValueOnce(network('ECONNRESET')).mockResolvedValueOnce(response());
    await progress();
    expect(routes()).toEqual([LOCAL, 'direct']);
  });

  it('does not repeat the local proxy when it is also the primary proxy', async () => {
    useMioraProxy(LOCAL, LOCAL);
    fetchMock.mockRejectedValueOnce(network('ECONNREFUSED')).mockResolvedValueOnce(response());
    await progress();
    expect(routes()).toEqual([LOCAL, 'direct']);
  });

  it('does not change routes after a risk rejection of a generation submission', async () => {
    fetchMock.mockResolvedValueOnce(response(200, {
      code: 17001, failed: true, data: { reason: 'risk_rejected' }, message: '内容审核未通过，请调整后重试'
    }));
    expect((await mioraRequest('token', '/media-generate/video', { method: 'POST', body: { prompt: 'original prompt' } })).json)
      .toMatchObject({ code: 17001, data: { reason: 'risk_rejected' } });
    expect(routes()).toEqual([PRIMARY]);
  });

  it.each([
    { code: 0, data: { data: { taskId: 'accepted-task' } } },
    { code: 17001, failed: true, data: { reason: 'risk_rejected' }, httpStatus: 403 }
  ])('stops at the local proxy response after primary connection failure', async (body) => {
    const input = { prompt: 'original prompt', nodeId: 'original-node' };
    fetchMock.mockRejectedValueOnce(network('ECONNREFUSED')).mockResolvedValueOnce(response(200, body));
    expect((await mioraRequest('token', '/media-generate/video', { method: 'POST', body: input })).json).toEqual(body);
    expect(routes()).toEqual([PRIMARY, LOCAL]);
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([input, input]);
  });

  it('throws after all three outlets fail', async () => {
    const lastError = network('ECONNREFUSED');
    fetchMock.mockRejectedValue(lastError);
    await expect(progress()).rejects.toMatchObject({
      message: expect.stringContaining('Miora network request failed'), cause: lastError
    });
    expect(routes()).toEqual([PRIMARY, LOCAL, 'direct']);
  });

  it('preserves the last HTTP failure when every outlet responds with a retryable error', async () => {
    fetchMock.mockResolvedValueOnce(response(502)).mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(429, { message: 'rate limited' }));
    await expect(progress()).rejects.toMatchObject({
      name: 'MioraApiError', status: 429, apiMessage: expect.stringContaining('rate limited')
    });
    expect(routes()).toEqual([PRIMARY, LOCAL, 'direct']);
  });

  it.each([429, 500, 502, 503])('falls back from retryable HTTP %i on a status read', async (status) => {
    fetchMock.mockResolvedValueOnce(response(status, { message: 'temporarily unavailable' }))
      .mockResolvedValueOnce(response());
    expect((await progress()).status).toBe(200);
    expect(routes()).toEqual([PRIMARY, LOCAL]);
  });

  it.each([400, 403, 422])('does not switch outlets for business HTTP %i', async (status) => {
    fetchMock.mockResolvedValueOnce(response(status, { message: 'invalid request' }));
    expect((await progress()).status).toBe(status);
    expect(routes()).toEqual([PRIMARY]);
  });

  it('does not switch outlets for 401', async () => {
    fetchMock.mockResolvedValueOnce(response(401, { message: 'expired' }));
    await expect(progress()).rejects.toMatchObject({ name: 'MioraAuthError', status: 401 });
    expect(routes()).toEqual([PRIMARY]);
  });

  it('does not switch outlets for a 200 business error', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { code: 'INVALID_INPUT', message: 'invalid prompt' }));
    expect((await mioraRequest('token', '/media-generate/progress', { method: 'POST', body: BODY })).json)
      .toMatchObject({ code: 'INVALID_INPUT' });
    expect(routes()).toEqual([PRIMARY]);
  });

  it('stops immediately when the caller aborts during a failed request', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(async () => {
      controller.abort();
      throw network('ECONNREFUSED');
    });
    await expect(progress({ signal: controller.signal })).rejects.toBeDefined();
    expect(routes()).toEqual([PRIMARY]);
  });

  it('does not make a request with an already aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(progress({ signal: controller.signal })).rejects.toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['/media-generate/video', '/media-generate/image'])
    ('falls back for %s only when connection establishment failed', async (path) => {
      const body = { prompt: 'original prompt' };
      fetchMock.mockRejectedValueOnce(network('ECONNREFUSED')).mockResolvedValueOnce(response());
      await mioraRequest('token', path, { method: 'POST', body });
      expect(routes()).toEqual([PRIMARY, LOCAL]);
      expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([body, body]);
    });

  it.each(['ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'])
    ('allows a generation fallback for explicit connection failure %s', async (code) => {
      fetchMock.mockRejectedValueOnce(network(code)).mockResolvedValueOnce(response());
      await mioraRequest('token', '/media-generate/video', { method: 'POST', body: { prompt: 'original prompt' } });
      expect(routes()).toEqual([PRIMARY, LOCAL]);
    });

  it.each(['ECONNRESET', 'UND_ERR_SOCKET'])('does not resend generation after ambiguous network failure %s', async (code) => {
    fetchMock.mockRejectedValueOnce(network(code));
    await expect(mioraRequest('token', '/media-generate/video', { method: 'POST', body: { prompt: 'original prompt' } }))
      .rejects.toThrow('fetch failed');
    expect(routes()).toEqual([PRIMARY]);
  });

  it.each([429, 502])('does not resend generation after HTTP %i', async (status) => {
    fetchMock.mockResolvedValueOnce(response(status, { message: 'unavailable' }));
    expect((await mioraRequest('token', '/media-generate/video', { method: 'POST', body: { prompt: 'original prompt' } })).status).toBe(status);
    expect(routes()).toEqual([PRIMARY]);
  });

  it('refreshes tokens directly even when proxies are configured', async () => {
    fetchMock.mockResolvedValueOnce(response(200, { access_token: 'renewed' }));
    expect(await refreshAuthToken('refresh')).toMatchObject({ authToken: 'renewed' });
    expect(routes()).toEqual(['direct']);
    expect(fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
      { refresh_token: 'refresh' }
    ]);
  });

  it.each([
    { status: 400, body: { message: '无效的刷新令牌或令牌已过期' }, dead: true },
    { status: 401, body: { message: 'Please authenticate' }, dead: false },
    { status: 400, body: '<html>verification required</html>', dead: false },
    { status: 503, body: { message: '无效的刷新令牌或令牌已过期' }, dead: false }
  ])('classifies confirmed terminal refresh rejection ($status, dead=$dead)', async ({ status, body, dead }) => {
    fetchMock.mockResolvedValueOnce(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
    await expect(refreshAuthToken('refresh')).rejects.toMatchObject({
      status, path: '/api/auth/refresh-token', apiCode: dead ? 'REFRESH_TOKEN_DEAD' : undefined
    });
  });

  it('does not replay a token refresh after a socket failure', async () => {
    fetchMock.mockRejectedValueOnce(network('UND_ERR_SOCKET'));
    await expect(refreshAuthToken('refresh')).rejects.toThrow('fetch failed');
    expect(routes()).toEqual(['direct']);
  });

  it.each([
    ['/cloud-agent/media-models?lang=zh-CN', 'GET'],
    ['/cos/sts-tokens', 'GET'], ['/cos/cdn-sign-url', 'POST'],
    ['/workflow/list?page=1&pageSize=20', 'GET'], ['/workflow/create', 'POST'],
    ['/unknown-api', 'POST'], ['/media-generate/video', 'GET']
  ] as const)('keeps %s (%s) direct with configured proxies', async (path, method) => {
    fetchMock.mockResolvedValueOnce(response());
    await mioraRequest('token', path, { method });
    expect(routes()).toEqual(['direct']);
  });

  it.each(['/cos/sts-tokens'])('does not send %s through a proxy after direct failure', async (path) => {
    fetchMock.mockRejectedValueOnce(network('ECONNREFUSED'));
    await expect(mioraRequest('token', path)).rejects.toThrow('Miora network request failed');
    expect(routes()).toEqual(['direct']);
  });

  it('does not send token refresh through a proxy after direct connection refusal', async () => {
    fetchMock.mockRejectedValueOnce(network('ECONNREFUSED'));
    await expect(refreshAuthToken('refresh')).rejects.toThrow('Miora network request failed');
    expect(routes()).toEqual(['direct']);
  });

  it('uploads reference bytes directly to COS with configured proxies', async () => {
    fetchMock.mockResolvedValueOnce(response());
    await uploadToCos({
      prefix: 'references', bucket: 'bucket', region: 'ap-shanghai',
      token: 'sts-token', secret_id: 'sts-id', secret_key: 'sts-key'
    }, Buffer.from('reference'), 'image.png', 'image/png');
    expect(routes()).toEqual(['direct']);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://bucket.cos.ap-shanghai.myqcloud.com/references/image.png');
  });
});
