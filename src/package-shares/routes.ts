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
  scope: scopeSchema, baseVersionId: id.nullable().optional(), url: z.string().refine(isSafePackageUrl, 'Invalid public package URL') }).strict();
const paramsOf = (request: FastifyRequest) => z.object({ shareId: id, versionId: id.optional(), userId: id.optional() }).parse(request.params);

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
  route('POST', '/:shareId/versions', async request => {
    const principal = await actor(request); const { shareId } = paramsOf(request); const input = versionBody.parse(request.body);
    const version = store.publish(shareId, principal, { ...input, baseVersionId: input.baseVersionId ?? null });
    runtime.store.audit({ actorId: principal.id, action: 'package.version.publish', targetType: 'packageShare', targetId: shareId, metadata: { versionId: version.versionId, sequence: version.sequence } });
    return { version };
  });
  route('POST', '/:shareId/versions/:versionId/download', async request => {
    const principal = await actor(request); const { shareId, versionId } = paramsOf(request);
    store.access(shareId, principal); const version = store.version(shareId, versionId!);
    if (!version.url) throw new SystemError(409, 'PACKAGE_VERSION_REPUBLISH_REQUIRED', '旧私有版本没有公开地址，请重新发布');
    if (!isSafePackageUrl(version.url)) throw new SystemError(409, 'PACKAGE_VERSION_URL_INVALID', '版本地址无效，请重新发布');
    return { ...store.publicVersion(version), url: version.url };
  });
  return store;
}
