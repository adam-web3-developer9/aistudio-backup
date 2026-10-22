import { readFile } from 'node:fs/promises';
import { Client, type ClientChannel } from 'ssh2';
import type { AigateSshConnection } from './aigate-client.js';
import { ComfyError } from './comfy-client.js';
import type { GpuResultExporter } from './result-archive.js';

type Job = Parameters<GpuResultExporter['describe']>[0];
type Output = Parameters<GpuResultExporter['describe']>[1];
type File = Awaited<ReturnType<GpuResultExporter['describe']>>;
type Target = Parameters<GpuResultExporter['upload']>[3];
type Runtime = { python: string; outputRoot: string; port: 8188; pid: number };
const invalid = Symbol('invalid');
const unavailable = Symbol('unavailable');
const maxRequestBytes = 1_048_576;
const bootstrap = 'import sys,json; raw=sys.stdin.buffer.read(1048577); '
  + 'assert len(raw)<=1048576; request=json.loads(raw.decode("utf-8")); '
  + 'source=request.pop("runnerSource"); exec(compile(source,"<hailuo-ssh-runner>","exec"),{"request":request})';

export interface SshGpuResultExporterOptions {
  connection: () => Promise<AigateSshConnection>;
  verifyHostKey: (fingerprint: string) => boolean;
  runnerSource?: string;
  exporterSource?: string;
  clientFactory?: () => Client;
}

function failure(reason: unknown): ComfyError {
  const code = reason === invalid ? 'INVALID' : 'UNAVAILABLE';
  return new ComfyError(`COMFY_ARCHIVE_GPU_${code}`, `GPU result export ${code.toLowerCase()}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseResponse(bytes: Buffer): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw invalid; }
  if (!record(value)) throw invalid;
  if ('error' in value) throw unavailable;
  return value;
}

function archiveFile(value: unknown): File {
  if (!record(value)) throw invalid;
  const { size, sha256, md5 } = value;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0 || size > 5 * 1024 ** 3
    || typeof sha256 !== 'string' || sha256.length !== 64 || !/^[a-fA-F0-9]+$/.test(sha256)
    || typeof md5 !== 'string' || md5.length !== 24 || !/^[A-Za-z0-9+/]{22}==$/.test(md5)
    || Buffer.from(md5, 'base64').toString('base64') !== md5) throw invalid;
  return { size, sha256: sha256.toLowerCase(), md5 };
}

function runtime(value: Record<string, unknown>): Runtime {
  const { python, outputRoot, port, pid } = value;
  if (typeof python !== 'string' || python.length > 4096 || !python.startsWith('/')
    || /[^A-Za-z0-9._/-]/.test(python)
    || python.slice(1).split('/').some(part => !part || part === '.' || part === '..')
    || typeof outputRoot !== 'string' || outputRoot.length > 4096 || !outputRoot.startsWith('/')
    || /[\x00-\x1f\x7f\\]/.test(outputRoot)
    || outputRoot.split('/').some(part => part === '.' || part === '..')
    || port !== 8188 || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) throw invalid;
  return { python, outputRoot, port, pid };
}

function requestBody(value: unknown): string {
  let body: string;
  try { body = JSON.stringify(value); } catch { throw invalid; }
  if (Buffer.byteLength(body, 'utf8') > maxRequestBytes) throw invalid;
  return body;
}

function closeChannel(channel: ClientChannel): void {
  try { channel.close(); } catch {}
  try { channel.destroy(); } catch {}
}

export class SshGpuResultExporter implements GpuResultExporter {
  constructor(private readonly options: SshGpuResultExporterOptions) {}

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
    let client: Client | undefined;
    let channel: ClientChannel | undefined;
    let rejectPending: ((reason: unknown) => void) | undefined;
    let onAbort: (() => void) | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (channel) closeChannel(channel);
      try { client?.end(); } catch {}
      try { client?.destroy(); } catch {}
    };
    try {
      signal.throwIfAborted();
      const expected = upload ? archiveFile(upload.file) : undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => { reject(unavailable); rejectPending?.(unavailable); stop(); };
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const execute = async (): Promise<File> => {
        const [runnerSource, exporterSource] = await Promise.all([
          this.options.runnerSource ?? readFile(new URL('../../server/comfyui-result-export/ssh_runner.py', import.meta.url), { encoding: 'utf8', signal }),
          this.options.exporterSource ?? readFile(new URL('../../server/comfyui-result-export/exporter.py', import.meta.url), { encoding: 'utf8', signal }),
        ]);
        const inspectBody = requestBody({ runnerSource, operation: 'inspect' });
        signal.throwIfAborted();
        const connection = await this.options.connection();
        signal.throwIfAborted();
        client = this.options.clientFactory?.() ?? new Client();
        signal.throwIfAborted();
        const ssh = client;
        await new Promise<void>((resolve, reject) => {
          rejectPending = reject;
          ssh.once('ready', () => { if (!signal.aborted) resolve(); });
          ssh.on('error', () => rejectPending?.(unavailable));
          ssh.on('close', () => rejectPending?.(unavailable));
          ssh.on('end', () => rejectPending?.(unavailable));
          ssh.connect({
            host: connection.host, port: connection.port, username: connection.username, password: connection.password,
            readyTimeout: 20_000, hostHash: 'sha256', authHandler: ['password'],
            hostVerifier: (fingerprint: string) => {
              if (signal.aborted) return false;
              try { return this.options.verifyHostKey(fingerprint) === true; } catch { return false; }
            },
          });
        });
        signal.throwIfAborted();
        const run = (python: string, body: string): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
          let settled = false;
          const finish = (reason?: unknown, value?: Record<string, unknown>) => {
            if (settled) return;
            settled = true;
            rejectPending = undefined;
            if (reason !== undefined) reject(reason);
            else resolve(value!);
          };
          rejectPending = reason => finish(reason);
          if (signal.aborted) { finish(unavailable); return; }
          ssh.exec(`${python} -B -c '${bootstrap}'`, (error, stream) => {
            stream?.on('error', () => finish(unavailable));
            stream?.stderr.on('error', () => finish(unavailable));
            if (stream && (settled || signal.aborted)) { closeChannel(stream); finish(unavailable); return; }
            if (error || !stream) { if (stream) closeChannel(stream); finish(unavailable); return; }
            channel = stream;
            const chunks: Buffer[] = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let exitCode: number | undefined;
            stream.on('data', (chunk: Buffer | string) => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
              stdoutBytes += bytes.byteLength;
              if (stdoutBytes > 65_536) { finish(invalid); return; }
              chunks.push(bytes);
            });
            stream.stderr.on('data', (chunk: Buffer | string) => {
              if (settled) return;
              stderrBytes += Buffer.byteLength(chunk);
              if (stderrBytes > 8192) finish(invalid);
            });
            stream.once('exit', (code: number | null, exitSignal?: string) => {
              if (code !== 0 || exitSignal) finish(unavailable);
              else exitCode = code;
            });
            stream.once('close', (code?: number, exitSignal?: string) => {
              if (settled) return;
              if ((code ?? exitCode) !== 0 || exitSignal) { finish(unavailable); return; }
              try { finish(undefined, parseResponse(Buffer.concat(chunks, stdoutBytes))); }
              catch (reason) { finish(reason); }
            });
            try { stream.end(body, 'utf8'); } catch { finish(unavailable); }
          });
        });
        const inspected = runtime(await run('python3', inspectBody));
        signal.throwIfAborted();
        const payload = { expiresAt: Date.now() + 120_000, jobId: job.id, promptId: job.prompt_id,
          output, ...(upload ? { file: expected, target: upload.target } : {}) };
        const response = archiveFile(await run(inspected.python, requestBody({ runnerSource, operation,
          runtime: inspected, exporterSource, payload })));
        if (expected && (response.size !== expected.size || response.sha256 !== expected.sha256 || response.md5 !== expected.md5)) throw invalid;
        return response;
      };
      return await Promise.race([execute(), aborted]);
    } catch (reason) {
      throw failure(reason);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      rejectPending = undefined;
      stop();
    }
  }
}
