import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpGpuResultExporter } from './gpu-result-exporter.js';
import type { GpuResultExporter } from './result-archive.js';

const secret = '独立导出密钥'.repeat(4);
const baseUrl = 'https://comfy.example';
const job = { id: 'job-中文', prompt_id: 'prompt', input: 'PRIVATE', authorization: 'PRIVATE' } as unknown as
  Parameters<GpuResultExporter['describe']>[0];
const output = { filename: '结果.mp4', subfolder: 'video', type: 'output' };
const file = { size: 100, sha256: 'ab'.repeat(32), md5: Buffer.alloc(16, 1).toString('base64') };
const target = { url: 'https://tos.example/video?signature=PRIVATE', headers: { 'Content-MD5': file.md5 } };
const unavailable = { code: 'COMFY_ARCHIVE_GPU_UNAVAILABLE', message: 'GPU result export unavailable' };
const invalid = { code: 'COMFY_ARCHIVE_GPU_INVALID', message: 'GPU result export invalid' };

function setup(response: Response = Response.json(file)) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  return { fetcher, exporter: new HttpGpuResultExporter({ baseUrl, secret, fetch: fetcher }) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('HttpGpuResultExporter', () => {
  it.each(['describe', 'upload'] as const)('signs the exact UTF-8 %s body and sends only export credentials', async operation => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const { exporter, fetcher } = setup(Response.json({ ...file, ignored: 'PRIVATE' }));
    const signal = new AbortController().signal;
    await expect(operation === 'describe' ? exporter.describe(job, output, signal)
      : exporter.upload(job, output, file, target, signal)).resolves.toEqual(file);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe(`${baseUrl}/hailuo/result-export/${operation}`);
    expect(request).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    const body = request!.body as string;
    expect(JSON.parse(body)).toEqual({ expiresAt: 121_000, jobId: job.id, promptId: job.prompt_id,
      output, ...(operation === 'upload' ? { file, target } : {}) });
    expect(Object.fromEntries(new Headers(request!.headers))).toEqual({
      'content-type': 'application/json; charset=utf-8',
      'x-hailuo-export-signature': createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex'),
    });
    expect(body).not.toContain(secret);
  });

  it.each(['http://comfy.example', 'http://127.0.0.1.evil.example', 'ftp://localhost',
    'https://user:PRIVATE@comfy.example', 'https://comfy.example?token=PRIVATE', 'https://comfy.example/#PRIVATE', 'PRIVATE'])
  ('rejects unsafe base URL %s without leaking it', baseUrl => {
    expect(() => new HttpGpuResultExporter({ baseUrl, secret })).toThrow(expect.objectContaining(invalid));
  });

  it.each(['https://comfy.example/prefix/', 'http://localhost:8188', 'http://127.0.0.2:8188', 'http://[::1]:8188'])
  ('accepts trusted HTTPS or loopback HTTP %s', async baseUrl => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(file));
    const exporter = new HttpGpuResultExporter({ baseUrl, secret, fetch: fetcher });
    await exporter.describe(job, output, new AbortController().signal);
    expect(fetcher.mock.calls[0]![0]).toBe(baseUrl.replace(/\/$/, '') + '/hailuo/result-export/describe');
  });

  it('requires at least 32 UTF-8 bytes of independent export secret', () => {
    expect(() => new HttpGpuResultExporter({ baseUrl, secret: 'a'.repeat(31) })).toThrow(expect.objectContaining(invalid));
    expect(() => new HttpGpuResultExporter({ baseUrl, secret: '密'.repeat(11) })).not.toThrow();
    expect(() => new HttpGpuResultExporter({ baseUrl, secret: 'a'.repeat(32) })).not.toThrow();
  });

  it.each([0, -1, 1.5, 5 * 1024 ** 3 + 1, Number.MAX_SAFE_INTEGER + 1, '100', null])
  ('rejects invalid archive size %s', async size => {
    const { exporter } = setup(Response.json({ ...file, size }));
    await expect(exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject(invalid);
  });

  it.each([1, 5 * 1024 ** 3])('accepts archive size boundary %s', async size => {
    const { exporter } = setup(Response.json({ ...file, size, sha256: file.sha256.toUpperCase() }));
    await expect(exporter.describe(job, output, new AbortController().signal)).resolves.toEqual({ ...file, size });
  });

  it.each([null, [], {}, 'PRIVATE', { ...file, sha256: 'g'.repeat(64) }, { ...file, sha256: 123 },
    { ...file, md5: 'AA==' }, { ...file, md5: 'A'.repeat(21) + 'B==' }, { ...file, md5: null }])
  ('rejects malformed metadata %#', async value => {
    const { exporter } = setup(Response.json(value));
    await expect(exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject(invalid);
  });

  it.each(['<html>PRIVATE</html>', '', '{"size":'])('rejects non-JSON bodies %#', async body => {
    const { exporter } = setup(new Response(body));
    await expect(exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject(invalid);
  });

  it('rejects invalid UTF-8', async () => {
    const { exporter } = setup(new Response(new Uint8Array([255])));
    await expect(exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject(invalid);
  });

  it.each([false, true])('bounds streaming bytes regardless of content-length (misleading=%s)', async misleading => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(Buffer.from('密'.repeat(11_000))); }, cancel,
    });
    const { exporter } = setup(new Response(stream, { headers: misleading ? { 'Content-Length': '1' } : {} }));
    await expect(exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject(invalid);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('accepts exactly 64 KiB and rejects one extra byte', async () => {
    const body = JSON.stringify(file);
    for (const size of [65_536, 65_537]) {
      const { exporter } = setup(new Response(body + ' '.repeat(size - Buffer.byteLength(body))));
      const result = exporter.describe(job, output, new AbortController().signal);
      if (size === 65_536) await expect(result).resolves.toEqual(file);
      else await expect(result).rejects.toMatchObject(invalid);
    }
  });

  it('rejects oversized content-length without waiting for a body', async () => {
    const cancel = vi.fn();
    const { exporter } = setup(new Response(new ReadableStream({ cancel }), { headers: { 'Content-Length': '65537' } }));
    await expect(exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject(invalid);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([302, 401, 500])('sanitizes HTTP %s errors and cancels without reading', async status => {
    const cancel = vi.fn();
    const { exporter } = setup(new Response(new ReadableStream({ cancel }), { status }));
    await expect(exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject(unavailable);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('does not leak fetch errors, URLs, secrets or causes', async () => {
    const { exporter, fetcher } = setup();
    fetcher.mockRejectedValue(new Error(baseUrl + secret + target.url));
    const error = await exporter.describe(job, output, new AbortController().signal).catch(error => error);
    expect(error).toMatchObject(unavailable);
    expect(error.cause).toBeUndefined();
    expect(String(error) + JSON.stringify(error)).not.toMatch(/https:|PRIVATE|独立/);
  });

  it('does not send when already aborted', async () => {
    const { exporter, fetcher } = setup();
    await expect(exporter.describe(job, output, AbortSignal.abort('PRIVATE'))).rejects.toMatchObject(unavailable);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['describe', 'upload'] as const)('combines caller abort during %s', async operation => {
    const { exporter, fetcher } = setup();
    fetcher.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = operation === 'describe' ? exporter.describe(job, output, controller.signal)
      : exporter.upload(job, output, file, target, controller.signal);
    const assertion = expect(result).rejects.toMatchObject(unavailable);
    controller.abort(new Error('PRIVATE'));
    await assertion;
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  });

  it.each([['describe', 60_000], ['upload', 600_000]] as const)('enforces %s timeout through body reads', async (operation, duration) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const { exporter, fetcher } = setup(new Response(new ReadableStream({ cancel })));
    const caller = new AbortController();
    const result = operation === 'describe' ? exporter.describe(job, output, caller.signal)
      : exporter.upload(job, output, file, target, caller.signal);
    const assertion = expect(result).rejects.toMatchObject(unavailable);
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
    expect(caller.signal.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cancels an in-progress response body on caller abort', async () => {
    const cancel = vi.fn();
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const { exporter } = setup(new Response(new ReadableStream({ pull() { started(); }, cancel })));
    const controller = new AbortController();
    const assertion = expect(exporter.describe(job, output, controller.signal)).rejects.toMatchObject(unavailable);
    await reading;
    controller.abort('PRIVATE');
    await assertion;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([['describe', 60_000], ['upload', 600_000]] as const)('times out %s before response headers', async (operation, duration) => {
    vi.useFakeTimers();
    const { exporter, fetcher } = setup();
    fetcher.mockImplementation(() => new Promise(() => {}));
    const signal = new AbortController().signal;
    const assertion = expect(operation === 'describe' ? exporter.describe(job, output, signal)
      : exporter.upload(job, output, file, target, signal)).rejects.toMatchObject(unavailable);
    await vi.advanceTimersByTimeAsync(duration);
    await assertion;
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears successful request timers', async () => {
    vi.useFakeTimers();
    const { exporter, fetcher } = setup();
    await exporter.describe(job, output, new AbortController().signal);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(false);
  });

  it('never follows a real HTTP redirect', async () => {
    const paths: string[] = [];
    const server = createServer((request, response) => {
      paths.push(request.url!);
      response.writeHead(302, { Location: '/private-video' });
      response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address() as { port: number };
      const exporter = new HttpGpuResultExporter({ baseUrl: `http://127.0.0.1:${address.port}`, secret });
      await expect(exporter.describe(job, output, new AbortController().signal)).rejects.toMatchObject(unavailable);
      expect(paths).toEqual(['/hailuo/result-export/describe']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
