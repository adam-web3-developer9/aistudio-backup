import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ProjectStore } from './store.js';
import { authenticate, idSchema, memberSchema, requireAdmin, requireCloud, sendError, snapshotInputSchema, commandSchema, ProjectError, type Member, type ProjectRuntime } from './protocol.js';

export const memberInputSchema = z.union([memberSchema, z.object({ email: z.string().email().max(320), role: z.enum(['editor', 'viewer']) }).strict()]);
export async function resolveMembers(runtime: ProjectRuntime, values: z.infer<typeof memberInputSchema>[]): Promise<Member[]> {
  return values.map(value => {
    const identity = 'userId' in value ? runtime.store?.getIdentity(value.userId) : runtime.store?.getIdentityByEmail?.(value.email.trim().toLowerCase());
    if (!identity || typeof identity !== 'object' || !('id' in identity) || !('emailVerified' in identity) || !identity.emailVerified || ('disabled' in identity && identity.disabled)) throw new ProjectError(400, 'MEMBER_UNAVAILABLE', 'One or more members are unavailable');
    return { userId: String(identity.id), role: value.role };
  });
}
export function projectId(request: FastifyRequest) { return idSchema.parse((request.params as { projectId: string }).projectId); }
const pageQuery = z.object({ page: z.coerce.number().int().positive().default(1), pageSize: z.coerce.number().int().positive().max(200).default(50) });
export function registerProjectRoutes(app: FastifyInstance, options: { runtime: ProjectRuntime; store?: ProjectStore }): ProjectStore {
  const { runtime } = options;
  const store = options.store ?? new ProjectStore(runtime.db, runtime.assertPrincipalCurrent ? principal => runtime.assertPrincipalCurrent!(principal) : undefined);
  app.post('/api/system/projects/:projectId/share', { onRequest: async request => { runtime.assertRequestOrigin?.(request); } }, async (request, reply) => {
    try {
      const principal = await authenticate(runtime, request); requireCloud(principal);
      const prior = store.row(projectId(request)); if (prior && prior.owner_id !== principal.id) throw new ProjectError(403, 'PROJECT_FORBIDDEN', 'Only owner may share this project');
      const body = z.object({ requestId: idSchema.optional(), snapshot: snapshotInputSchema, members: z.array(memberInputSchema).max(200) }).strict().parse(request.body);
      const members = await resolveMembers(runtime, body.members);
      return runtime.db.transaction(() => { const snapshot = store.share(projectId(request), principal, body.snapshot, members, body.requestId); runtime.store?.audit({ actorId: principal.id, action: 'project.share', targetType: 'project', targetId: snapshot.projectId, metadata: { generation: snapshot.generation, memberCount: snapshot.members.length } }); return snapshot; }).immediate();
    } catch (error) { return sendError(reply, error); }
  });
  app.get('/api/system/projects/:projectId/snapshot', async (request, reply) => { try { return store.snapshot(projectId(request), await authenticate(runtime, request)); } catch (error) { return sendError(reply, error); } });
  app.get('/api/system/projects/:projectId/changes', async (request, reply) => {
    try { const query = z.object({ generation: z.coerce.number().int().positive(), after: z.coerce.number().int().nonnegative() }).parse(request.query); return store.changes(projectId(request), await authenticate(runtime, request), query.generation, query.after); } catch (error) { return sendError(reply, error); }
  });
  app.post('/api/system/projects/:projectId/commands', { onRequest: async request => { runtime.assertRequestOrigin?.(request); } }, async (request, reply) => {
    try { const result = store.apply(projectId(request), await authenticate(runtime, request), commandSchema.parse(request.body)); return reply.code(result.status).send(result.body); } catch (error) { return sendError(reply, error); }
  });
  app.put('/api/system/projects/:projectId/members', { onRequest: async request => { runtime.assertRequestOrigin?.(request); } }, async (request, reply) => {
    try { const principal = await authenticate(runtime, request); store.access(projectId(request), principal, true, true); const body = z.object({ members: z.array(memberInputSchema).max(200) }).strict().parse(request.body); const members = await resolveMembers(runtime, body.members); return runtime.db.transaction(() => { const data = store.setMembers(projectId(request), principal, members); runtime.store?.audit({ actorId: principal.id, action: 'project.members.replace', targetType: 'project', targetId: projectId(request), metadata: { memberCount: data.length } }); return { members: data }; }).immediate(); } catch (error) { return sendError(reply, error); }
  });
  app.delete('/api/system/projects/:projectId/share', { onRequest: async request => { runtime.assertRequestOrigin?.(request); } }, async (request, reply) => {
    try { const principal = await authenticate(runtime, request); return runtime.db.transaction(() => { const result = store.disable(projectId(request), principal); runtime.store?.audit({ actorId: principal.id, action: 'project.disable', targetType: 'project', targetId: projectId(request) }); return result; }).immediate(); } catch (error) { return sendError(reply, error); }
  });
  app.get('/api/system/projects', async (request, reply) => {
    try { const principal = await authenticate(runtime, request); requireCloud(principal); const query = pageQuery.parse(request.query); const rows = runtime.db.prepare('SELECT p.id AS projectId,p.owner_id AS ownerId,p.generation,p.revision,m.role FROM shared_projects p JOIN shared_project_members m ON p.id=m.project_id WHERE p.shared=1 AND m.user_id=? ORDER BY p.updated_at DESC LIMIT ? OFFSET ?').all(principal.id, query.pageSize, (query.page - 1) * query.pageSize); const total = (runtime.db.prepare('SELECT count(*) AS n FROM shared_projects p JOIN shared_project_members m ON p.id=m.project_id WHERE p.shared=1 AND m.user_id=?').get(principal.id) as { n: number }).n; return { data: rows,total }; } catch (error) { return sendError(reply, error); }
  });
  app.get('/api/admin/projects', async (request, reply) => {
    try { const principal = await authenticate(runtime, request); requireAdmin(principal); const query = pageQuery.parse(request.query); const rows = runtime.db.prepare('SELECT id AS projectId,owner_id AS ownerId,shared,generation,revision,updated_at AS updatedAt FROM shared_projects ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(query.pageSize, (query.page - 1) * query.pageSize) as { projectId: string; shared: number }[]; const total = (runtime.db.prepare('SELECT count(*) AS n FROM shared_projects').get() as { n: number }).n; return { data: rows.map(row => ({ ...row, shared: Boolean(row.shared), members: store.members(row.projectId), canManageMembers: principal.adminRole !== 'readonly' })), total }; } catch (error) { return sendError(reply, error); }
  });
  const adminMember = async (request: FastifyRequest, remove: boolean) => {
    const principal = await authenticate(runtime, request); requireAdmin(principal, true);
    const id = projectId(request); const userId = idSchema.parse((request.params as { userId: string }).userId);
    const row = store.row(id); if (!row) throw new ProjectError(404, 'PROJECT_UNAVAILABLE', 'Project unavailable');
    if (row.owner_id === userId) throw new ProjectError(400, 'OWNER_IMMUTABLE', 'Owner membership cannot be changed');
    const role = remove ? undefined : z.object({ role: z.enum(['editor', 'viewer']) }).strict().parse(request.body).role;
    if (!remove) {
      const current = runtime.db.prepare('SELECT role FROM shared_project_members WHERE project_id=? AND user_id=?').get(id,userId) as { role: string } | undefined;
      if (!current || current.role === 'viewer' && role === 'editor') throw new ProjectError(403, 'OWNER_AUTHORIZATION_REQUIRED', 'Only the project owner may add members or elevate project access');
    }
    return runtime.db.transaction(() => {
      if (remove) runtime.db.prepare('DELETE FROM shared_project_members WHERE project_id=? AND user_id=?').run(id, userId);
      else runtime.db.prepare('INSERT INTO shared_project_members VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role').run(id, userId, role!);
      store.cancelRevokedJobs(id);
      runtime.store?.audit({ actorId: principal.id, action: remove ? 'project.member.remove' : 'project.member.grant', targetType: 'project', targetId: id, metadata: { userId, ...(role ? { role } : {}) } });
      return { projectId: id, members: store.members(id) };
    }).immediate();
  };
  app.put('/api/admin/projects/:projectId/members/:userId', { onRequest: async request => { runtime.assertRequestOrigin?.(request); } }, async (request, reply) => { try { return await adminMember(request, false); } catch (error) { return sendError(reply, error); } });
  app.delete('/api/admin/projects/:projectId/members/:userId', { onRequest: async request => { runtime.assertRequestOrigin?.(request); } }, async (request, reply) => { try { return await adminMember(request, true); } catch (error) { return sendError(reply, error); } });
  return store;
}
