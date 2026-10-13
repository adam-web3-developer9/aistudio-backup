import { constants as bufferConstants } from 'node:buffer';
import { freemem } from 'node:os';
import { getHeapStatistics } from 'node:v8';
import { Readable } from 'node:stream';
import type { MediaPolicy } from './routes.js';
import { ProjectError } from '../projects/protocol.js';

/** Window sizes regulate active streams; waiting requests retain backpressure. */
export class MediaAdmission {
  private active = new Map<symbol, string>();
  private waiting = new Set<() => void>();
  async acquire(userId: string, policy: Pick<MediaPolicy, 'maxConcurrentUploads' | 'maxConcurrentPerUser'>, signal?: AbortSignal): Promise<() => void> {
    for (;;) {
      signal?.throwIfAborted();
      const own = [...this.active.values()].filter(id => id === userId).length;
      if (this.active.size < policy.maxConcurrentUploads && own < policy.maxConcurrentPerUser) {
        const key = Symbol(userId); this.active.set(key, userId);
        return () => { if (this.active.delete(key)) for (const wake of [...this.waiting]) wake(); };
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => { this.waiting.delete(wake); signal?.removeEventListener('abort', abort); };
        const wake = () => { finish(); resolve(); };
        const abort = () => { finish(); reject(signal?.reason); };
        this.waiting.add(wake); signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
      });
    }
  }
}

/** Inactivity, never a total transfer duration. Large timer values are scheduled in representable intervals. */
export function mediaIdleWatchdog(timeoutMs: number, reason: () => Error, parent?: AbortSignal) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid media inactivity timeout');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, lastProgress = Date.now();
  const arm = () => {
    if (timer) clearTimeout(timer);
    if (controller.signal.aborted) return;
    const remaining = timeoutMs - (Date.now() - lastProgress);
    timer = setTimeout(() => { if (Date.now() - lastProgress >= timeoutMs) controller.abort(reason()); else arm(); }, Math.min(2147483647, Math.max(1, remaining)));
    timer.unref();
  };
  const abort = () => { controller.abort(parent?.reason); if (timer) clearTimeout(timer); };
  if (parent?.aborted) abort(); else parent?.addEventListener('abort', abort, { once: true });
  arm();
  return { signal: controller.signal, progress: () => { lastProgress = Date.now(); arm(); }, close: () => { if (timer) clearTimeout(timer); parent?.removeEventListener('abort', abort); } };
}

/** Compatibility objects may need memory; the budget comes from this process and machine, not a product quota. */
export function assertMediaMemory(bytes: number, representation: 'buffer' | 'json' = 'buffer'): void {
  const heap = getHeapStatistics();
  const available = Math.min(process.availableMemory?.() ?? freemem(), heap.heap_size_limit - heap.used_heap_size);
  const physical = representation === 'buffer' ? bufferConstants.MAX_LENGTH : bufferConstants.MAX_STRING_LENGTH;
  // Leave headroom for the existing representation and the next decode/parse/copy.
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > physical || bytes * (representation === 'json' ? 6 : 3) > available) {
    throw new ProjectError(507, 'MEDIA_MEMORY_UNAVAILABLE', '当前可用内存无法处理兼容媒体对象，请稍后重试或使用二进制流式接口');
  }
}

export async function readLegacyMediaJson(source: AsyncIterable<Uint8Array>, timeoutMs: number): Promise<unknown> {
  const idle = mediaIdleWatchdog(timeoutMs, () => new ProjectError(408, 'MEDIA_UPLOAD_TIMEOUT', '媒体请求无进展，请检查网络后重试'));
  const decoder = new TextDecoder('utf-8', { fatal: true }), chunks: string[] = [];
  let size = 0;
  const iterator = source[Symbol.asyncIterator]();
  let rejectAbort: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { rejectAbort(idle.signal.reason); if (source instanceof Readable) source.destroy(idle.signal.reason); };
  idle.signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]); if (next.done) break;
      size += next.value.byteLength; assertMediaMemory(size, 'json');
      chunks.push(decoder.decode(next.value, { stream: true })); idle.progress();
    }
    chunks.push(decoder.decode()); assertMediaMemory(size, 'json');
    return JSON.parse(chunks.join('')) as unknown;
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError(400, 'INVALID_MEDIA', '媒体 JSON 格式无效');
  } finally { idle.close(); idle.signal.removeEventListener('abort', abort); void iterator.return?.().catch(() => {}); }
}

export async function* decodeLegacyMedia(data: string): AsyncGenerator<Buffer> {
  if (!data.length || data.length % 4 !== 0) throw new ProjectError(400, 'INVALID_MEDIA', '媒体必须使用规范 base64');
  const tail = data.slice(-4);
  if (!/^(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(tail)) throw new ProjectError(400, 'INVALID_MEDIA', '媒体必须使用规范 base64');
  for (let offset = 0; offset < data.length; offset += 64 * 1024) {
    const chunk = data.slice(offset, Math.min(data.length, offset + 64 * 1024));
    const unpadded = offset + chunk.length === data.length ? chunk.replace(/=+$/, '') : chunk;
    if (!/^[A-Za-z0-9+/]+$/.test(unpadded)) throw new ProjectError(400, 'INVALID_MEDIA', '媒体必须使用规范 base64');
    yield Buffer.from(chunk, 'base64');
  }
}
