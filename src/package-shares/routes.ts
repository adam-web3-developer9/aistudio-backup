import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { SystemRuntime } from '../system/runtime.js';
import { SystemError } from '../system/types.js';
import { PackageShareStore } from './store.js';

const id = z.string().min(1).max(200);
const requestId = id;
const scopeSchema = z.object({ kind: z.enum(['all', 'selected-episodes']), episodeIds: z.array(id), sourceEpisodeCount: z.int().nonnegative(),
  assetOrigins: z.array(z.object({ assetId: id, episodeId: id.optional(), sourceEpisodeIds: z.array(id).optional(), validFrom: z.string().optional(), validUntil: z.string().optional() }).strict()).optional()
}).strict().superRefine((scope, ctx) => {
  if (new Set(scope.episodeIds).size !== scope.episodeIds.length || (scope.kind === 'all' ? scope.sourceEpisodeCount !== scope.episodeIds.length : !scope.episodeIds.length || scope.sourceEpisodeCount <= scope.episodeIds.length)) ctx.addIssue({ code: 'custom', message: 'Invalid episode scope' });
  if (scope.assetOrigins && new Set(scope.assetOrigins.map(origin => origin.assetId)).size !== scope.assetOrigins.length) ctx.addIssue({ code: 'custom', message: 'Duplicate asset origins' });
});
export function isSafePackageUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\x00-\x20\x7f\\]/.test(value) || /%0[ad]/i.test(value)) return false;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; }
  catch { return false; }
}
const versionBody = z.object({ requestId, draftId: id, title: z.string().min(1), size: z.int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.literal('zip').optional(), scope: scopeSchema, baseVersionId: id.nullable().optional(), url: z.string().refine(isSafePackageUrl, 'Invalid public package URL') }).strict();
const mediaIdentity = z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.int().nonnegative() }).strict();
const mediaFact = mediaIdentity.extend({ mime: z.string().min(1), kind: z.string().min(1) });
const publicUrl = z.string().refine(isSafePackageUrl, 'Invalid public package URL');
const manifestBase = { kind: z.literal('manifest'), requestId, draftId: id, title: z.string().min(1), scope: scopeSchema,
  baseVersionId: id.nullable().optional(), snapshot: mediaIdentity.extend({ size: z.int().positive(), url: publicUrl }) };
const manifestBody = z.object({ ...manifestBase, media: z.array(mediaFact) }).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.media.map(item => `${item.sha256}:${item.size}`)).size !== manifest.media.length) ctx.addIssue({ code: 'custom', message: 'Duplicate media identities' });
});
const manifestStageBody = z.object({ ...manifestBase, mediaCount: z.int().nonnegative().max(1_000_000) }).strict();
const stageParams = z.object({ shareId: id, stageId: id });
const paramsOf = (request: FastifyRequest) => z.object({ shareId: id, versionId: id.optional(), userId: id.optional(), claimId: id.optional() }).parse(request.params);

export function registerPackageShareRoutes(app: FastifyInstance, options: { runtime: SystemRuntime; enabled?: boolean; clock?: () => number }) {
  const { runtime } = options;
  const store = new PackageShareStore(runtime.db, options.clock);
  const enabled = options.enabled !== false;
  const actor = async (request: FastifyRequest) => {
    if (!enabled) throw new SystemError(503, 'PACKAGE_SHARES_DISABLED', '整包共享已关闭');
    const principal = runtime.assertPrincipalCurrent(await runtime.authenticate(request));
    store.assertEligible(principal); return principal;
  };
  const route = (method: 'GET' | 'POST' | 'DELETE', url: string, run: (request: FastifyRequest) => unknown | Promise<unknown>) => {
    app.route({ method, url: `/api/system/package-shares${url}`, onRequest: async request => runtime.assertRequestOrigin(request),
      handler: async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        try { return await run(request); }
        catch (error) {
          if (error instanceof SystemError) return reply.code(error.statusCode).send({ code: error.code, message: error.message });
          if (error instanceof z.ZodError) return reply.code(400).send({ code: 'INVALID_PACKAGE_SHARE_REQUEST', message: '共享包请求格式无效' });
          request.log.warn({ code: 'PACKAGE_METADATA_OPERATION_FAILED' }, 'Package metadata operation failed');
          return reply.code(500).send({ code: 'PACKAGE_METADATA_OPERATION_FAILED', message: '共享版本元数据请求失败，可使用同一请求号重试' });
        }
      } });
  };
  route('GET', '/capability', async request => {
    const principal = await runtime.authenticate(request);
    return { enabled, eligible: principal.cloudEligible };
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
  route('POST', '/:shareId/versions/receipt', async request => {
    const principal = await actor(request); const { shareId } = paramsOf(request);
    const input = z.object({ requestId }).strict().parse(request.body);
    return { version: store.receipt(shareId, principal, input.requestId) };
  });
  route('POST', '/:shareId/versions/:versionId/snapshot/repair', async request => {
    const principal = await actor(request); const { shareId, versionId } = paramsOf(request);
    const input = mediaIdentity.extend({ size: z.int().positive(), url: publicUrl }).parse(request.body);
    const version = store.repairSnapshot(shareId, versionId!, principal, input);
    runtime.store.audit({ actorId: principal.id, action: 'package.snapshot.repair', targetType: 'packageShare', targetId: shareId, metadata: { versionId } });
    return { version };
  });
  route('GET', '/:shareId/latest', async request => ({ version: store.latest(paramsOf(request).shareId, await actor(request)) }));
  route('POST', '/:shareId/media/lookup', async request => {
    const principal = await actor(request); const { shareId } = paramsOf(request);
    const { items } = z.object({ items: z.array(mediaIdentity) }).strict().parse(request.body);
    return { items: store.lookupMedia(shareId, principal, items) };
  });
  route('POST', '/:shareId/media/claims', async request => {
    const principal = await actor(request); const { shareId } = paramsOf(request);
    const input = mediaIdentity.extend({ requestId, repair: z.boolean().optional() }).parse(request.body);
    return store.claimMedia(shareId, principal, { ...input, repair: input.repair ?? false });
  });
  route('POST', '/:shareId/media/claims/:claimId/renew', async request => {
    const principal = await actor(request); const { shareId, claimId } = paramsOf(request);
    return store.renewMediaClaim(shareId, claimId!, principal);
  });
  route('POST', '/:shareId/media/claims/:claimId/cancel', async request => {
    const principal = await actor(request); const { shareId, claimId } = paramsOf(request);
    return store.cancelMediaClaim(shareId, claimId!, principal);
  });
  route('POST', '/:shareId/media/claims/:claimId/complete', async request => {
    const principal = await actor(request); const { shareId, claimId } = paramsOf(request);
    const input = z.object({ url: publicUrl, mime: z.string().min(1), kind: z.string().min(1) }).strict().parse(request.body);
    return store.completeMediaClaim(shareId, claimId!, principal, input);
  });
  route('POST', '/:shareId/versions', async request => {
    const principal = await actor(request); const { shareId } = paramsOf(request);
    const input = z.union([manifestBody, versionBody]).parse(request.body);
    const version = input.kind === 'manifest' ? store.publishManifest(shareId, principal, { ...input, baseVersionId: input.baseVersionId ?? null })
      : store.publish(shareId, principal, { ...input, baseVersionId: input.baseVersionId ?? null });
    runtime.store.audit({ actorId: principal.id, action: 'package.version.publish', targetType: 'packageShare', targetId: shareId, metadata: { versionId: version.versionId, sequence: version.sequence } });
    return { version };
  });
  route('POST', '/:shareId/versions/stages', async request => {
    const principal = await actor(request); const { shareId } = paramsOf(request);
    const input = manifestStageBody.parse(request.body);
    return store.stageManifest(shareId, principal, { ...input, baseVersionId: input.baseVersionId ?? null });
  });
  route('POST', '/:shareId/versions/stages/:stageId/media', async request => {
    const principal = await actor(request); const { shareId, stageId } = stageParams.parse(request.params);
    const input = z.object({ offset: z.int().nonnegative(), items: z.array(mediaFact).min(1).max(500) }).strict().parse(request.body);
    return store.appendManifestMedia(shareId, stageId, principal, input.offset, input.items);
  });
  route('POST', '/:shareId/versions/stages/:stageId/commit', async request => {
    const principal = await actor(request); const { shareId, stageId } = stageParams.parse(request.params);
    const version = store.commitManifestStage(shareId, stageId, principal);
    runtime.store.audit({ actorId: principal.id, action: 'package.version.publish', targetType: 'packageShare', targetId: shareId, metadata: { versionId: version.versionId, sequence: version.sequence } });
    return { version };
  });
  route('POST', '/:shareId/versions/:versionId/download', async request => {
    const principal = await actor(request); const { shareId, versionId } = paramsOf(request);
    store.access(shareId, principal); const version = store.version(shareId, versionId!);
    if (version.mediaJson !== undefined) return store.manifestDownload(shareId, versionId!, principal);
    if (!version.url) throw new SystemError(409, 'PACKAGE_VERSION_REPUBLISH_REQUIRED', '旧私有版本没有公开地址，请重新发布');
    if (!isSafePackageUrl(version.url)) throw new SystemError(409, 'PACKAGE_VERSION_URL_INVALID', '版本地址无效，请重新发布');
    return { ...store.publicVersion(version), url: version.url };
  });
  return store;
}
