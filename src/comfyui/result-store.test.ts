import { createHash } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as resources from '../system-media/resources.js';
import { LocalPrivateBlobStore } from '../system-media/routes.js';
import { ComfyResultStore } from './result-store.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (process.platform === 'win32' && (await handle.stat()).isDirectory()) handle.sync = async () => {};
      return handle;
    },
  };
});

const directories: string[] = [];
const video = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), ...Buffer.alloc(52, 7)]);
const hash = createHash('sha256').update(video).digest('hex');

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'comfy-result-test-'));
  directories.push(root);
  const directory = path.join(root, 'store');
  return { root, directory, store: new ComfyResultStore(directory) };
}

function response(bytes: Uint8Array = video, headers: Record<string, string> = {}) {
  let offset = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 5, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 }), { headers });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  const base = path.resolve(os.tmpdir());
  for (const directory of directories.splice(0)) {
    const relative = path.relative(base, path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('ComfyResultStore', () => {
  it('streams a split MP4 signature to durable storage without trusting header MIME or using buffer APIs', async () => {
    const { store, directory, root } = await fixture();
    vi.spyOn(LocalPrivateBlobStore.prototype, 'put').mockRejectedValue(new Error('Buffer put must not run'));
    vi.spyOn(LocalPrivateBlobStore.prototype, 'get').mockRejectedValue(new Error('Buffer get must not run'));
    const put = vi.spyOn(LocalPrivateBlobStore.prototype, 'putStream');
    const result = await store.save('../../outside', response(video, { 'content-length': String(video.length), 'content-type': 'text/html' }));
    expect(result).toEqual({ hash, size: video.length, mime: 'video/mp4' });
    expect(put).toHaveBeenCalledWith(hash, expect.any(Readable), expect.objectContaining({ size: video.length, mime: 'video/mp4' }));
    expect(await readFile(path.join(directory, hash.slice(0, 2), hash))).toEqual(video);
    expect(await readdir(directory)).toEqual([hash.slice(0, 2)]);
    expect(await readdir(root)).toEqual(['store']);
  });

  it('accepts unknown content length and returns a verified download stream', async () => {
    const { store } = await fixture();
    const result = await store.save('job', response());
    const read = vi.spyOn(LocalPrivateBlobStore.prototype, 'verifiedRead');
    const stream = await store.read(result);
    expect(stream).toBeInstanceOf(Readable);
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks)).toEqual(video);
    expect(read).toHaveBeenCalledWith(hash, video.length);
    expect(await store.read({ hash: 'a'.repeat(64), size: 12 })).toBeNull();
    await expect(store.read({ hash: '../../escape', size: 12 })).rejects.toMatchObject({ code: 'INVALID_HASH' });
  });

  it('rejects corrupted or wrong-size stored results before returning a stream', async () => {
    const { store, directory } = await fixture();
    const result = await store.save('job', response());
    await expect(store.read({ ...result, size: result.size + 1 })).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
    await writeFile(path.join(directory, hash.slice(0, 2), hash), Buffer.alloc(video.length));
    await expect(store.read(result)).rejects.toMatchObject({ code: 'MEDIA_UNAVAILABLE' });
  });

  it.each([Buffer.from('<html>not a video</html>'), video.subarray(0, 8), Buffer.alloc(0)])('rejects bad or truncated MP4 signatures and removes only its temporary file (%#)', async bytes => {
    const { store, directory } = await fixture();
    const put = vi.spyOn(LocalPrivateBlobStore.prototype, 'putStream');
    await expect(store.save('job', response(bytes, { 'content-type': 'video/mp4' }))).rejects.toMatchObject({ code: 'MEDIA_TYPE_MISMATCH' });
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([video.length - 1, video.length + 1])('rejects content-length mismatch %s before durable storage', async length => {
    const { store, directory } = await fixture();
    const put = vi.spyOn(LocalPrivateBlobStore.prototype, 'putStream');
    await expect(store.save('job', response(video, { 'content-length': String(length) }))).rejects.toMatchObject({ code: 'MEDIA_SIZE_MISMATCH' });
    expect(put).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['0', '-1', 'invalid', '1.5', '9007199254740992'])('rejects invalid declared length %s and cancels the source', async length => {
    const { store } = await fixture();
    const cancel = vi.fn();
    const incoming = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': length } });
    await expect(store.save('job', incoming)).rejects.toMatchObject({ code: 'INVALID_MEDIA_SIZE' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(incoming.body!.locked).toBe(false);
  });

  it('cancels a pending read on abort without waiting for an uncooperative cancellation promise', async () => {
    const { store, directory } = await fixture();
    const controller = new AbortController();
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const incoming = new Response(new ReadableStream<Uint8Array>({ pull() { entered(); }, cancel }, { highWaterMark: 0 }));
    const pending = store.save('job', incoming, controller.signal);
    const reason = new Error('Caller cancelled');
    const rejected = expect(pending).rejects.toBe(reason);
    await reading;
    controller.abort(reason);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(incoming.body!.locked).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it('cancels pre-aborted responses without creating temporary files', async () => {
    const { store, root } = await fixture();
    const controller = new AbortController();
    controller.abort(new Error('Already stopped'));
    const cancel = vi.fn();
    await expect(store.save('job', new Response(new ReadableStream({ cancel })), controller.signal)).rejects.toThrow('Already stopped');
    expect(cancel).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });

  it('cancels unavailable HTTP responses without creating files', async () => {
    const { store, root } = await fixture();
    const cancel = vi.fn();
    const incoming = new Response(new ReadableStream({ cancel }), { status: 503 });
    await expect(store.save('job', incoming)).rejects.toMatchObject({ code: 'RESULT_UNAVAILABLE' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(await readdir(root)).toEqual([]);
  });

  it('removes a partially written temporary file when the upstream stream fails', async () => {
    const { store, directory } = await fixture();
    const failure = new Error('Upstream disconnected');
    let first = true;
    const incoming = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) { first = false; controller.enqueue(video.subarray(0, 16)); }
        else controller.error(failure);
      },
    }, { highWaterMark: 0 }));
    await expect(store.save('job', incoming)).rejects.toBe(failure);
    expect(incoming.body!.locked).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it('enforces idle timeout after response headers without relying on fetch cancellation', async () => {
    const { store, directory } = await fixture();
    vi.useFakeTimers();
    let entered!: () => void;
    const reading = new Promise<void>(resolve => { entered = resolve; });
    const cancel = vi.fn();
    const incoming = new Response(new ReadableStream<Uint8Array>({ pull() { entered(); }, cancel }, { highWaterMark: 0 }));
    const pending = store.save('job', incoming);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'MEDIA_UPLOAD_TIMEOUT' });
    await reading;
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(incoming.body!.locked).toBe(false);
    expect(await readdir(directory)).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resets the idle watchdog on progress rather than limiting total transfer time', async () => {
    const { store } = await fixture();
    const watchdog = resources.mediaIdleWatchdog;
    vi.spyOn(resources, 'mediaIdleWatchdog').mockImplementation((_timeout, reason, parent) => watchdog(200, reason, parent));
    let offset = 0;
    const incoming = new Response(new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise(resolve => setTimeout(resolve, 60));
        if (offset === video.length) { controller.close(); return; }
        controller.enqueue(video.subarray(offset, offset + 12));
        offset = Math.min(offset + 12, video.length);
      },
    }, { highWaterMark: 0 }));
    expect(await store.save('job', incoming)).toEqual({ hash, size: video.length, mime: 'video/mp4' });
  });

  it('cleans only this attempt on durable write failure and keeps other files', async () => {
    const { store, directory } = await fixture();
    await store.save('existing-job', response());
    const error = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    let source!: ReadStream;
    vi.spyOn(LocalPrivateBlobStore.prototype, 'putStream').mockImplementation(async (_hash, incoming) => {
      source = incoming as ReadStream;
      throw error;
    });
    await expect(store.save('failed-job', response())).rejects.toMatchObject({ code: 'MEDIA_STORAGE_FULL' });
    expect(source.destroyed).toBe(true);
    expect(source.closed).toBe(true);
    expect(await readdir(directory)).toEqual([hash.slice(0, 2)]);
    expect(await readFile(path.join(directory, hash.slice(0, 2), hash))).toEqual(video);
  });

  it.each(['throw', 'reject', 'source-error'])('closes an unconsumed file stream before temporary cleanup without unhandled errors (%s)', async failure => {
    const { store, directory } = await fixture();
    const unhandled = vi.fn();
    process.on('uncaughtExceptionMonitor', unhandled);
    process.on('unhandledRejection', unhandled);
    const error = new Error('Durable admission refused');
    let source!: ReadStream;
    vi.spyOn(LocalPrivateBlobStore.prototype, 'putStream').mockImplementation((_hash, incoming) => {
      source = incoming as ReadStream;
      if (failure === 'source-error') source.destroy(new Error('Late source failure'));
      if (failure === 'throw') throw error;
      return Promise.reject(error);
    });
    try {
      await expect(store.save('failed-job', response())).rejects.toBe(error);
      expect(source.destroyed).toBe(true);
      expect(source.closed).toBe(true);
      expect(source.listenerCount('error')).toBe(0);
      expect(await readdir(directory)).toEqual([]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.removeListener('uncaughtExceptionMonitor', unhandled);
      process.removeListener('unhandledRejection', unhandled);
    }
  });
});
