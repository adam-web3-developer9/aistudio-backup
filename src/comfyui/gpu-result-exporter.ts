import { createHmac } from 'node:crypto';
import { ComfyError } from './comfy-client.js';
import type { GpuResultExporter } from './result-archive.js';

type Job = Parameters<GpuResultExporter['describe']>[0];
type Output = Parameters<GpuResultExporter['describe']>[1];
type File = Awaited<ReturnType<GpuResultExporter['describe']>>;
type Target = Parameters<GpuResultExporter['upload']>[3];
const invalid = Symbol('invalid');
const maxResponseBytes = 65_536;

function failure(code: 'INVALID' | 'UNAVAILABLE'): ComfyError {
  return new ComfyError(`COMFY_ARCHIVE_GPU_${code}`, `GPU result export ${code === 'INVALID' ? 'invalid' : 'unavailable'}`);
}

function parseFile(bytes: Uint8Array): File {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid;
    const { size, sha256, md5 } = value as Record<string, unknown>;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > 5 * 1024 ** 3
      || typeof sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(sha256)
      || typeof md5 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(md5)
      || Buffer.from(md5, 'base64').toString('base64') !== md5) throw invalid;
    return { size, sha256: sha256.toLowerCase(), md5 };
  } catch { throw invalid; }
}

export class HttpGpuResultExporter implements GpuResultExporter {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetcher: typeof fetch;

  constructor(options: { baseUrl: string; secret: string; fetch?: typeof fetch }) {
    try {
      const url = new URL(options.baseUrl);
      const loopback = url.hostname === 'localhost' || url.hostname === '[::1]'
        || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
      if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        || url.username || url.password || url.search || url.hash
        || typeof options.secret !== 'string' || Buffer.byteLength(options.secret, 'utf8') < 32) throw invalid;
      this.baseUrl = url.href.replace(/\/$/, '');
      this.secret = options.secret;
      this.fetcher = options.fetch ?? globalThis.fetch;
    } catch { throw failure('INVALID'); }
  }

  describe(job: Job, output: Output, signal: AbortSignal): Promise<File> {
    return this.request('describe', job, output, signal);
  }

  upload(job: Job, output: Output, file: File, target: Target, signal: AbortSignal): Promise<File> {
    return this.request('upload', job, output, signal, { file, target });
  }

  private async request(operation: 'describe' | 'upload', job: Job, output: Output,
    callerSignal: AbortSignal, upload?: { file: File; target: Target }): Promise<File> {
    const timeout = new AbortController();
    const signal = AbortSignal.any([callerSignal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), operation === 'describe' ? 60_000 : 600_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      let body: string;
      try {
        body = JSON.stringify({ expiresAt: Date.now() + 120_000, jobId: job.id,
          promptId: job.prompt_id, output, ...upload });
      } catch { throw invalid; }
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(failure('UNAVAILABLE'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const execute = async (): Promise<File> => {
        const response = await this.fetcher(this.baseUrl + `/hailuo/result-export/${operation}`, {
          method: 'POST', body, redirect: 'error', credentials: 'omit', signal,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Hailuo-Export-Signature': createHmac('sha256', this.secret).update(body, 'utf8').digest('hex'),
          },
        });
        reader = response.body?.getReader();
        try {
          signal.throwIfAborted();
          if (!response.ok || response.redirected) throw failure('UNAVAILABLE');
          if (!reader || Number(response.headers.get('content-length')) > maxResponseBytes) throw invalid;
          const chunks: Uint8Array[] = [];
          let total = 0;
          for (;;) {
            const chunk = await reader.read();
            signal.throwIfAborted();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > maxResponseBytes) throw invalid;
            chunks.push(chunk.value);
          }
          return parseFile(Buffer.concat(chunks, total));
        } finally {
          if (reader) {
            void reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
      };
      return await Promise.race([execute(), aborted]);
    } catch (error) {
      throw failure(error === invalid ? 'INVALID' : 'UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (signal.aborted && reader) void reader.cancel().catch(() => {});
    }
  }
}
