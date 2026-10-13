import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SystemRuntime } from '../system/runtime.js';
import { SystemError } from '../system/types.js';
import { PackageShareStore } from './store.js';
import type { PackageStorage, PackageUpload } from './types.js';

const id = z.string().min(1).max(200);
const requestId = id;
const scopeSchema = z.object({ kind: z.enum(['all', 'selected-episodes']), episodeIds: z.array(id), sourceEpisodeCount: z.int().nonnegative(),
  assetOrigins: z.array(z.object({ assetId: id, episodeId: id.optional(), sourceEpisodeIds: z.array(id).optional(), validFrom: z.string().optional(), validUntil: z.string().optional() }).strict()).optional()
}).strict().superRefine((scope, ctx) => {
  if (new Set(scope.episodeIds).size !== scope.episodeIds.length || (scope.kind === 'all' ? scope.sourceEpisodeCount !== scope.episodeIds.length : !scope.episodeIds.length || scope.sourceEpisodeCount <= scope.episodeIds.length)) ctx.addIssue({ code: 'custom', message: 'Invalid episode scope' });
  if (scope.assetOrigins && new Set(scope.assetOrigins.map(origin => origin.assetId)).size !== scope.assetOrigins.length) ctx.addIssue({ code: 'custom', message: 'Duplicate asset origins' });
});
const uploadBody = z.object({ requestId, draftId: id, title: z.string().min(1), size: z.int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), scope: scopeSchema, baseVersionId: id.nullable().optional() }).strict();
const partNumber = z.int().positive();
const completedParts = z.array(z.object({ partNumber, etag: z.string().min(1).max(512) }).strict()).min(1);
const paramsOf = (request: FastifyRequest) => z.object({ shareId: id, uploadId: id.optional(), versionId: id.optional(), userId: id.optional() }).parse(request.params);
function publicUpload(upload: PackageUpload) {
  const { uploadId, shareId, draftId, title, size, sha256, partSize, partCount, status, expiresAt, versionId, scope, baseVersionId } = upload;
  return { uploadId, shareId, draftId, sourceDraftId: draftId, title, size, sha256, partSize, partCount, status, expiresAt, versionId, scope, baseVersionId };
}
function planParts(size: number, storage: PackageStorage) {
  const { minPartBytes, maxPartBytes, maxParts, maxObjectBytes } = storage.multipartLimits;
  if (![minPartBytes, maxPartBytes, maxParts].every(value => Number.isSafeInteger(value) && value > 0) || maxPartBytes < minPartBytes) throw new SystemError(503, 'PACKAGE_STORAGE_INVALID', '对象存储分片协议配置无效');
  const partSize = Math.max(minPartBytes, Math.ceil(size / maxParts));
  if (partSize > maxPartBytes || maxObjectBytes !== undefined && size > maxObjectBytes) throw new SystemError(413, 'PACKAGE_STORAGE_PROTOCOL_LIMIT', '文件超过当前对象存储协议支持范围');
  return { partSize, partCount: Math.ceil(size / partSize) };
}
const sizeOfPart = (upload: PackageUpload, number: number) => Math.min(upload.partSize, upload.size - (number - 1) * upload.partSize);
const etagValue = (value: string) => value.replace(/^"|"$/g, '');

export function registerPackageShareRoutes(app: FastifyInstance, options: { runtime: SystemRuntime; enabled?: boolean; storage?: PackageStorage | null; clock?: () => number }) {
  const { runtime } = options;
  const store = new PackageShareStore(runtime.db, options.clock);
  const enabled = options.enabled === true;
  const locks = new Map<string, Promise<unknown>>();
  async function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = locks.get(key);
    const pending = (previous ? previous.then(run, run) : run());
    locks.set(key, pending);
    try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
  }
  const storage = () => {
    if (!enabled) throw new SystemError(503, 'PACKAGE_SHARES_DISABLED', '整包共享尚未启用');
    if (!options.storage) throw new SystemError(503, 'PACKAGE_STORAGE_UNAVAILABLE', '整包共享私有存储尚未配置');
    return options.storage;
  };
  const current = (principal: Awaited<ReturnType<SystemRuntime['authenticate']>>) => runtime.assertPrincipalCurrent(principal);
  const actor = async (request: FastifyRequest) => {
    storage();
    const principal = await runtime.authenticate(request);
    store.assertEligible(principal); return principal;
  };
  const initialize = (shareId: string, uploadId: string, principal: Awaited<ReturnType<SystemRuntime['authenticate']>>) => serial(uploadId, async () => {
    let fresh = store.uploadAccess(shareId, uploadId, current(principal), true);
    if (fresh.status !== 'initializing') return publicUpload(fresh);
    const token = store.claimInitialization(uploadId);
    if (!token) return publicUpload(fresh);
    let receiptPersisted = false;
    try {
      // The provider resumes an existing multipart session for this immutable server object key.
      const begun = await storage().begin({ objectKey: fresh.objectKey, size: fresh.size, sha256: fresh.sha256, contentType: 'application/zip' });
      receiptPersisted = store.initialized(uploadId, begun.uploadId, token);
      const persisted = store.upload(shareId, uploadId);
      if (!receiptPersisted && (persisted.status === 'cancelled' || persisted.storageUploadId && persisted.storageUploadId !== begun.uploadId)) await storage().abort({ objectKey: persisted.objectKey, uploadId: begun.uploadId });
      fresh = store.uploadAccess(shareId, uploadId, current(principal), true);
      return publicUpload(fresh);
    } finally {
      if (!receiptPersisted) store.releaseInitialization(uploadId, token);
    }
  });
  const route = (method: 'GET' | 'POST' | 'DELETE', url: string, run: (request: FastifyRequest) => unknown | Promise<unknown>) => {
    app.route({ method, url: `/api/system/package-shares${url}`, onRequest: async request => runtime.assertRequestOrigin(request),
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        try { return await run(request); }
        catch (error) {
          if (error instanceof SystemError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
          if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_PACKAGE_SHARE_REQUEST', message: '共享包请求格式无效' });
          request.log.warn({ code: 'PACKAGE_STORAGE_OPERATION_FAILED' }, 'Package storage operation failed');
          return reply.code(502).send({ code: 'PACKAGE_STORAGE_OPERATION_FAILED', message: '对象存储请求失败，可重试未完成步骤' });
        }
      } });
  };
  route('GET', '/capability', async request => {
    const principal = await runtime.authenticate(request);
    return { enabled, storageConfigured: Boolean(options.storage), eligible: principal.cloudEligible,
      allowedStorageHosts: options.storage?.allowedStorageHosts ?? [],
      ...(options.storage ? { multipartLimits: options.storage.multipartLimits } : {}), signedUrlRevocation: '已签发对象地址在短时有效期内可能仍可用，撤权立即阻止新授权' };
  });
  route('GET', '', async request => ({ data: store.list(await actor(request)) }));
  route('POST', '', async request => {
    const principal = await actor(request);
    const share = store.create(principal, z.object({ requestId, draftId: id, title: z.string().min(1) }).strict().parse(request.body));
    runtime.store.audit({ actorId: principal.id, action: 'package.share.create', targetType: 'packageShare', targetId: share.shareId });
    return share;
  });
  route('GET', '/:shareId', async request => {
    const principal = await actor(request); const { shareId } = paramsOf(request);
    const share = store.access(shareId, principal, false, true);
    return { ...store.publicShare(share), members: store.members(shareId).map(member => ({ ...member, email: runtime.store.getIdentity(member.userId)?.email ?? '' })), versions: store.versions(shareId) };
  });
  route('POST', '/:shareId/members', async request => {
    const principal = await actor(request); const { shareId } = paramsOf(request);
    store.access(shareId, principal, true);
    const { email } = z.object({ email: z.string().email() }).strict().parse(request.body);
    const identity = runtime.store.getIdentityByEmail(email);
    if (!identity?.emailVerified || identity.disabled) throw new SystemError(400, 'PACKAGE_MEMBER_UNAVAILABLE', '该邮箱需先注册并验证');
    const members = store.addMember(shareId, principal, identity.id);
    runtime.store.audit({ actorId: principal.id, action: 'package.share.member.add', targetType: 'packageShare', targetId: shareId, metadata: { userId: identity.id } });
    return { members };
  });
  route('DELETE', '/:shareId/members/:userId', async request => {
    const principal = await actor(request); const { shareId, userId } = paramsOf(request);
    const members = store.removeMember(shareId, principal, userId!);
    runtime.store.audit({ actorId: principal.id, action: 'package.share.member.remove', targetType: 'packageShare', targetId: shareId, metadata: { userId } });
    return { members };
  });
  route('DELETE', '/:shareId', async request => store.setDeleted(paramsOf(request).shareId, await actor(request), true));
  route('POST', '/:shareId/restore', async request => store.setDeleted(paramsOf(request).shareId, await actor(request), false));
  route('POST', '/:shareId/uploads', async request => {
    const principal = await actor(request); const { shareId } = paramsOf(request); const input = uploadBody.parse(request.body);
    const provider = storage(); const upload = store.reserveUpload(shareId, principal, { ...input, baseVersionId: input.baseVersionId ?? null, ...planParts(input.size, provider) });
    return initialize(shareId, upload.uploadId, principal);
  });
  route('GET', '/:shareId/uploads/:uploadId', async request => {
    const principal = await actor(request); const { shareId, uploadId } = paramsOf(request);
    const upload = store.uploadAccess(shareId, uploadId!, principal);
    return upload.status === 'initializing' ? initialize(shareId, uploadId!, principal) : publicUpload(upload);
  });
  route('POST', '/:shareId/uploads/:uploadId/parts', async request => {
    const principal = await actor(request); const { shareId, uploadId } = paramsOf(request);
    const upload = store.uploadAccess(shareId, uploadId!, principal, true);
    if (upload.status !== 'uploading' || !upload.storageUploadId) throw new SystemError(409, 'PACKAGE_UPLOAD_NOT_ACTIVE', '上传当前不需要分片');
    const { parts } = z.object({ parts: z.array(z.object({ partNumber, md5Base64: z.string().regex(/^[A-Za-z0-9+/]{22}==$/) }).strict()).min(1) }).strict().parse(request.body);
    if (new Set(parts.map(part => part.partNumber)).size !== parts.length || parts.some(part => part.partNumber > upload.partCount)) throw new SystemError(400, 'PACKAGE_PART_INVALID', '分片序号超出本次文件范围或重复');
    const signed = [];
    for (const part of parts) signed.push({ partNumber: part.partNumber, ...await storage().signPart({ objectKey: upload.objectKey, uploadId: upload.storageUploadId, ...part, size: sizeOfPart(upload, part.partNumber) }) });
    store.uploadAccess(shareId, uploadId!, current(principal), true);
    return { parts: signed };
  });
  route('POST', '/:shareId/uploads/:uploadId/complete', async request => {
    const principal = await actor(request); const { shareId, uploadId } = paramsOf(request);
    const { parts } = z.object({ parts: completedParts }).strict().parse(request.body);
    return serial(uploadId!, async () => {
      const upload = store.uploadAccess(shareId, uploadId!, current(principal), true);
      if (upload.versionId) return { version: store.publicVersion(store.version(shareId, upload.versionId)) };
      if (!upload.storageUploadId) throw new SystemError(409, 'PACKAGE_UPLOAD_NOT_ACTIVE', '上传尚未初始化');
      const provider = storage(); let object = await provider.head(upload.objectKey);
      if (!object) {
        const actual = (await provider.listParts({ objectKey: upload.objectKey, uploadId: upload.storageUploadId })).sort((a, b) => a.partNumber - b.partNumber);
        const requested = [...parts].sort((a, b) => a.partNumber - b.partNumber);
        if (actual.length !== upload.partCount || requested.length !== upload.partCount || actual.some((part, index) => part.partNumber !== index + 1 || requested[index]?.partNumber !== part.partNumber || part.size !== sizeOfPart(upload, part.partNumber) || etagValue(part.etag) !== etagValue(requested[index]!.etag))) throw new SystemError(409, 'PACKAGE_PARTS_INCOMPLETE', '分片长度、序号或ETag不一致，请补传缺失分片');
        store.uploadAccess(shareId, uploadId!, current(principal), true);
        await provider.complete({ objectKey: upload.objectKey, uploadId: upload.storageUploadId, parts: actual.map(({ partNumber, etag }) => ({ partNumber, etag })) });
        object = await provider.head(upload.objectKey);
      }
      if (!object || object.size !== upload.size || object.metadata.sha256 !== upload.sha256) throw new SystemError(409, 'PACKAGE_OBJECT_MISMATCH', '对象存储大小或哈希声明不一致，版本尚未发布');
      const version = store.publish(shareId, uploadId!, current(principal));
      runtime.store.audit({ actorId: principal.id, action: 'package.version.publish', targetType: 'packageShare', targetId: shareId, metadata: { versionId: version.versionId, sequence: version.sequence } });
      return { version };
    });
  });
  route('POST', '/:shareId/uploads/:uploadId/cancel', async request => {
    const principal = await actor(request); const { shareId, uploadId } = paramsOf(request);
    return serial(uploadId!, async () => {
      const upload = store.uploadAccess(shareId, uploadId!, current(principal), false, true);
      if (upload.status === 'completed') throw new SystemError(409, 'PACKAGE_UPLOAD_COMPLETED', '已发布版本无需取消');
      store.cancelled(uploadId!);
      if (upload.storageUploadId) await storage().abort({ objectKey: upload.objectKey, uploadId: upload.storageUploadId });
      return { cancelled: true };
    });
  });
  route('POST', '/:shareId/versions/:versionId/download', async request => {
    const principal = await actor(request); const { shareId, versionId } = paramsOf(request);
    store.access(shareId, principal); const version = store.version(shareId, versionId!);
    const signed = await storage().signDownload({ objectKey: version.objectKey, filename: `${version.versionId}.zip` });
    store.access(shareId, current(principal));
    store.downloadLease(version.versionId, principal.id, signed.expiresAt);
    return { ...store.publicVersion(version), ...signed };
  });
  return store;
}
