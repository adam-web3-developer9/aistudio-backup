import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SystemError } from '../system/types.js';
import type { WorkflowProfile } from './workflow.js';
import { ComfyEventLog, type ComfyEventDetails, type ComfyEventSink } from './events.js';

export type ComfyStage = 'queued' | 'preparing' | 'awaiting_upload' | 'submitting' | 'running' | 'collecting' | 'succeeded' | 'failed' | 'cancelled';
export interface ComfyInput {
  adapterId: 'comfyui-v1';
  requestKey: string;
  workflowId: string;
  values: Record<string, string | number | boolean>;
  media: Record<string, string>;
  transport?: 'direct';
  directMedia?: Record<string, { filename: string; contentType: string; sha256: string }>;
}
export interface FrozenComfyInput extends ComfyInput { profile: WorkflowProfile }
export interface ComfyJob {
  id: string; owner: string; request_key: string; fingerprint: string; input: string;
  stage: ComfyStage; instance_id: string | null; prompt_id: string; created_at: number;
  deadline: number; updated_at: number; error_code: string | null; result: string | null; result_pending: number; cancel_requested: number; provider_confirmed: number; direct_inputs: string | null;
  result_wake_requested: number; result_checked_at: number | null;
  finished_at: number | null;
}
export interface ComfyInstanceRow {
  id: string; state: 'offline' | 'waiting_capacity' | 'starting' | 'ready' | 'busy' | 'closing' | 'quarantined';
  draining: number; job_id: string | null; action_started_at: number | null; action_sent: number;
  error_code: string | null;
  capacity_started_at: number | null; next_action_at: number | null;
  idle_policy_applied_at: number | null;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export class ComfyStore {
  readonly events: ComfyEventLog;
  constructor(readonly db: Database.Database, sink?: ComfyEventSink) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS comfy_instances (
        id TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'offline', draining INTEGER NOT NULL DEFAULT 0,
        job_id TEXT UNIQUE, action_started_at INTEGER, action_sent INTEGER NOT NULL DEFAULT 0, error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS comfy_jobs (
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        input TEXT NOT NULL, stage TEXT NOT NULL, instance_id TEXT, prompt_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, deadline INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        error_code TEXT, result TEXT, result_pending INTEGER NOT NULL DEFAULT 0,
        cancel_requested INTEGER NOT NULL DEFAULT 0, provider_confirmed INTEGER NOT NULL DEFAULT 0, UNIQUE(owner, request_key)
      );
      CREATE INDEX IF NOT EXISTS comfy_jobs_queue ON comfy_jobs(stage, created_at);
      CREATE TABLE IF NOT EXISTS comfy_worker (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
    `);
    for (const [table, columns] of Object.entries({
      comfy_jobs: { direct_inputs: 'TEXT', result_wake_requested: 'INTEGER NOT NULL DEFAULT 0', result_checked_at: 'INTEGER', finished_at: 'INTEGER' },
      comfy_instances: { capacity_started_at: 'INTEGER', next_action_at: 'INTEGER', idle_policy_applied_at: 'INTEGER' },
    })) {
      const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
      for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
    this.events = new ComfyEventLog(db, sink);
  }
  registerInstances(ids: string[]): void {
    this.db.transaction(() => { for (const id of ids) this.db.prepare('INSERT OR IGNORE INTO comfy_instances(id) VALUES(?)').run(id); })();
  }
  acquireWorker(owner: string, now: number): boolean {
    return this.db.prepare(`INSERT INTO comfy_worker(id,owner,expires_at) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE comfy_worker.owner=excluded.owner OR comfy_worker.expires_at<=?`).run(owner, now + 30_000, now).changes === 1;
  }
  ownsWorker(owner: string, now = Date.now()): boolean {
    return !!this.db.prepare('SELECT 1 FROM comfy_worker WHERE id=1 AND owner=? AND expires_at>?').get(owner, now);
  }
  releaseWorker(owner: string): void { this.db.prepare('DELETE FROM comfy_worker WHERE id=1 AND owner=?').run(owner); }
  submit(owner: string, input: FrozenComfyInput, timeoutMs: number, now = Date.now()): { job: ComfyJob; created: boolean } {
    const fingerprint = createHash('sha256').update(canonical({ workflowId: input.workflowId, values: input.values, media: input.media,
      ...(input.transport ? { transport: input.transport, directMedia: input.directMedia ?? {} } : {}) })).digest('hex');
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT * FROM comfy_jobs WHERE owner=? AND request_key=?').get(owner, input.requestKey) as ComfyJob | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new SystemError(409, 'COMFY_REQUEST_CONFLICT', 'The request key already belongs to different input');
        return { job: prior, created: false };
      }
      const id = `job_gateway_comfy_${randomUUID()}`;
      this.db.prepare(`INSERT INTO comfy_jobs(id,owner,request_key,fingerprint,input,stage,prompt_id,created_at,deadline,updated_at)
        VALUES(?,?,?,?,?,'queued',?,?,?,?)`).run(id, owner, input.requestKey, fingerprint, JSON.stringify(input), randomUUID(), now, now + timeoutMs, now);
      this.events.record({ type: 'job.accepted', jobId: id, stage: 'queued', details: { total: Object.keys(input.directMedia ?? input.media).length, completed: 0 } });
      return { job: this.get(id)!, created: true };
    })();
  }
  get(id: string): ComfyJob | undefined { return this.db.prepare('SELECT * FROM comfy_jobs WHERE id=?').get(id) as ComfyJob | undefined; }
  byRequest(owner: string, key: string): ComfyJob | undefined {
    return this.db.prepare('SELECT * FROM comfy_jobs WHERE owner=? AND request_key=?').get(owner, key) as ComfyJob | undefined;
  }
  list(owner: string, status?: string): ComfyJob[] {
    return (this.db.prepare('SELECT * FROM comfy_jobs WHERE owner=? ORDER BY created_at DESC,id DESC').all(owner) as ComfyJob[])
      .filter(job => !status || publicStatus(job.cancel_requested ? 'cancelled' : job.stage) === status);
  }
  instances(): ComfyInstanceRow[] { return this.db.prepare('SELECT * FROM comfy_instances ORDER BY id').all() as ComfyInstanceRow[]; }
  instance(id: string): ComfyInstanceRow | undefined { return this.db.prepare('SELECT * FROM comfy_instances WHERE id=?').get(id) as ComfyInstanceRow | undefined; }
  updateInstance(id: string, patch: Partial<Omit<ComfyInstanceRow, 'id'>>, details?: ComfyEventDetails): void {
    const prior = this.instance(id);
    const fields = Object.entries(patch);
    if (fields.length) this.db.prepare(`UPDATE comfy_instances SET ${fields.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...fields.map(([, value]) => value), id);
    const current = this.instance(id);
    if (prior && current && ['state', 'error_code', 'action_sent', 'draining', 'job_id', 'idle_policy_applied_at'].some(key => prior[key as keyof ComfyInstanceRow] !== current[key as keyof ComfyInstanceRow])) {
      this.events.record({ type: 'instance.updated', instanceId: id, ...(current.job_id || prior.job_id ? { jobId: current.job_id ?? prior.job_id! } : {}),
        ...(current.error_code ? { code: current.error_code } : current.idle_policy_applied_at !== prior.idle_policy_applied_at && current.idle_policy_applied_at ? { code: 'COMFY_IDLE_POLICY_APPLIED' } :
          current.action_sent && !prior.action_sent ? { code: current.state === 'closing' ? 'COMFY_CLOSE_REQUESTED' : 'COMFY_OPEN_REQUESTED' } : {}),
        details: { fromState: prior.state, toState: current.state, ...details } });
    }
  }
  updateJob(id: string, patch: Partial<Pick<ComfyJob, 'stage' | 'prompt_id' | 'error_code' | 'result' | 'result_pending' | 'cancel_requested' | 'provider_confirmed' | 'direct_inputs' | 'deadline' | 'result_wake_requested' | 'result_checked_at'>>, details?: ComfyEventDetails): void {
    const prior = this.get(id);
    const terminal = patch.stage && ['succeeded', 'failed', 'cancelled'].includes(patch.stage);
    const fields = Object.entries({ ...patch, updated_at: Date.now(), ...(patch.stage && prior?.stage !== patch.stage ? { finished_at: terminal ? Date.now() : null } : {}) });
    this.db.prepare(`UPDATE comfy_jobs SET ${fields.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...fields.map(([, value]) => value), id);
    const current = this.get(id);
    if (prior && current && ['stage', 'error_code', 'provider_confirmed', 'cancel_requested', 'direct_inputs', 'result_pending', 'result_wake_requested'].some(key => prior[key as keyof ComfyJob] !== current[key as keyof ComfyJob])) {
      this.events.record({ type: 'job.updated', jobId: id, ...(current.instance_id ? { instanceId: current.instance_id } : {}), stage: current.stage,
        ...(current.error_code ? { code: current.error_code } : {}), details: { fromStage: prior.stage, toStage: current.stage, ...details } });
    }
  }
  claim(instanceId: string, workflowIds: string[], now = Date.now()): ComfyJob | undefined {
    return this.db.transaction(() => {
      const instance = this.instance(instanceId);
      if (!instance || instance.state !== 'ready' || instance.draining || instance.job_id) return;
      const next = (this.db.prepare("SELECT * FROM comfy_jobs WHERE stage='queued' AND deadline>? ORDER BY created_at,id").all(now) as ComfyJob[])
        .find(job => workflowIds.includes((JSON.parse(job.input) as FrozenComfyInput).workflowId));
      if (!next) return;
      this.db.prepare("UPDATE comfy_jobs SET stage='preparing',instance_id=?,updated_at=? WHERE id=? AND stage='queued'").run(instanceId, now, next.id);
      this.events.record({ type: 'job.updated', jobId: next.id, instanceId, stage: 'preparing', details: { fromStage: 'queued', toStage: 'preparing' } });
      this.updateInstance(instanceId, { state: 'busy', job_id: next.id, error_code: null });
      return this.get(next.id);
    })();
  }
  releaseSlot(id: string): void {
    this.db.transaction(() => {
      const instances = this.db.prepare('SELECT * FROM comfy_instances WHERE job_id=?').all(id) as ComfyInstanceRow[];
      for (const instance of instances) this.updateInstance(instance.id, { job_id: null, state: instance.draining ? 'offline' : 'ready' });
    })();
  }
  pendingResults(instanceId: string): ComfyJob[] {
    return this.db.prepare('SELECT * FROM comfy_jobs WHERE instance_id=? AND result_pending=1').all(instanceId) as ComfyJob[];
  }
  queued(): ComfyJob[] { return this.db.prepare("SELECT * FROM comfy_jobs WHERE stage='queued' ORDER BY created_at,id").all() as ComfyJob[]; }
}
export function publicStatus(stage: ComfyStage): 'queued' | 'running' | 'succeeded' | 'failed' {
  return stage === 'queued' ? 'queued' : stage === 'succeeded' ? 'succeeded' : stage === 'failed' || stage === 'cancelled' ? 'failed' : 'running';
}
