import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { lstat, mkdir, open, statfs, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { ProjectError } from '../projects/protocol.js';
import { mediaIdleWatchdog } from '../system-media/resources.js';
import { LocalPrivateBlobStore, resolveMediaPolicy, validMediaSignature } from '../system-media/routes.js';

const idleTimeoutMs = resolveMediaPolicy().uploadTimeoutMs;

export class ComfyResultStore {
  private readonly directory: string;
  private readonly blobs: LocalPrivateBlobStore;

  constructor(directory: string) {
    this.directory = path.resolve(directory);
    this.blobs = new LocalPrivateBlobStore(this.directory);
  }

  private async prepareDirectory(): Promise<void> {
    let current = path.parse(this.directory).root;
    for (const component of this.directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new ProjectError(400, 'UNSAFE_BLOB_PATH', '结果存储目录不安全');
    }
  }

  private async checkSpace(remaining: number): Promise<void> {
    const space = await statfs(this.directory, { bigint: true });
    if (space.bavail * space.bsize < BigInt(remaining) + BigInt(64 * 1024 * 1024)) {
      throw new ProjectError(507, 'MEDIA_STORAGE_FULL', '结果落盘空间不足，生成结果保留上游');
    }
  }

  async save(_jobId: string, response: Response, signal?: AbortSignal): Promise<{ hash: string; size: number; mime: 'video/mp4' }> {
    const idle = mediaIdleWatchdog(idleTimeoutMs, () => new ProjectError(408, 'MEDIA_UPLOAD_TIMEOUT', '视频结果传输无进展，生成结果保留上游'), signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let handle: FileHandle | undefined;
    let temporary: string | undefined;
    let cancelled = false;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      const pending = reader ? reader.cancel() : response.body?.cancel();
      void pending?.catch(() => {});
    };
    let rejectAbort: (error: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    void aborted.catch(() => {});
    const onAbort = () => { rejectAbort(idle.signal.reason); cancel(); };
    idle.signal.addEventListener('abort', onAbort, { once: true });
    try {
      idle.signal.throwIfAborted();
      if (!response.ok || !response.body) throw new ProjectError(502, 'RESULT_UNAVAILABLE', '视频结果不可用，生成结果保留上游');
      reader = response.body.getReader();
      const lengthHeader = response.headers.get('content-length');
      const declared = lengthHeader === null ? undefined : Number(lengthHeader);
      if (declared !== undefined && (!/^\d+$/.test(lengthHeader!) || !Number.isSafeInteger(declared) || declared <= 0)) {
        throw new ProjectError(400, 'INVALID_MEDIA_SIZE', '视频声明长度无效');
      }
      await this.prepareDirectory();
      await this.checkSpace(declared ?? 64 * 1024);
      idle.signal.throwIfAborted();
      const file = path.join(this.directory, `.comfy-${randomUUID()}.tmp`);
      handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      temporary = file;
      const digest = createHash('sha256');
      const prefix = Buffer.alloc(12);
      let prefixLength = 0;
      let size = 0;
      let nextSpaceCheck = 0;
      for (;;) {
        idle.signal.throwIfAborted();
        const next = await Promise.race([reader.read(), aborted]);
        idle.signal.throwIfAborted();
        if (next.done) break;
        if (!next.value.length) continue;
        idle.progress();
        const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
        size += chunk.length;
        if (!Number.isSafeInteger(size)) throw new ProjectError(400, 'INVALID_MEDIA_SIZE', '视频长度超出协议可表示范围');
        if (declared !== undefined && size > declared) throw new ProjectError(400, 'MEDIA_SIZE_MISMATCH', '视频实际长度超过声明');
        if (size >= nextSpaceCheck) {
          await this.checkSpace(declared === undefined ? chunk.length : Math.max(chunk.length, declared - size));
          nextSpaceCheck = size + 4 * 1024 * 1024;
        }
        const copied = Math.min(chunk.length, prefix.length - prefixLength);
        chunk.copy(prefix, prefixLength, 0, copied);
        prefixLength += copied;
        if (prefixLength === prefix.length && !validMediaSignature('video/mp4', prefix)) {
          throw new ProjectError(400, 'MEDIA_TYPE_MISMATCH', '视频结果不是有效的 MP4 签名');
        }
        digest.update(chunk);
        await handle.writeFile(chunk);
        idle.progress();
      }
      if (!validMediaSignature('video/mp4', prefix.subarray(0, prefixLength))) throw new ProjectError(400, 'MEDIA_TYPE_MISMATCH', '视频结果不是有效的 MP4 签名');
      if (declared !== undefined && size !== declared) throw new ProjectError(400, 'MEDIA_SIZE_MISMATCH', '视频实际长度与声明不符');
      await handle.sync();
      await handle.close();
      handle = undefined;
      idle.signal.throwIfAborted();
      idle.close();
      const hash = digest.digest('hex');
      const source = createReadStream(file);
      const sourceClosed = new Promise<void>(resolve => { source.once('close', resolve); });
      const onSourceError = () => {};
      source.on('error', onSourceError);
      try {
        await this.blobs.putStream(hash, source, { size, mime: 'video/mp4', signal, timeoutMs: idleTimeoutMs });
      } finally {
        source.destroy();
        await sourceClosed;
        source.removeListener('error', onSourceError);
      }
      return { hash, size, mime: 'video/mp4' };
    } catch (error) {
      if (['ENOSPC', 'EDQUOT'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
        throw new ProjectError(507, 'MEDIA_STORAGE_FULL', '结果落盘空间不足，生成结果保留上游');
      }
      throw error;
    } finally {
      idle.close();
      idle.signal.removeEventListener('abort', onAbort);
      cancel();
      reader?.releaseLock();
      try { await handle?.close(); }
      finally { if (temporary) await unlink(temporary); }
    }
  }

  async read(result: { hash: string; size: number }): Promise<Readable | null> {
    return this.blobs.verifiedRead(result.hash, result.size);
  }
}
