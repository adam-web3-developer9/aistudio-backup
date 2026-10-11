import { createHash } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, idSchema, entityTypeSchema, ProjectError, sendError, type ProjectRuntime } from '../projects/protocol.js';
import { projectId } from '../projects/routes.js';
import type { ProjectStore } from '../projects/store.js';

export interface PrivateBlobStore { put(hash: string, bytes: Buffer): Promise<void>; get(hash: string): Promise<Buffer | null> }
export class LocalPrivateBlobStore implements PrivateBlobStore {
  constructor(private readonly directory: string) {}
  private file(hash: string) { if (!/^[a-f0-9]{64}$/.test(hash)) throw new ProjectError(400, 'INVALID_HASH', 'Invalid SHA-256 hash'); return path.join(this.directory, hash.slice(0, 2), hash); }
  async put(hash: string, bytes: Buffer) {
    const file = this.file(hash); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600); try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, file);
      const directory = await open(path.dirname(file), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await unlink(temp).catch(() => {}); }
  }
  async get(hash: string) { try { return await readFile(this.file(hash)); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } }
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
export interface MediaQuota { projectBytes?: number; ownerBytes?: number }
export const defaultMediaQuota = { projectBytes: 1024 * 1024 * 1024, ownerBytes: 2 * 1024 * 1024 * 1024 };
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
  if (projectUsage + (projectHasHash ? 0 : size) > projectLimit || ownerUsage + (ownerHasHash ? 0 : size) > ownerLimit) throw new ProjectError(413,'MEDIA_QUOTA_EXCEEDED','Retained shared media quota exceeded');
}
const uploadSchema = z.object({ generation: z.number().int().positive(), assetId: idSchema.optional(), entity: z.object({ type: entityTypeSchema, id: idSchema }).strict().optional(), hash: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(20 * 1024 * 1024), mime: z.enum(mimeTypes), data: z.string().min(1).max(28 * 1024 * 1024) }).strict().refine(value => Boolean(value.assetId) !== Boolean(value.entity), 'Provide either assetId or entity');
export function registerSystemMediaRoutes(app: FastifyInstance, options: { runtime: ProjectRuntime; projects: ProjectStore; blobs: PrivateBlobStore; quota?: MediaQuota }): void {
  const { runtime, projects, blobs } = options;
  runtime.db.exec(`CREATE TABLE IF NOT EXISTS shared_project_media (project_id TEXT NOT NULL, generation INTEGER NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, PRIMARY KEY(project_id,generation,entity_type,entity_id,hash));`);
  app.post('/api/system/projects/:projectId/media', { bodyLimit: 29 * 1024 * 1024, onRequest: async request => { runtime.assertRequestOrigin?.(request); } }, async (request, reply) => {
    try {
      const principal = await authenticate(runtime, request); const id = projectId(request);
      const row = projects.access(id, principal, true); const body = uploadSchema.parse(request.body); projects.generation(row, body.generation);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data)) throw new ProjectError(400, 'INVALID_MEDIA', 'Media must be canonical base64');
      const bytes = Buffer.from(body.data, 'base64');
      if (bytes.length !== body.size || createHash('sha256').update(bytes).digest('hex') !== body.hash) throw new ProjectError(400, 'MEDIA_HASH_MISMATCH', 'Media size or hash does not match');
      if (!validMediaSignature(body.mime, bytes)) throw new ProjectError(400, 'MEDIA_TYPE_MISMATCH', 'Content signature does not match media type');
      const entity = body.entity ?? { type: 'asset' as const, id: body.assetId! };
      const check = () => { const current = projects.access(id, principal, true); projects.generation(current, body.generation); const snapshot = projects.snapshotFromRow(current); if (!snapshot.entities.some(item => item.type === entity.type && item.id === entity.id && !item.deleted)) throw new ProjectError(409, 'ENTITY_DELETED', 'Media target entity is missing or deleted'); };
      runtime.db.transaction(() => { check(); checkMediaQuota(runtime.db,id,body.hash,body.size,options.quota); }).immediate(); await blobs.put(body.hash, bytes);
      runtime.db.transaction(() => { check(); checkMediaQuota(runtime.db,id,body.hash,body.size,options.quota); runtime.db.prepare('INSERT OR IGNORE INTO shared_project_media VALUES(?,?,?,?,?,?,?)').run(id, body.generation, entity.type, entity.id, body.hash, body.size, body.mime); }).immediate();
      return { ...(body.assetId ? { assetId: body.assetId } : { entity }), hash: body.hash, size: body.size, mime: body.mime };
    } catch (error) { return sendError(reply, error); }
  });
  app.get('/api/system/projects/:projectId/media/:hash', async (request, reply) => {
    try {
      const principal = await authenticate(runtime, request); const id = projectId(request); const hash = z.string().regex(/^[a-f0-9]{64}$/).parse((request.params as { hash: string }).hash);
      const row = projects.access(id, principal);
      const links = runtime.db.prepare('SELECT entity_type,entity_id,mime,size FROM shared_project_media WHERE project_id=? AND generation=? AND hash=?').all(id, row.generation, hash) as { entity_type: string; entity_id: string; mime: string; size: number }[];
      const entities = projects.snapshotFromRow(row).entities;
      const link = links.find(item => entities.some(entity => entity.type === item.entity_type && entity.id === item.entity_id && !entity.deleted));
      if (!link) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', 'Media unavailable');
      const bytes = await blobs.get(hash); const current = projects.access(id, principal); projects.generation(current, row.generation);
      if (!projects.snapshotFromRow(current).entities.some(entity => entity.type === link.entity_type && entity.id === link.entity_id && !entity.deleted)) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', 'Media target no longer available');
      if (!bytes || bytes.length !== link.size || createHash('sha256').update(bytes).digest('hex') !== hash) throw new ProjectError(404, 'MEDIA_UNAVAILABLE', 'Media unavailable');
      return reply.type(link.mime).header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff').send(bytes);
    } catch (error) { return sendError(reply, error); }
  });
}
