import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ProjectError, assertSafeWire, canonicalHash, entityTypeSchema, idSchema, type ProjectPrincipal } from '../projects/protocol.js';
import type { ProjectStore } from '../projects/store.js';
export const createSystemJobSchema = z.object({ requestId: idSchema, generation: z.number().int().positive(), target: z.object({ type: entityTypeSchema, id: idSchema }).strict(), inputVersion: z.number().int().nonnegative(), executor: z.enum(['server', 'local']), executorSessionId: z.string().min(1).max(200).optional(), kind: idSchema, parameters: z.record(z.string(), z.unknown()).default({}) }).strict();
export type CreateSystemJob = z.infer<typeof createSystemJobSchema>;
export interface SystemJobRow { id: string; project_id: string; generation: number; actor_id: string; request_id: string; payload_hash: string; target_type: string; target_id: string; input_version: number; input: string; executor: 'server' | 'local'; executor_session: string | null; kind: string; status: string; attempt: number; fence: number; lease_hash: string | null; lease_until: number | null; result: string | null; error_code: string | null; created_at: string; updated_at: string }
export function publicSystemJob(row: SystemJobRow) { return { id: row.id, projectId: row.project_id, generation: row.generation, target: { type: row.target_type, id: row.target_id }, inputVersion: row.input_version, executor: row.executor, kind: row.kind, status: row.status, attempt: row.attempt, createdAt: row.created_at, updatedAt: row.updated_at, errorCode: row.error_code }; }
export interface Lease { fence: number; leaseToken: string }
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export class SystemJobStore {
  constructor(public readonly db: Database.Database, public readonly projects: ProjectStore, private readonly clock: () => number = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS system_jobs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, generation INTEGER NOT NULL, actor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, input_version INTEGER NOT NULL, input TEXT NOT NULL, executor TEXT NOT NULL, executor_session TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, attempt INTEGER NOT NULL, fence INTEGER NOT NULL, lease_hash TEXT, lease_until INTEGER, result TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,actor_id,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS system_job_active_target ON system_jobs(project_id,target_type,target_id) WHERE status IN ('queued','running','uncertain');
      CREATE TABLE IF NOT EXISTS system_job_results (job_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,candidate_id TEXT NOT NULL, result TEXT NOT NULL,created_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,fence INTEGER NOT NULL DEFAULT 0,lease_hash TEXT);`);
    const resultColumns = (db.prepare("PRAGMA table_info(system_job_results)").all() as { name: string }[]).map(column => column.name);
    for (const [name, definition] of [["revision", "INTEGER NOT NULL DEFAULT 0"], ["fence", "INTEGER NOT NULL DEFAULT 0"], ["lease_hash", "TEXT"]]) if (!resultColumns.includes(name!)) db.exec(`ALTER TABLE system_job_results ADD COLUMN ${name} ${definition}`);
  }
  row(id: string) { return this.db.prepare('SELECT * FROM system_jobs WHERE id=?').get(id) as SystemJobRow | undefined; }
  access(projectId: string, jobId: string, principal: ProjectPrincipal, write = false) {
    const project = this.projects.access(projectId, principal, write); const row = this.row(jobId);
    if (!row || row.project_id !== projectId) throw new ProjectError(404, 'JOB_UNAVAILABLE', 'Job unavailable');
    this.projects.generation(project, row.generation); return row;
  }
  create(projectId: string, principal: ProjectPrincipal, body: CreateSystemJob) {
    assertSafeWire(body.parameters);
    if (body.executor === 'local' && body.executorSessionId !== undefined && body.executorSessionId !== principal.sessionId) throw new ProjectError(403, 'EXECUTOR_SESSION_MISMATCH', 'Local executor must be the current account session');
    if (body.executor === 'server' && body.executorSessionId) throw new ProjectError(400, 'INVALID_EXECUTOR', 'Server execution does not accept a client session');
    return this.db.transaction(() => {
      const project = this.projects.access(projectId, principal, true); this.projects.generation(project, body.generation);
      const payloadHash = canonicalHash(body);
      const prior = this.db.prepare('SELECT * FROM system_jobs WHERE project_id=? AND actor_id=? AND request_id=?').get(projectId, principal.id, body.requestId) as SystemJobRow | undefined;
      if (prior) { if (prior.payload_hash !== payloadHash) throw new ProjectError(409, 'REQUEST_ID_REUSED', 'Request ID was already used with another payload'); return { job: publicSystemJob(prior), created: false }; }
      if (project.revision !== body.inputVersion) throw new ProjectError(409, 'INPUT_VERSION_CHANGED', 'Confirmed input revision changed', { revision: project.revision });
      const snapshot = this.projects.snapshotFromRow(project); const target = snapshot.entities.find(entity => entity.type === body.target.type && entity.id === body.target.id && !entity.deleted);
      if (!target) throw new ProjectError(409, 'ENTITY_DELETED', 'Job target is missing or deleted');
      const active = this.db.prepare("SELECT id FROM system_jobs WHERE project_id=? AND target_type=? AND target_id=? AND status IN ('queued','running','uncertain')").get(projectId, body.target.type, body.target.id) as { id: string } | undefined;
      if (active) throw new ProjectError(409, 'TARGET_CLAIMED', 'Target already has an active attempt', { jobId: active.id });
      const attempt = ((this.db.prepare('SELECT MAX(attempt) AS n FROM system_jobs WHERE project_id=? AND target_type=? AND target_id=?').get(projectId, body.target.type, body.target.id) as { n: number | null }).n ?? 0) + 1;
      const id = randomUUID(); const now = new Date(this.clock()).toISOString(); const input = JSON.stringify({ entity: target, revision: project.revision, generation: project.generation, parameters: body.parameters });
      this.db.prepare('INSERT INTO system_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, projectId, project.generation, principal.id, body.requestId, payloadHash, body.target.type, body.target.id, project.revision, input, body.executor, body.executor === 'local' ? principal.sessionId : null, body.kind, 'queued', attempt, 0, null, null, null, null, now, now);
      return { job: publicSystemJob(this.row(id)!), created: true };
    }).immediate();
  }
  list(projectId: string, principal: ProjectPrincipal) { const project = this.projects.access(projectId, principal); return { data: (this.db.prepare('SELECT * FROM system_jobs WHERE project_id=? AND generation=? ORDER BY created_at DESC LIMIT 200').all(projectId, project.generation) as SystemJobRow[]).map(publicSystemJob) }; }
  claim(projectId: string, jobId: string, principal: ProjectPrincipal, leaseMs = 60000, server = false) {
    return this.db.transaction(() => {
      const row = this.access(projectId, jobId, principal, true);
      if (row.executor === 'server' && !server) throw new ProjectError(403, 'SERVER_EXECUTOR_ONLY', 'Server jobs can only be claimed by the trusted runner');
      if (row.executor === 'local' && (server || row.actor_id !== principal.id || row.executor_session !== principal.sessionId)) throw new ProjectError(403, 'EXECUTOR_SESSION_MISMATCH', 'This session is not the designated executor');
      const now = this.clock();
      if (row.status === 'running' && (row.lease_until ?? 0) > now) throw new ProjectError(409, 'LEASE_HELD', 'Execution lease is held');
      if (row.status !== 'queued' && row.status !== 'running') throw new ProjectError(409, 'JOB_TERMINAL', 'Job cannot be claimed');
      if (row.executor === 'server' && row.status === 'running') throw new ProjectError(409, 'UPSTREAM_OUTCOME_UNCERTAIN', 'An expired server lease must reconcile upstream outcome before retry');
      const leaseToken = randomBytes(32).toString('hex'); const fence = row.fence + 1; const leaseUntil = now + this.leaseDuration(leaseMs);
      this.db.prepare("UPDATE system_jobs SET status='running',fence=?,lease_hash=?,lease_until=?,updated_at=? WHERE id=?").run(fence, tokenHash(leaseToken), leaseUntil, new Date(now).toISOString(), jobId);
      return { job: publicSystemJob(this.row(jobId)!), fence, leaseToken, leaseUntil, input: JSON.parse(row.input) as Record<string, unknown> };
    }).immediate();
  }
  claimServer(jobId: string, principal: ProjectPrincipal, leaseMs = 60000) { const row = this.row(jobId); if (!row) throw new ProjectError(404, 'JOB_UNAVAILABLE', 'Job unavailable'); return this.claim(row.project_id, jobId, principal, leaseMs, true); }
  private leaseDuration(ms: number) { if (!Number.isInteger(ms) || ms < 1000 || ms > 300000) throw new ProjectError(400, 'INVALID_LEASE', 'Lease duration must be 1000 to 300000 milliseconds'); return ms; }
  private verifyLease(row: SystemJobRow, principal: ProjectPrincipal, lease: Lease, server: boolean) {
    if (row.executor === 'server' && !server) throw new ProjectError(403, 'SERVER_EXECUTOR_ONLY', 'Trusted server executor required');
    if (row.executor === 'local' && (server || row.actor_id !== principal.id || row.executor_session !== principal.sessionId)) throw new ProjectError(403, 'EXECUTOR_SESSION_MISMATCH', 'This session is not the designated executor');
    if (row.status !== 'running' || row.fence !== lease.fence || row.lease_hash !== tokenHash(lease.leaseToken) || (row.lease_until ?? 0) <= this.clock()) throw new ProjectError(409, 'STALE_LEASE', 'Lease expired, canceled or fenced out');
  }
  heartbeat(projectId: string, jobId: string, principal: ProjectPrincipal, lease: Lease, leaseMs = 60000, server = false) {
    return this.db.transaction(() => { const row = this.access(projectId, jobId, principal, true); this.verifyLease(row, principal, lease, server); const leaseUntil = this.clock() + this.leaseDuration(leaseMs); this.db.prepare('UPDATE system_jobs SET lease_until=?,updated_at=? WHERE id=?').run(leaseUntil, new Date(this.clock()).toISOString(), jobId); return { leaseUntil }; }).immediate();
  }
  complete(projectId: string, jobId: string, principal: ProjectPrincipal, lease: Lease, result: Record<string, unknown>, server = false) {
    assertSafeWire(result);
    return this.db.transaction(() => {
      const row = this.access(projectId, jobId, principal, true);
      const receipt = this.db.prepare('SELECT * FROM system_job_results WHERE job_id=?').get(jobId) as { candidate_id: string;result: string;revision: number;fence: number;lease_hash: string } | undefined;
      if (receipt) {
        if (row.executor === 'server' && !server || row.executor === 'local' && (server || row.actor_id !== principal.id || row.executor_session !== principal.sessionId)) throw new ProjectError(403, 'EXECUTOR_SESSION_MISMATCH', 'Designated executor required');
        if (receipt.fence !== lease.fence || receipt.lease_hash !== tokenHash(lease.leaseToken) || canonicalHash(JSON.parse(receipt.result)) !== canonicalHash(result)) throw new ProjectError(409, 'RESULT_ID_REUSED', 'Completion receipt does not match the original result or lease');
        return { job: publicSystemJob(row), candidateId: receipt.candidate_id,revision: receipt.revision };
      }
      this.verifyLease(row, principal, lease, server);
      const project = this.projects.access(projectId, principal, true); const snapshot = this.projects.snapshotFromRow(project); const entity = snapshot.entities.find(entity => entity.type === row.target_type && entity.id === row.target_id && !entity.deleted);
      if (!entity) throw new ProjectError(409, 'ENTITY_DELETED', 'Late result cannot recreate a deleted target');
      const candidateId = `job:${row.id}`; const now = new Date(this.clock()).toISOString();
      const revision = project.revision + 1;
      this.db.prepare('INSERT INTO system_job_results(job_id,project_id,candidate_id,result,created_at,revision,fence,lease_hash) VALUES(?,?,?,?,?,?,?,?)').run(row.id, projectId, candidateId, JSON.stringify(result), now, revision, lease.fence, tokenHash(lease.leaseToken));
      if (row.executor === 'local' && result.localCompleted === true) {
        this.db.prepare("UPDATE system_job_results SET revision=? WHERE job_id=?").run(project.revision,jobId);
        this.db.prepare("UPDATE system_jobs SET status='succeeded',result=?,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(JSON.stringify(result),now,jobId);
        return { job: publicSystemJob(this.row(jobId)!),candidateId,revision:project.revision };
      }
      const candidates = entity.fields.resultCandidates && typeof entity.fields.resultCandidates === 'object' && !Array.isArray(entity.fields.resultCandidates) ? entity.fields.resultCandidates as Record<string, unknown> : {};
      candidates[candidateId] = { value: result, jobId: row.id, inputVersion: row.input_version, attempt: row.attempt }; entity.fields.resultCandidates = candidates;
      entity.versions.resultCandidates = revision; snapshot.revision = revision;
      this.db.prepare('UPDATE shared_projects SET revision=?,snapshot=?,updated_at=? WHERE id=?').run(revision, JSON.stringify(snapshot), now, projectId);
      this.db.prepare('INSERT INTO shared_project_changes VALUES(?,?,?,?,?)').run(projectId, project.generation, revision, candidateId, JSON.stringify([{ kind: 'appendResult', type: row.target_type, id: row.target_id, candidateId, value: result, jobId: row.id, inputVersion: row.input_version, attempt: row.attempt }]));
      this.db.prepare("UPDATE system_jobs SET status='succeeded',result=?,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(JSON.stringify(result), now, jobId);
      return { job: publicSystemJob(this.row(jobId)!), candidateId, revision };
    }).immediate();
  }
  /** Reconcile a proven upstream success; this method never submits generation again. */
  reconcileCompleted(jobId: string, principal: ProjectPrincipal, result: Record<string, unknown>) {
    assertSafeWire(result);
    return this.db.transaction(() => {
      const found = this.row(jobId); if (!found) throw new ProjectError(404,'JOB_UNAVAILABLE','Job unavailable');
      const row = this.access(found.project_id,jobId,principal,true);
      if (row.executor !== 'server') throw new ProjectError(403,'SERVER_EXECUTOR_ONLY','Only server attempts may reconcile upstream results');
      if (row.status === 'succeeded') {
        const receipt = this.db.prepare('SELECT candidate_id,result,revision FROM system_job_results WHERE job_id=?').get(jobId) as { candidate_id: string;result: string;revision: number } | undefined;
        if (!receipt || canonicalHash(JSON.parse(receipt.result)) !== canonicalHash(result)) throw new ProjectError(409,'RESULT_ID_REUSED','Reconciled result differs from confirmed receipt');
        return { job: publicSystemJob(row),candidateId:receipt.candidate_id,revision:receipt.revision };
      }
      if (row.status !== 'uncertain') throw new ProjectError(409,'RECONCILIATION_NOT_REQUIRED','Only an uncertain attempt may reconcile');
      const leaseToken = randomBytes(32).toString('hex'); const fence = row.fence + 1;
      this.db.prepare("UPDATE system_jobs SET status='running',fence=?,lease_hash=?,lease_until=?,error_code=NULL,updated_at=? WHERE id=?").run(fence,tokenHash(leaseToken),this.clock()+300000,new Date(this.clock()).toISOString(),jobId);
      return this.complete(row.project_id,jobId,principal,{fence,leaseToken},result,true);
    }).immediate();
  }
  markUncertain(projectId: string, jobId: string, principal: ProjectPrincipal, lease: Lease, errorCode = 'EXECUTION_OUTCOME_UNCERTAIN', server = false) {
    return this.db.transaction(() => {
      const row = this.access(projectId,jobId,principal,true);
      if (row.executor === 'server' && !server) throw new ProjectError(403,'SERVER_EXECUTOR_ONLY','Trusted server executor required');
      if (row.executor === 'local' && (server || row.actor_id !== principal.id || row.executor_session !== principal.sessionId)) throw new ProjectError(403,'EXECUTOR_SESSION_MISMATCH','Designated local executor required');
      if (row.status !== 'running' || row.fence !== lease.fence || row.lease_hash !== tokenHash(lease.leaseToken)) throw new ProjectError(409,'STALE_LEASE','Execution was canceled or fenced out');
      this.db.prepare("UPDATE system_jobs SET status='uncertain',error_code=?,fence=fence+1,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(errorCode,new Date(this.clock()).toISOString(),jobId);
      return { job:publicSystemJob(this.row(jobId)!) };
    }).immediate();
  }
  fail(projectId: string, jobId: string, principal: ProjectPrincipal, lease: Lease, errorCode: string, server = false) {
    if (/(?:UNCERTAIN|RECONCILIATION)/.test(errorCode)) return this.markUncertain(projectId,jobId,principal,lease,errorCode,server);
    return this.db.transaction(() => { const row = this.access(projectId, jobId, principal, true); this.verifyLease(row, principal, lease, server); this.db.prepare("UPDATE system_jobs SET status='failed',error_code=?,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(errorCode, new Date(this.clock()).toISOString(), jobId); return { job: publicSystemJob(this.row(jobId)!) }; }).immediate();
  }
  /** End an unqueryable attempt without claiming the provider did not charge. Fresh rights and original executor are required. */
  outcomeFailed(projectId: string, jobId: string, principal: ProjectPrincipal, lease: Lease, errorCode = 'SUBMISSION_OUTCOME_UNKNOWN', server = false) {
    return this.db.transaction(() => {
      const row = this.access(projectId, jobId, principal, true);
      if (row.executor === 'server' && !server || row.executor === 'local' && (server || row.actor_id !== principal.id || row.executor_session !== principal.sessionId)) throw new ProjectError(403, 'EXECUTOR_SESSION_MISMATCH', 'Designated executor required');
      if (row.status === 'failed') return {job: publicSystemJob(row)};
      if (row.status === 'running') {
        if (row.fence !== lease.fence || row.lease_hash !== tokenHash(lease.leaseToken)) throw new ProjectError(409, 'STALE_LEASE', 'Attempt was canceled or fenced out');
      } else if (row.status !== 'uncertain') throw new ProjectError(409, 'JOB_TERMINAL', 'Attempt cannot report failure');
      this.db.prepare("UPDATE system_jobs SET status='failed',error_code=?,fence=fence+1,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(errorCode, new Date(this.clock()).toISOString(), jobId);
      return {job: publicSystemJob(this.row(jobId)!)};
    }).immediate();
  }
  cancel(projectId: string, jobId: string, principal: ProjectPrincipal) {
    return this.db.transaction(() => { const row = this.access(projectId, jobId, principal, true); if (['succeeded', 'failed', 'canceled'].includes(row.status)) return { job: publicSystemJob(row) }; this.db.prepare("UPDATE system_jobs SET status='canceled',fence=fence+1,lease_hash=NULL,lease_until=NULL,updated_at=? WHERE id=?").run(new Date(this.clock()).toISOString(), jobId); return { job: publicSystemJob(this.row(jobId)!) }; }).immediate();
  }
}
