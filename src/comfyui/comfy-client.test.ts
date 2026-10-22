import { describe, expect, it, vi } from 'vitest';
import { ComfyClient, ComfyError } from './comfy-client.js';

const file = { filename: 'result.png', subfolder: 'attempt/one', type: 'output' };
const input = { graph: { '1': { class_type: 'Example', inputs: {} } }, attemptId: 'attempt', promptId: 'prompt' };
const queued = (promptId: string, marker = 'attempt') => [0, promptId, {}, { hailuoAttemptId: marker }, []];

function setup(...responses: Array<Response | Error>) {
  const fetcher = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) fetcher.mockRejectedValueOnce(response);
    else fetcher.mockResolvedValueOnce(response);
  }
  return { fetcher, client: new ComfyClient({ baseUrl: 'https://comfy.example', headers: { Authorization: 'secret' }, fetch: fetcher }) };
}

describe('ComfyClient native contract', () => {
  it('checks health and parses native queue tuples', async () => {
    const { client, fetcher } = setup(Response.json({}), Response.json({ queue_running: [queued('run')], queue_pending: [queued('wait', 'other')] }));
    await client.health();
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://comfy.example/system_stats');
    await expect(client.queue()).resolves.toEqual({ running: [{ promptId: 'run', marker: 'attempt' }], pending: [{ promptId: 'wait', marker: 'other' }] });
  });

  it('submits once with explicit identifiers and marker', async () => {
    const { client, fetcher } = setup(Response.json({ prompt_id: 'prompt' }));
    await expect(client.submit(input)).resolves.toEqual({ promptId: 'prompt' });
    expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({ prompt: input.graph, extra_data: { hailuoAttemptId: 'attempt' }, prompt_id: 'prompt', client_id: 'attempt' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('returns the actual ack id when an older server ignores the requested id', async () => {
    const { client, fetcher } = setup(Response.json({ prompt_id: 'server-generated-id' }));
    await expect(client.submit(input)).resolves.toEqual({ promptId: 'server-generated-id' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error('secret headers and URL must not leak'),
    new Response('lost body'),
    Response.json({ prompt_id: '' }),
    Response.json({ prompt_id: '   ' }),
    Response.json({ prompt_id: 42 }),
    new Response('', { status: 503 }),
    new Response('', { status: 408 })
  ])('never retries unknown submissions', async (response) => {
    const { client, fetcher } = setup(response);
    const error = await client.submit(input).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ComfyError);
    expect(error).toMatchObject({ code: 'SUBMISSION_UNKNOWN', uncertain: true });
    expect(String(error)).not.toContain('secret');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('distinguishes explicit rejection', async () => {
    const { client } = setup(new Response('private server detail', { status: 400 }));
    await expect(client.submit(input)).rejects.toMatchObject({ code: 'SUBMISSION_REJECTED', uncertain: false });
  });

  it('uploads multipart without overwrite and keeps subfolder', async () => {
    const { client, fetcher } = setup(Response.json({ name: 'image.png', subfolder: 'attempt/one', type: 'input' }));
    await expect(client.upload({ bytes: new Uint8Array([1, 2]), filename: 'image.png', contentType: 'image/png', subfolder: 'attempt/one' })).resolves.toEqual({ name: 'image.png', subfolder: 'attempt/one', type: 'input' });
    const request = fetcher.mock.calls[0]?.[1];
    const form = request?.body as FormData;
    expect(form.get('type')).toBe('input');
    expect(form.get('subfolder')).toBe('attempt/one');
    expect(form.has('overwrite')).toBe(false);
    expect((form.get('image') as File).name).toBe('image.png');
    expect(new Headers(request?.headers).has('content-type')).toBe(false);
  });

  it.each(['../escape', '/absolute', 'C:/escape', 'one/../../escape', 'one\\escape', 'one\u0000escape'])('rejects unsafe upload subfolder %s without sending', async (subfolder) => {
    const { client, fetcher } = setup();
    await expect(client.upload({ bytes: new Uint8Array(), filename: 'image.png', contentType: 'image/png', subfolder })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('returns output descriptors with node ids for all native media keys', async () => {
    const outputs = Object.fromEntries(['images', 'gifs', 'videos', 'audio'].map((key, index) => [String(index), { [key]: [file] }]));
    const { client } = setup(Response.json({ prompt: { status: { completed: true, status_str: 'success' }, outputs } }));
    await expect(client.history('prompt')).resolves.toEqual({ state: 'succeeded', outputs: ['0', '1', '2', '3'].map((nodeId) => ({ ...file, nodeId })) });
  });

  it.each([
    {},
    { status: { completed: true, status_str: 'unknown' }, outputs: { '1': { images: [file] } } },
    { status: { completed: true, status_str: 'success' }, outputs: { '1': { unknown: [file] } } },
    { status: { completed: true, status_str: 'success' }, outputs: {} },
    { status: { completed: true, status_str: 'success' }, outputs: { '1': { images: [{ url: 'https://untrusted.example' }] } } },
    { status: { status_str: 'success' }, outputs: { '1': { images: [file] } } }
  ])('never reports unknown history formats as succeeded', async (entry) => {
    const { client } = setup(Response.json({ prompt: entry }));
    await expect(client.history('prompt')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    [{}, 'missing'],
    [{ prompt: { status: { completed: false, status_str: 'success' } } }, 'running'],
    [{ prompt: { status: { completed: false, status_str: 'error' } } }, 'failed']
  ])('recognizes non-success history state', async (body, state) => {
    const { client } = setup(Response.json(body));
    await expect(client.history('prompt')).resolves.toEqual({ state, outputs: [] });
  });

  it('downloads a checked streaming response without consuming its body', async () => {
    const response = new Response(new Uint8Array([1, 2]));
    const { client, fetcher } = setup(response);
    expect(await client.download(file)).toBe(response);
    expect(response.bodyUsed).toBe(false);
    const url = new URL(fetcher.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/view');
    expect(url.searchParams.get('subfolder')).toBe('attempt/one');
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('checks download HTTP errors without returning a body', async () => {
    const { client } = setup(new Response('secret', { status: 404 }));
    await expect(client.download(file)).rejects.toMatchObject({ code: 'HTTP_ERROR' });
  });

  it('clears the download header deadline without aborting a slow response stream', async () => {
    vi.useFakeTimers();
    try {
      const response = new Response(new Uint8Array([1, 2]));
      const { client, fetcher } = setup(response);
      const downloaded = await client.download(file);
      const signal = fetcher.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(signal?.aborted).toBe(false);
      expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
    } finally { vi.useRealTimers(); }
  });

  it('aborts downloads that do not return headers before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('header timeout')), { once: true });
      }));
      const client = new ComfyClient({ baseUrl: 'https://comfy.example', fetch: fetcher, timeoutMs: 50 });
      const assertion = expect(client.download(file)).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
      await vi.advanceTimersByTimeAsync(50);
      await assertion;
      expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('consumes the health JSON response', async () => {
    const response = Response.json({ system: {}, devices: [] });
    const { client } = setup(response);
    await client.health();
    expect(response.bodyUsed).toBe(true);
  });

  it.each([new Response('<html>login</html>'), Response.json([]), Response.json(null), Response.json('ready')])('rejects HTML or non-object health responses and consumes their bodies', async (response) => {
    const { client } = setup(response);
    await expect(client.health()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(response.bodyUsed).toBe(true);
  });

  it('blocks redirects and sanitizes transport errors', async () => {
    const { client, fetcher } = setup(new Error('Authorization: secret'));
    await expect(client.health()).rejects.toMatchObject({ code: 'TRANSPORT_ERROR', message: 'ComfyUI request failed' });
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe('error');
  });

  it('only sends explicit targeted control payloads when called', async () => {
    const { client, fetcher } = setup(new Response(), new Response());
    expect(fetcher).not.toHaveBeenCalled();
    await client.interrupt('one');
    await client.removeQueued('two');
    expect(fetcher.mock.calls.map(([url, init]) => [url, JSON.parse(init?.body as string)])).toEqual([
      ['https://comfy.example/interrupt', { prompt_id: 'one' }],
      ['https://comfy.example/queue', { delete: ['two'] }]
    ]);
  });
});

describe('findAttempt bounded recovery', () => {
  it('reports an accepted queue marker before a later history request fails', async () => {
    const { client } = setup(Response.json({ queue_running: [queued('accepted')], queue_pending: [] }), new Error('lost history'));
    const observed: string[] = [];
    await expect(client.findAttempt('attempt', id => observed.push(id))).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    expect(observed).toEqual(['accepted']);
  });
  it('reads complete native history before treating a full recent window as absent', async () => {
    const recent = Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [`other-${index}`, { prompt: queued(`other-${index}`, 'other-attempt') }]));
    const { client, fetcher } = setup(Response.json({ queue_running: [], queue_pending: [] }), Response.json(recent),
      Response.json({ original: { prompt: queued('original') }, ...recent }));
    await expect(client.findAttempt('attempt')).resolves.toEqual({ promptId: 'original' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://comfy.example/queue',
      'https://comfy.example/history?max_items=1000', 'https://comfy.example/history']);
  });
  it.each(['running', 'pending', 'history'])('finds marker in %s and deduplicates the same prompt', async (location) => {
    const { client, fetcher } = setup(
      Response.json({ queue_running: location === 'running' ? [queued('one')] : [], queue_pending: location === 'pending' ? [queued('one')] : [] }),
      Response.json({ one: { prompt: queued('one') } })
    );
    await expect(client.findAttempt('attempt')).resolves.toEqual({ promptId: 'one' });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['https://comfy.example/queue', 'https://comfy.example/history?max_items=1000']);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });

  it('undefined means absent only from this bounded scan, never resubmits', async () => {
    const { client, fetcher } = setup(Response.json({ queue_running: [], queue_pending: [] }), Response.json({ other: { prompt: queued('other', 'another-attempt') } }));
    await expect(client.findAttempt('attempt')).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])('rejects multiple matching prompts across queue/history', async (inQueue) => {
    const { client } = setup(Response.json({ queue_running: inQueue ? [queued('one')] : [], queue_pending: [] }), Response.json({ one: { prompt: queued('one') }, two: { prompt: queued('two') } }));
    await expect(client.findAttempt('attempt')).rejects.toMatchObject({ code: 'AMBIGUOUS_ATTEMPT' });
  });
});

describe('safe native diagnostics and GPU policy', () => {
  it('keeps only request category, status and elapsed time when native submission loses its response', async () => {
    const connection = await setup(Object.assign(new Error('SECRET_URL_TOKEN_PROMPT'), { cause: { code: 'ENOTFOUND' } })).client.submit(input).catch(error => error);
    expect(connection).toMatchObject({ code: 'SUBMISSION_UNKNOWN', details: { requestType: 'connection', errorType: 'ENOTFOUND', elapsedMs: expect.any(Number) } });
    const parse = await setup(new Response('SECRET_BODY')).client.submit(input).catch(error => error);
    expect(parse).toMatchObject({ code: 'SUBMISSION_UNKNOWN', details: { requestType: 'parse', httpStatus: 200, elapsedMs: expect.any(Number) } });
    expect(JSON.stringify([connection, parse])).not.toContain('SECRET');
  });
  it('retains a validation node and error type but never logs provider free text', async () => {
    const { client, fetcher } = setup(Response.json({
      error: { type: 'prompt_outputs_failed_validation', message: 'SECRET_PROMPT' },
      node_errors: { '6': { errors: [{ type: 'value_not_in_list', message: 'SECRET_TOKEN', details: 'SECRET_PATH' }] } },
    }, { status: 400 }));
    const error = await client.submit(input).catch(error => error);
    expect(error).toMatchObject({ code: 'SUBMISSION_REJECTED', uncertain: false, details: { httpStatus: 400, nodeId: '6', errorType: 'value_not_in_list' } });
    expect(JSON.stringify(error)).not.toContain('SECRET');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('bounds diagnostic body reads and keeps uncertainty for server errors', async () => {
    const { client } = setup(new Response('SECRET'.repeat(20_000), { status: 503 }));
    const error = await client.submit(input).catch(error => error);
    expect(error).toMatchObject({ code: 'SUBMISSION_UNKNOWN', uncertain: true, details: { httpStatus: 503 } });
    expect(JSON.stringify(error)).not.toContain('SECRET');
  });

  it('exposes only safe execution-error identifiers from history', async () => {
    const { client } = setup(Response.json({ prompt: {
      status: { completed: false, status_str: 'error', messages: [['execution_error', {
        node_id: '36', exception_type: 'torch.OutOfMemoryError', exception_message: 'SECRET_PROMPT', traceback: ['SECRET_PATH'],
      }]] }, outputs: {},
    } }));
    await expect(client.history('prompt')).resolves.toEqual({ state: 'failed', outputs: [], error: { nodeId: '36', errorType: 'torch.OutOfMemoryError' } });
  });

  it.each(['NVIDIA GeForce RTX 5090', 'NVIDIA GeForce RTX 4090'])('accepts registered GPU family %s', async name => {
    const client = new ComfyClient({ baseUrl: 'https://native.invalid', allowedGpuModels: ['5090', '4090'], fetch: vi.fn().mockResolvedValue(Response.json({ devices: [{ name }] })) });
    await expect(client.health()).resolves.toBeUndefined();
  });

  it.each(['NVIDIA GeForce RTX 3090', 'NVIDIA A100', 'NVIDIA GeForce RTX 4090'])('rejects %s for a 5090-only registration', async name => {
    const client = new ComfyClient({ baseUrl: 'https://native.invalid', allowedGpuModels: ['5090'], fetch: vi.fn().mockResolvedValue(Response.json({ devices: [{ name }] })) });
    await expect(client.health()).rejects.toMatchObject({ code: 'GPU_NOT_ALLOWED' });
  });
});
