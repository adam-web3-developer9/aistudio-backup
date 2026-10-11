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

const MiB = 1024 * 1024;
export const legacyMediaMaxBytes = 20 * MiB;
export const hardMediaMaxBytes = 1024 * MiB;
export interface MediaQuota { projectBytes?: number; ownerBytes?: number }
export interface MediaPolicy {
  maxFileBytes: number;
  projectBytes: number;
  ownerBytes: number;
  maxConcurrentUploads: number;
  maxConcurrentPerUser: number;
  maxReservedBytes: number;
  maxReservedPerUserBytes: number;
  uploadTimeoutMs: number;
}
export const defaultMediaQuota = { projectBytes: 1024 * MiB, ownerBytes: 2048 * MiB };
export function resolveMediaPolicy(input: Partial<Record<keyof MediaPolicy, number | string>> = {}): MediaPolicy {
  const defaults: MediaPolicy = { maxFileBytes: 256 * MiB, ...defaultMediaQuota, maxConcurrentUploads: 4, maxConcurrentPerUser: 2, maxReservedBytes: 2048 * MiB, maxReservedPerUserBytes: 1024 * MiB, uploadTimeoutMs: 15 * 60 * 1000 };
  const policy = { ...defaults };
  for (const key of Object.keys(defaults) as (keyof MediaPolicy)[]) {
    if (input[key] !== undefined) {
      const value = Number(input[key]);
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Media policy ${key} must be a positive safe integer`);
      policy[key] = value;
    }
  }
  if (policy.maxFileBytes > hardMediaMaxBytes) throw new Error('Media maxFileBytes cannot exceed the hard limit of 1 GiB');
  if (policy.uploadTimeoutMs > 30 * 60 * 1000) throw new Error('Media uploadTimeoutMs cannot exceed 30 minutes');
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
function limitMessage(limit: number) { return `单个共享文件最多 ${limit >= MiB ? `${Number((limit / MiB).toFixed(2))} MiB` : `${limit} 字节`}，请压缩或拆分后重试`; }
function checkFileSize(size: number, maximum: number): void {
  if (!Number.isSafeInteger(size) || size <= 0) throw new ProjectError(400, 'INVALID_MEDIA_SIZE', '媒体大小无效');
  if (size > maximum || size > hardMediaMaxBytes) throw new ProjectError(413, 'MEDIA_TOO_LARGE', limitMessage(Math.min(maximum, hardMediaMaxBytes)), { maxFileBytes: Math.min(maximum, hardMediaMaxBytes) });
}
function interrupted() { return new ProjectError(400, 'MEDIA_UPLOAD_INTERRUPTED', '媒体传输已中断，请重试'); }
function abortReason(signal?: AbortSignal) { return signal?.reason instanceof ProjectError ? signal.reason : interrupted(); }
function uploadTimeout() { return new ProjectError(408, 'MEDIA_UPLOAD_TIMEOUT', '媒体上传超时，请检查网络后重试'); }
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
async function consumeMedia(source: AsyncIterable<Uint8Array>, expected: { hash: string; size: number; mime: string; maximum: number; signal?: AbortSignal }, write: (chunk: Buffer) => Promise<void>): Promise<void> {
  checkFileSize(expected.size, expected.maximum);
  if (!mimeTypes.includes(expected.mime as typeof mimeTypes[number])) throw new ProjectError(415, 'UNSUPPORTED_MEDIA_TYPE', '不支持此媒体类型');
  const digest = createHash('sha256');
  const prefix = Buffer.alloc(16);
  let prefixLength = 0; let size = 0; let signatureChecked = false;
  const signatureLength = expected.mime === 'image/jpeg' || expected.mime === 'audio/mpeg' ? 3 : expected.mime === 'video/webm' ? 4 : expected.mime === 'application/pdf' ? 5 : expected.mime === 'image/gif' ? 6 : expected.mime === 'image/png' ? 8 : 12;
  let rejectAbort: (error: unknown) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  // Race each read, including custom iterators, so a silent sender cannot retain an upload slot forever.
  const abort = () => { const error = abortReason(expected.signal); rejectAbort(error); if (source instanceof Readable) source.destroy(error); };
  if (expected.signal?.aborted) throw abortReason(expected.signal);
  expected.signal?.addEventListener('abort', abort, { once: true });
  const iterator = source[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) { finished = true; break; }
      const bytes = next.value;
      if (expected.signal?.aborted) throw abortReason(expected.signal);
      if (!(bytes instanceof Uint8Array)) throw new ProjectError(400, 'INVALID_MEDIA', '媒体流格式无效');
      const chunk = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      size += chunk.length;
      if (size > expected.maximum || size > hardMediaMaxBytes) throw new ProjectError(413, 'MEDIA_TOO_LARGE', limitMessage(Math.min(expected.maximum, hardMediaMaxBytes)), { maxFileBytes: Math.min(expected.maximum, hardMediaMaxBytes) });
      if (size > expected.size) throw new ProjectError(400, 'MEDIA_SIZE_MISMATCH', '实际媒体大小超过声明大小');
      const copied = Math.min(chunk.length, prefix.length - prefixLength);
      if (copied > 0) { chunk.copy(prefix, prefixLength, 0, copied); prefixLength += copied; }
      if (!signatureChecked && prefixLength >= signatureLength) {
        if (!validMediaSignature(expected.mime, prefix.subarray(0, prefixLength))) throw new ProjectError(400, 'MEDIA_TYPE_MISMATCH', '媒体内容与声明类型不符');
        signatureChecked = true;
      }
      digest.update(chunk);
      await write(chunk);
    }
    if (expected.signal?.aborted) throw abortReason(expected.signal);
    if (size !== expected.size) throw new ProjectError(400, 'MEDIA_SIZE_MISMATCH', '实际媒体大小与声明大小不符');
    if (!signatureChecked) throw new ProjectError(400, 'MEDIA_TYPE_MISMATCH', '媒体内容与声明类型不符');
    if (digest.digest('hex') !== expected.hash) throw new ProjectError(400, 'MEDIA_HASH_MISMATCH', '媒体内容校验失败');
  } finally { expected.signal?.removeEventListener('abort', abort); if (!finished) { if (source instanceof Readable) source.destroy(); try { void iterator.return?.().catch(() => {}); } catch {} } }
}
export class LocalPrivateBlobStore implements PrivateBlobStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }
  private file(hash: string) { validateHash(hash); return path.join(this.directory, hash.slice(0, 2), hash); }
  protected openTemporaryFile(file: string): Promise<FileHandle> { return open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  protected async checkAvailableSpace(directory: string, size: number): Promise<void> {
    const info = await statfs(directory, { bigint: true });
    const reserved = [...activeUploads.values()].reduce((sum, upload) => sum + upload.size, 0);
    // Reserve declared concurrent bytes conservatively and leave 64 MiB for SQLite/other process work.
    if (info.bavail * info.bsize < BigInt(Math.max(size, reserved)) + BigInt(64 * MiB)) throw new ProjectError(507, 'MEDIA_STORAGE_FULL', '媒体存储空间不足，请稍后重试');
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
    validateHash(hash); const maximum = Math.min(options.maxBytes ?? 256 * MiB, hardMediaMaxBytes); checkFileSize(options.size, maximum);
    const file = this.file(hash); const temporary = `${file}.${randomUUID()}.tmp`;
    const timeoutMs = Math.min(options.timeoutMs ?? 15 * 60 * 1000, 30 * 60 * 1000);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid media upload timeout');
    const timeout = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
    const timer = setTimeout(() => timeout.abort(uploadTimeout()), timeoutMs); timer.unref();
    let handle: FileHandle | undefined;
    try {
      await safeDirectory(path.dirname(file), true); await safeFileInfo(file);
      await this.checkAvailableSpace(path.dirname(file), options.size);
      if (signal.aborted) throw abortReason(signal);
      handle = await this.openTemporaryFile(temporary);
      await consumeMedia(source, { hash, size: options.size, mime: options.mime, maximum, signal }, async chunk => {
        let offset = 0;
        while (offset < chunk.length) {
          if (signal.aborted) throw abortReason(signal);
          const written = await handle!.write(chunk, offset, chunk.length - offset, null);
          if (written.bytesWritten <= 0) throw new Error('Media write made no progress');
          offset += written.bytesWritten;
        }
      });
      await handle.sync(); await handle.close(); handle = undefined;
      if (signal.aborted) throw abortReason(signal);
      await safeDirectory(path.dirname(file), false); await safeFileInfo(file);
      await rename(temporary, file);
      const directory = await open(path.dirname(file), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) { return storageError(error); }
    finally {
      clearTimeout(timer);
      await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {});
    }
  }
  async verifiedRead(hash: string, expectedSize: number): Promise<Readable | null> {
    const file = this.file(hash); checkFileSize(expectedSize, hardMediaMaxBytes);
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
    checkFileSize(info.size, legacyMediaMaxBytes);
    const stream = await this.verifiedRead(hash, info.size); if (!stream) return null;
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of stream) { size += (chunk as Buffer).length; if (size > legacyMediaMaxBytes) { stream.destroy(); throw new ProjectError(413, 'MEDIA_TOO_LARGE', '请使用大文件流式读取接口'); } chunks.push(chunk as Buffer); }
    return Buffer.concat(chunks, size);
  }
}
/** Counts retained unique hashes, including disabled projects and previous share generations. */
export function checkMediaQuota(db: Database.Database, projectId: string, hash: string, size: number, quota: MediaQuota = {}): void {
  const projectLimit = quota.projectBytes ?? defaultMediaQuota.projectBytes;
  const ownerLimit = quota.ownerBytes ?? defaultMediaQuota.ownerBytes;
  if (!Number.isSafeInteger(projectLimit) || projectLimit <= 0 || !Number.isSafeInteger(ownerLimit) || ownerLimit <= 0) throw new Error('Media quota limits must be positive safe integers');
  const project = db.prepare('SELECT owner_id FROM shared_projects WHERE id=?').get(projectId) as { owner_id: string } | undefined;
  if (!project) throw new ProjectError(404,'PROJECT_UNAVAILABLE','Shared project unavailable');
  const projectUsage = (db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM (SELECT hash,MAX(size) AS size FROM shared_project_media WHERE project_id=? GROUP BY hash)').get(projectId) as { bytes: number }).bytes;
  const ownerUsage = (db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM (SELECT m.hash,MAX(m.size) AS size FROM shared_project_media m JOIN shared_projects p ON m.project_id=p.id WHERE p.owner_id=? GROUP BY m.hash)').get(project.owner_id) as { bytes: number }).bytes;
  const projectHasHash = Boolean(db.prepare('SELECT 1 FROM shared_project_media WHERE project_id=? AND hash=? LIMIT 1').get(projectId,hash));
  const ownerHasHash = Boolean(db.prepare('SELECT 1 FROM shared_project_media m JOIN shared_projects p ON m.project_id=p.id WHERE p.owner_id=? AND m.hash=? LIMIT 1').get(project.owner_id,hash));
  if (projectUsage + (projectHasHash ? 0 : size) > projectLimit || ownerUsage + (ownerHasHash ? 0 : size) > ownerLimit) throw new ProjectError(413,'MEDIA_QUOTA_EXCEEDED','共享媒体配额不足，请释放配额或联系管理员');
}
interface Reservation { id: string; db: Database.Database; userId: string; ownerId: string; projectId: string; hash: string; size: number }
const activeUploads = new Map<string, Reservation>();
function assertReservedQuota(db: Database.Database, projectId: string, ownerId: string, policy: MediaPolicy): void {
  const projectUsage = (db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM (SELECT hash,MAX(size) AS size FROM shared_project_media WHERE project_id=? GROUP BY hash)').get(projectId) as { bytes: number }).bytes;
  const ownerUsage = (db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM (SELECT m.hash,MAX(m.size) AS size FROM shared_project_media m JOIN shared_projects p ON m.project_id=p.id WHERE p.owner_id=? GROUP BY m.hash)').get(ownerId) as { bytes: number }).bytes;
  const projectPending = new Map<string, number>(); const ownerPending = new Map<string, number>();
  for (const entry of activeUploads.values()) {
    if (entry.db !== db || entry.ownerId !== ownerId) continue;
    if (entry.projectId === projectId && !db.prepare('SELECT 1 FROM shared_project_media WHERE project_id=? AND hash=? LIMIT 1').get(projectId, entry.hash)) projectPending.set(entry.hash, Math.max(projectPending.get(entry.hash) ?? 0, entry.size));
    if (!db.prepare('SELECT 1 FROM shared_project_media m JOIN shared_projects p ON m.project_id=p.id WHERE p.owner_id=? AND m.hash=? LIMIT 1').get(ownerId, entry.hash)) ownerPending.set(entry.hash, Math.max(ownerPending.get(entry.hash) ?? 0, entry.size));
  }
  if (projectUsage + [...projectPending.values()].reduce((sum, bytes) => sum + bytes, 0) > policy.projectBytes || ownerUsage + [...ownerPending.values()].reduce((sum, bytes) => sum + bytes, 0) > policy.ownerBytes) throw new ProjectError(413, 'MEDIA_QUOTA_EXCEEDED', '并发上传超过共享媒体配额，请稍后重试');
}
function reserveUpload(entry: Omit<Reservation, 'id'>, policy: MediaPolicy): () => void {
  const own = [...activeUploads.values()].filter(upload => upload.userId === entry.userId);
  const totalBytes = [...activeUploads.values()].reduce((sum, upload) => sum + upload.size, 0);
  const ownBytes = own.reduce((sum, upload) => sum + upload.size, 0);
  if (activeUploads.size >= policy.maxConcurrentUploads || own.length >= policy.maxConcurrentPerUser || totalBytes + entry.size > policy.maxReservedBytes || ownBytes + entry.size > policy.maxReservedPerUserBytes) throw new ProjectError(429, 'MEDIA_UPLOAD_BUSY', '并发媒体上传已达上限，请稍后重试');
  const id = randomUUID(); activeUploads.set(id, { ...entry, id });
  try { assertReservedQuota(entry.db, entry.projectId, entry.ownerId, policy); }
  catch (error) { activeUploads.delete(id); throw error; }
  return () => { activeUploads.delete(id); };
}
const metadataSchema = z.object({ generation: z.number().int().positive(), entity: z.object({ type: entityTypeSchema, id: idSchema }).strict(), hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive(), mime: z.enum(mimeTypes) }).strict();
const uploadSchema = z.object({ generation: z.number().int().positive(), assetId: idSchema.optional(), entity: z.object({ type: entityTypeSchema, id: idSchema }).strict().optional(), hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive(), mime: z.enum(mimeTypes), data: z.string().min(1).max(28 * MiB) }).strict().refine(value => Boolean(value.assetId) !== Boolean(value.entity), 'Provide either assetId or entity');
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
    scoped.post('/api/system/projects/:projectId/media', { bodyLimit: 29 * MiB, onRequest: async request => { runtime.assertRequestOrigin?.(request); } }, async (request, reply) => {
      let release: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const abort = new AbortController();
      const onAbort = () => abort.abort();
      request.raw.once('aborted', onAbort);
      try {
        const principal = await authenticate(runtime, request); const id = projectId(request);
        const row = projects.access(id, principal, true);
        const binary = request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() === 'application/octet-stream';
        const json = binary ? undefined : uploadSchema.parse(request.body);
        const body = binary ? parseMetadata(request.headers['x-media-metadata']) : { generation: json!.generation, entity: json!.entity ?? { type: 'asset' as const, id: json!.assetId! }, hash: json!.hash, size: json!.size, mime: json!.mime };
        const maximum = binary ? policy.maxFileBytes : Math.min(legacyMediaMaxBytes, policy.maxFileBytes);
        checkFileSize(body.size, maximum);
        const contentLength = request.headers['content-length'];
        if (binary && contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) !== body.size)) throw new ProjectError(400, 'MEDIA_SIZE_MISMATCH', '媒体长度与声明大小不符');
        if (binary && !blobs.putStream && body.size > legacyMediaMaxBytes) throw new ProjectError(501, 'STREAMING_STORE_REQUIRED', '当前媒体存储不支持大文件流式上传');
        const check = () => {
          const current = projects.access(id, principal, true); projects.generation(current, body.generation);
          if (!projects.snapshotFromRow(current).entities.some(item => item.type === body.entity.type && item.id === body.entity.id && !item.deleted)) throw new ProjectError(409, 'ENTITY_DELETED', '媒体目标不存在或已删除');
        };
        runtime.db.transaction(() => { check(); checkMediaQuota(runtime.db, id, body.hash, body.size, policy); release = reserveUpload({ db: runtime.db, userId: principal.id, ownerId: row.owner_id, projectId: id, hash: body.hash, size: body.size }, policy); }).immediate();
        timer = setTimeout(() => abort.abort(uploadTimeout()), policy.uploadTimeoutMs); timer.unref();
        if (request.raw.aborted) throw interrupted();
        let source: AsyncIterable<Uint8Array>;
        if (binary) {
          if (!request.body || typeof (request.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !== 'function') throw new ProjectError(400, 'INVALID_MEDIA', '媒体流格式无效');
          source = request.body as AsyncIterable<Uint8Array>;
        } else {
          if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(json!.data)) throw new ProjectError(400, 'INVALID_MEDIA', '媒体必须使用规范 base64');
          const bytes = Buffer.from(json!.data, 'base64');
          source = Readable.from([bytes]);
        }
        if (blobs.putStream) await blobs.putStream(body.hash, source, { size: body.size, mime: body.mime, maxBytes: maximum, signal: abort.signal, timeoutMs: policy.uploadTimeoutMs });
        else {
          const chunks: Buffer[] = [];
          await consumeMedia(source, { hash: body.hash, size: body.size, mime: body.mime, maximum: Math.min(maximum, legacyMediaMaxBytes), signal: abort.signal }, async chunk => { chunks.push(chunk); });
          await blobs.put(body.hash, Buffer.concat(chunks, body.size));
        }
        if (abort.signal.aborted) throw abortReason(abort.signal);
        runtime.db.transaction(() => { check(); checkMediaQuota(runtime.db, id, body.hash, body.size, policy); assertReservedQuota(runtime.db, id, row.owner_id, policy); runtime.db.prepare('INSERT OR IGNORE INTO shared_project_media VALUES(?,?,?,?,?,?,?)').run(id, body.generation, body.entity.type, body.entity.id, body.hash, body.size, body.mime); }).immediate();
        return { ...(json?.assetId ? { assetId: json.assetId } : { entity: body.entity }), hash: body.hash, size: body.size, mime: body.mime };
      } catch (error) {
        if (isHttpInput(request.body) && !request.body.complete) { reply.header('Connection', 'close'); request.body.resume(); }
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code && ['ENOSPC','EDQUOT','ELOOP','ENOTDIR','ABORT_ERR','ERR_STREAM_PREMATURE_CLOSE','ECONNRESET'].includes(code)) { try { storageError(error); } catch (mapped) { return sendError(reply,mapped); } }
        return sendError(reply,error);
      }
      finally { if (timer) clearTimeout(timer); request.raw.removeListener('aborted', onAbort); release?.(); }
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
          if (link.size > legacyMediaMaxBytes) throw new ProjectError(501, 'STREAMING_STORE_REQUIRED', '当前媒体存储不支持大文件流式下载');
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
