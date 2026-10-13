import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { IncomingMessage } from 'node:http';
import { lstat, mkdir, open, rename, statfs, unlink, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, idSchema, entityTypeSchema, ProjectError, sendError, type ProjectRuntime } from '../projects/protocol.js';
import { projectId } from '../projects/routes.js';
import type { ProjectStore } from '../projects/store.js';
import { assertMediaMemory, decodeLegacyMedia, MediaAdmission, mediaIdleWatchdog, readLegacyMediaJson } from './resources.js';

const MiB = 1024 * 1024;
// Public sizes use safe JS/SQLite integers. This is representability, not a storage quota.
export const legacyMediaMaxBytes = Number.MAX_SAFE_INTEGER;
export const hardMediaMaxBytes = Number.MAX_SAFE_INTEGER;
export interface MediaQuota { projectBytes?: number; ownerBytes?: number }
export interface MediaPolicy {
  /** Deprecated capacity fields retained in the public shape; no business quota is enforced. */
  maxFileBytes: number;
  projectBytes: number;
  ownerBytes: number;
  maxConcurrentUploads: number;
  maxConcurrentPerUser: number;
  maxReservedBytes: number;
  maxReservedPerUserBytes: number;
  uploadTimeoutMs: number;
}
export const defaultMediaQuota = { projectBytes: Number.MAX_SAFE_INTEGER, ownerBytes: Number.MAX_SAFE_INTEGER };
export function resolveMediaPolicy(input: Partial<Record<keyof MediaPolicy, number | string>> = {}): MediaPolicy {
  const defaults: MediaPolicy = { maxFileBytes: Number.MAX_SAFE_INTEGER, ...defaultMediaQuota, maxConcurrentUploads: 4, maxConcurrentPerUser: 2, maxReservedBytes: Number.MAX_SAFE_INTEGER, maxReservedPerUserBytes: Number.MAX_SAFE_INTEGER, uploadTimeoutMs: 15 * 60 * 1000 };
  const policy = { ...defaults };
  const deprecated = new Set<keyof MediaPolicy>(['maxFileBytes', 'projectBytes', 'ownerBytes', 'maxReservedBytes', 'maxReservedPerUserBytes']);
  for (const key of Object.keys(defaults) as (keyof MediaPolicy)[]) {
    if (deprecated.has(key)) continue;
    if (input[key] !== undefined) {
      const value = Number(input[key]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Media policy ${key} must be a positive safe integer`);
      policy[key] = value;
    }
  }
  return policy;
}
export interface BlobStreamOptions { size: number; mime: string; maxBytes?: number; signal?: AbortSignal; timeoutMs?: number }
export interface PrivateBlobStore {
  put(hash: string, bytes: Buffer): Promise<void>;
  get(hash: string): Promise<Buffer | null>;
  putStream?(hash: string, source: AsyncIterable<Uint8Array>, options: BlobStreamOptions): Promise<void>;
  verifiedRead?(hash: string, expectedSize: number): Promise<Readable | null>;
}
const mimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'video/mp4', 'video/quicktime', 'video/webm', 'audio/mpeg', 'audio/wav', 'application/pdf'] as const;
export function validMediaSignature(mime: string, bytes: Buffer): boolean {
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  if (mime === 'video/mp4' || mime === 'video/quicktime') return bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
  if (mime === 'audio/wav') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  if (mime === 'audio/mpeg') return bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 255 && bytes[1] !== undefined && (bytes[1] & 224) === 224);
  if (mime === 'application/pdf') return bytes.toString('ascii', 0, 5) === '%PDF-';
  return false;
}
function validateHash(hash: string): void { if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectError(400, 'INVALID_HASH', '媒体 SHA-256 标识无效'); }
function checkFileSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new ProjectError(400, 'INVALID_MEDIA_SIZE', '媒体大小无效');
}
function interrupted() { return new ProjectError(400, 'MEDIA_UPLOAD_INTERRUPTED', '媒体传输已中断，请重试'); }
function abortReason(signal?: AbortSignal) { return signal?.reason instanceof ProjectError ? signal.reason : interrupted(); }
function uploadTimeout() { return new ProjectError(408, 'MEDIA_UPLOAD_TIMEOUT', '媒体上传无进展，请检查网络后重试'); }
function isHttpInput(source: unknown): source is IncomingMessage { return source instanceof IncomingMessage || (source instanceof Readable && 'headers' in source && 'method' in source && 'httpVersion' in source); }
function storageError(error: unknown): never {
  if (error instanceof ProjectError) throw error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOSPC' || code === 'EDQUOT') throw new ProjectError(507, 'MEDIA_STORAGE_FULL', '媒体存储空间不足，请稍后重试');
  if (code === 'ELOOP' || code === 'ENOTDIR') throw new ProjectError(400, 'UNSAFE_BLOB_PATH', '媒体存储路径不安全');
  if (code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ECONNRESET') throw interrupted();
  throw new ProjectError(500, 'MEDIA_STORAGE_FAILED', '媒体存储失败，请稍后重试');
}
async function safeDirectory(directory: string, create: boolean): Promise<boolean> {
  const resolved = path.resolve(directory);
  let current = path.parse(resolved).root;
  for (const component of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let info;
    try { info = await lstat(current); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      try { await mkdir(current, { mode: 0o700 }); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new ProjectError(400, 'UNSAFE_BLOB_PATH', '媒体存储目录不能是符号链接');
  }
  return true;
}
async function safeFileInfo(file: string) {
  try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile()) throw new ProjectError(400, 'UNSAFE_BLOB_PATH', '媒体文件不能是符号链接');
    return info;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function consumeMedia(source: AsyncIterable<Uint8Array>, expected: { hash: string; size: number; mime: string; signal?: AbortSignal; timeoutMs?: number }, write: (chunk: Buffer) => Promise<void>): Promise<void> {
  checkFileSize(expected.size);
  if (!mimeTypes.includes(expected.mime as typeof mimeTypes[number])) throw new ProjectError(415, 'UNSUPPORTED_MEDIA_TYPE', '不支持此媒体类型');
  const digest = createHash('sha256');
  const prefix = Buffer.alloc(16);
  let prefixLength = 0; let size = 0; let signatureChecked = false;
  const signatureLength = expected.mime === 'image/jpeg' || expected.mime === 'audio/mpeg' ? 3 : expected.mime === 'video/webm' ? 4 : expected.mime === 'application/pdf' ? 5 : expected.mime === 'image/gif' ? 6 : expected.mime === 'image/png' ? 8 : 12;
  const idle = mediaIdleWatchdog(expected.timeoutMs ?? 15 * 60 * 1000, uploadTimeout, expected.signal);
  const signal = idle.signal;
  let rejectAbort: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  // Race each read, including custom iterators, so a silent sender cannot retain an upload slot forever.
  const abort = () => { const error = abortReason(signal); rejectAbort(error); if (source instanceof Readable) source.destroy(error); };
  if (signal.aborted) { idle.close(); throw abortReason(signal); }
  signal.addEventListener('abort', abort, { once: true });
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) { finished = true; break; }
      const bytes = next.value;
      if (signal.aborted) throw abortReason(signal);
      if (!(bytes instanceof Uint8Array)) throw new ProjectError(400, 'INVALID_MEDIA', '媒体流格式无效');
      const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      size += chunk.length;
      if (!Number.isSafeInteger(size)) throw new ProjectError(400, 'INVALID_MEDIA_SIZE', '媒体长度超出协议可表示范围');
      if (size > expected.size) throw new ProjectError(400, 'MEDIA_SIZE_MISMATCH', '实际媒体大小超过声明大小');
      const copied = Math.min(chunk.length, prefix.length - prefixLength);
      if (copied > 0) { chunk.copy(prefix, prefixLength, 0, copied); prefixLength += copied; }
      if (!signatureChecked && prefixLength >= signatureLength) {
        if (!validMediaSignature(expected.mime, prefix.subarray(0, prefixLength))) throw new ProjectError(400, 'MEDIA_TYPE_MISMATCH', '媒体内容与声明类型不符');
        signatureChecked = true;
      }
      digest.update(chunk);
      idle.progress();
      await write(chunk);
      idle.progress();
    }
    if (signal.aborted) throw abortReason(signal);
    if (size !== expected.size) throw new ProjectError(400, 'MEDIA_SIZE_MISMATCH', '实际媒体大小与声明大小不符');
    if (!signatureChecked) throw new ProjectError(400, 'MEDIA_TYPE_MISMATCH', '媒体内容与声明类型不符');
    if (digest.digest('hex') !== expected.hash) throw new ProjectError(400, 'MEDIA_HASH_MISMATCH', '媒体内容校验失败');
  } finally { idle.close(); signal.removeEventListener('abort', abort); if (!finished) { if (source instanceof Readable) source.destroy(); try { void iterator.return?.().catch(() => {}); } catch {} } }
}
export class LocalPrivateBlobStore implements PrivateBlobStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }
  private file(hash: string) { validateHash(hash); return path.join(this.directory, hash.slice(0, 2), hash); }
  protected openTemporaryFile(file: string): Promise<FileHandle> { return open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  protected async checkAvailableSpace(directory: string, size: number): Promise<void> {
    const info = await statfs(directory, { bigint: true });
    // Actual filesystem capacity, with headroom for SQLite. Concurrent ENOSPC remains explicit.
    if (info.bavail * info.bsize < BigInt(size) + BigInt(64 * MiB)) throw new ProjectError(507, 'MEDIA_STORAGE_FULL', '媒体存储空间不足，请稍后重试');
  }
  async put(hash: string, bytes: Buffer): Promise<void> {
    const mime = mimeTypes.find(type => validMediaSignature(type, bytes.subarray(0, 16)));
    if (!mime) throw new ProjectError(415, 'UNSUPPORTED_MEDIA_TYPE', '不支持此媒体类型');
    return this.putStream(hash, Readable.from([bytes]), { size: bytes.length, mime, maxBytes: legacyMediaMaxBytes });
  }
  async putStream(hash: string, source: AsyncIterable<Uint8Array>, options: BlobStreamOptions): Promise<void> {
    try { await this.writeStream(hash, source, options); }
    finally {
      // Close file/provider streams even when validation/admission precedes their first read.
      // HTTP inputs own the response socket; their route closes it after its error response.
      if (source instanceof Readable && !isHttpInput(source)) source.destroy();
    }
  }
  private async writeStream(hash: string, source: AsyncIterable<Uint8Array>, options: BlobStreamOptions): Promise<void> {
    validateHash(hash); checkFileSize(options.size);
    const file = this.file(hash); const temporary = `${file}.${randomUUID()}.tmp`;
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid media upload timeout');
    const signal = options.signal;
    let handle: FileHandle | undefined;
    try {
      await safeDirectory(path.dirname(file), true); await safeFileInfo(file);
      await this.checkAvailableSpace(path.dirname(file), options.size);
      if (signal?.aborted) throw abortReason(signal);
      handle = await this.openTemporaryFile(temporary);
      await consumeMedia(source, { hash, size: options.size, mime: options.mime, signal, timeoutMs }, async chunk => {
        let offset = 0;
        while (offset < chunk.length) {
          if (signal?.aborted) throw abortReason(signal);
          const written = await handle!.write(chunk, offset, chunk.length - offset, null);
          if (written.bytesWritten <= 0) throw new Error('Media write made no progress');
          offset += written.bytesWritten;
        }
      });
      await handle.sync(); await handle.close(); handle = undefined;
      if (signal?.aborted) throw abortReason(signal);
      await safeDirectory(path.dirname(file), false); await safeFileInfo(file);
      await rename(temporary, file);
      const directory = await open(path.dirname(file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { return storageError(error); }
    finally {
      await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {});
    }
  }
  async verifiedRead(hash: string, expectedSize: number): Promise<Readable | null> {
    const file = this.file(hash); checkFileSize(expectedSize);
    let handle: FileHandle | undefined;
    try {
      if (!await safeDirectory(path.dirname(file), false)) return null;
      const info = await safeFileInfo(file); if (!info) return null;
      if (info.size !== expectedSize) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', '媒体内容损坏或不可用');
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const pinned = await handle.stat();
      if (!pinned.isFile() || pinned.dev !== info.dev || pinned.ino !== info.ino || pinned.size !== expectedSize) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', '媒体内容损坏或不可用');
      const digest = createHash('sha256'); let size = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0, highWaterMark: 64 * 1024 })) {
        size += (chunk as Buffer).length;
        if (size > expectedSize) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', '媒体内容损坏或不可用');
        digest.update(chunk as Buffer);
      }
      if (size !== expectedSize || digest.digest('hex') !== hash || (await handle.stat()).size !== expectedSize) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', '媒体内容损坏或不可用');
      const stream = handle.createReadStream({ autoClose: true, start: 0, highWaterMark: 64 * 1024 }); handle = undefined;
      return stream;
    } catch (error) { return storageError(error); }
    finally { await handle?.close().catch(() => {}); }
  }
  async get(hash: string): Promise<Buffer | null> {
    const file = this.file(hash);
    if (!await safeDirectory(path.dirname(file), false)) return null;
    const info = await safeFileInfo(file); if (!info) return null;
    assertMediaMemory(info.size);
    const stream = await this.verifiedRead(hash, info.size); if (!stream) return null;
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stream) { size += (chunk as Buffer).length; if (size > info.size) { stream.destroy(); throw new ProjectError(404, 'MEDIA_UNAVAILABLE', '媒体大小已变化'); } try { assertMediaMemory(info.size); } catch (error) { stream.destroy(); throw error; } chunks.push(chunk as Buffer); }
    return Buffer.concat(chunks, size);
  }
}
/** Legacy quota arguments no longer impose product capacity; identity/representability checks remain. */
export function checkMediaQuota(db: Database.Database, projectId: string, hash: string, size: number, _quota: MediaQuota = {}): void {
  validateHash(hash); checkFileSize(size);
  const project = db.prepare('SELECT 1 FROM shared_projects WHERE id=?').get(projectId);
  if (!project) throw new ProjectError(404,'PROJECT_UNAVAILABLE','Shared project unavailable');
}
const uploadAdmission = new MediaAdmission();
const metadataSchema = z.object({ generation: z.number().int().positive(), entity: z.object({ type: entityTypeSchema, id: idSchema }).strict(), hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive(), mime: z.enum(mimeTypes) }).strict();
const uploadSchema = z.object({ generation: z.number().int().positive(), assetId: idSchema.optional(), entity: z.object({ type: entityTypeSchema, id: idSchema }).strict().optional(), hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive(), mime: z.enum(mimeTypes), data: z.string().min(1) }).strict().refine(value => Boolean(value.assetId) !== Boolean(value.entity), 'Provide either assetId or entity');
function parseMetadata(header: string | string[] | undefined) {
  if (typeof header !== 'string' || Buffer.byteLength(header) > 4096) throw new ProjectError(400, 'INVALID_MEDIA_METADATA', '媒体元数据请求头无效');
  let decoded: unknown;
  try { decoded = JSON.parse(decodeURIComponent(header)); } catch { throw new ProjectError(400, 'INVALID_MEDIA_METADATA', '媒体元数据请求头无效'); }
  if (decoded && typeof decoded === 'object' && 'mime' in decoded && !mimeTypes.includes((decoded as { mime: typeof mimeTypes[number] }).mime)) throw new ProjectError(415, 'UNSUPPORTED_MEDIA_TYPE', '不支持此媒体类型');
  return metadataSchema.parse(decoded);
}
export function registerSystemMediaRoutes(app: FastifyInstance, options: { runtime: ProjectRuntime; projects: ProjectStore; blobs: PrivateBlobStore; quota?: MediaQuota; mediaPolicy?: Partial<MediaPolicy> }): void {
  const { runtime, projects, blobs } = options;
  const policy = resolveMediaPolicy({ ...options.quota, ...options.mediaPolicy });
  runtime.db.exec(`CREATE TABLE IF NOT EXISTS shared_project_media (project_id TEXT NOT NULL, generation INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, PRIMARY KEY(project_id,generation,entity_type,entity_id,hash));`);
  // Keep the raw parser inside this plugin, so other API mutations retain their JSON parser rules.
  app.register(async scoped => {
    if (scoped.hasContentTypeParser('application/octet-stream')) scoped.removeContentTypeParser('application/octet-stream');
    scoped.addContentTypeParser('application/octet-stream', (_request, payload, done) => { done(null, payload); });
    if (scoped.hasContentTypeParser('application/json')) scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser('application/json', (_request, payload, done) => {
      void readLegacyMediaJson(payload, policy.uploadTimeoutMs).then(value => done(null, value), error => done(error));
    });
    scoped.post('/api/system/projects/:projectId/media', { bodyLimit: Number.MAX_SAFE_INTEGER, onRequest: async request => { runtime.assertRequestOrigin?.(request); const principal = await authenticate(runtime, request); projects.access(projectId(request), principal, true); } }, async (request, reply) => {
      let release: (() => void) | undefined;
      const abort = new AbortController();
      const onAbort = () => abort.abort(interrupted());
      const onClose = () => { if (!reply.raw.writableEnded) onAbort(); };
      request.raw.once('aborted', onAbort);
      reply.raw.once('close', onClose);
      try {
        const principal = await authenticate(runtime, request); const id = projectId(request);
        projects.access(id, principal, true);
        const binary = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/octet-stream';
        const json = binary ? undefined : uploadSchema.parse(request.body);
        const body = binary ? parseMetadata(request.headers['x-media-metadata']) : { generation: json!.generation, entity: json!.entity ?? { type: 'asset' as const, id: json!.assetId! }, hash: json!.hash, size: json!.size, mime: json!.mime };
        checkFileSize(body.size);
        const contentLength = request.headers['content-length'];
        if (binary && contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) !== body.size)) throw new ProjectError(400, 'MEDIA_SIZE_MISMATCH', '媒体长度与声明大小不符');
        if (!blobs.putStream) assertMediaMemory(body.size);
        const check = () => {
          const current = projects.access(id, principal, true); projects.generation(current, body.generation);
          if (!projects.snapshotFromRow(current).entities.some(item => item.type === body.entity.type && item.id === body.entity.id && !item.deleted)) throw new ProjectError(409, 'ENTITY_DELETED', '媒体目标不存在或已删除');
        };
        runtime.db.transaction(() => { check(); checkMediaQuota(runtime.db, id, body.hash, body.size, policy); }).immediate();
        release = await uploadAdmission.acquire(principal.id, policy, abort.signal);
        check(); checkMediaQuota(runtime.db, id, body.hash, body.size, policy);
        if (request.raw.aborted) throw interrupted();
        let source: AsyncIterable<Uint8Array>;
        if (binary) {
          if (!request.body || typeof (request.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') throw new ProjectError(400, 'INVALID_MEDIA', '媒体流格式无效');
          source = request.body as AsyncIterable<Uint8Array>;
        } else {
          source = decodeLegacyMedia(json!.data);
        }
        if (blobs.putStream) await blobs.putStream(body.hash, source, { size: body.size, mime: body.mime, signal: abort.signal, timeoutMs: policy.uploadTimeoutMs });
        else {
          const chunks: Buffer[] = [];
          await consumeMedia(source, { hash: body.hash, size: body.size, mime: body.mime, signal: abort.signal, timeoutMs: policy.uploadTimeoutMs }, async chunk => { assertMediaMemory(body.size); chunks.push(chunk); });
          await blobs.put(body.hash, Buffer.concat(chunks, body.size));
        }
        if (abort.signal.aborted) throw abortReason(abort.signal);
        runtime.db.transaction(() => { check(); checkMediaQuota(runtime.db, id, body.hash, body.size, policy); runtime.db.prepare('INSERT OR IGNORE INTO shared_project_media VALUES(?,?,?,?,?,?,?)').run(id, body.generation, body.entity.type, body.entity.id, body.hash, body.size, body.mime); }).immediate();
        return { ...(json?.assetId ? { assetId: json.assetId } : { entity: body.entity }), hash: body.hash, size: body.size, mime: body.mime };
      } catch (error) {
        if (isHttpInput(request.body) && !request.body.complete) { reply.header('Connection', 'close'); request.body.resume(); }
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code && ['ENOSPC','EDQUOT','ELOOP','ENOTDIR','ABORT_ERR','ERR_STREAM_PREMATURE_CLOSE','ECONNRESET'].includes(code)) { try { storageError(error); } catch (mapped) { return sendError(reply,mapped); } }
        return sendError(reply,error);
      }
      finally { request.raw.removeListener('aborted', onAbort); reply.raw.removeListener('close', onClose); release?.(); }
    });
    scoped.get('/api/system/projects/:projectId/media/:hash', async (request, reply) => {
      let stream: Readable | null | undefined;
      try {
        const principal = await authenticate(runtime, request); const id = projectId(request); const hash = z.string().regex(/^[a-f0-9]{64}$/).parse((request.params as { hash: string }).hash);
        const row = projects.access(id, principal);
        const links = runtime.db.prepare('SELECT entity_type,entity_id,mime,size FROM shared_project_media WHERE project_id=? AND generation=? AND hash=?').all(id, row.generation, hash) as { entity_type: string; entity_id: string; mime: string; size: number }[];
        const entities = projects.snapshotFromRow(row).entities;
        const link = links.find(item => entities.some(entity => entity.type === item.entity_type && entity.id === item.entity_id && !entity.deleted));
        if (!link) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', 'Media unavailable');
        let bytes: Buffer | null | undefined;
        if (blobs.verifiedRead) { stream = await blobs.verifiedRead(hash, link.size); if (!stream) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', 'Media unavailable'); }
        else {
          assertMediaMemory(link.size);
          bytes = await blobs.get(hash);
          if (!bytes || bytes.length !== link.size || createHash('sha256').update(bytes).digest('hex') !== hash) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', 'Media unavailable');
        }
        const current = projects.access(id, principal); projects.generation(current, row.generation);
        if (!projects.snapshotFromRow(current).entities.some(entity => entity.type === link.entity_type && entity.id === link.entity_id && !entity.deleted)) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', 'Media target no longer available');
        const extension = link.mime === 'video/quicktime' ? 'mov' : link.mime === 'audio/mpeg' ? 'mp3' : link.mime.split('/')[1] ?? 'bin';
        return reply.type(link.mime).header('Content-Length', link.size).header('Content-Disposition', `attachment; filename="${hash}.${extension}"`).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(stream ?? bytes);
      } catch (error) { stream?.destroy(); return sendError(reply, error); }
    });
  });
}
