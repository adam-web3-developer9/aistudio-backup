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
  finished_at: number | null; collected_at: number | null;
  upload_reservations: number; eligible_at: number | null; queue_deadline: number | null; reservation_started_at: number | null;
  native_checkpoint: string | null;
}
export interface ComfyInstanceRow {
  id: string; state: 'offline' | 'waiting_capacity' | 'starting' | 'ready' | 'busy' | 'closing' | 'quarantined';
  draining: number; job_id: string | null; action_started_at: number | null; action_sent: number;
  error_code: string | null;
  capacity_started_at: number | null; next_action_at: number | null;
  idle_policy_applied_at: number | null;
  idle_since: number | null; stopped_at: number | null;
}
export interface ComfyResource {
  key: string; name: string; state: 'creating' | 'uncertain' | 'registered' | 'releasing' | 'released' | 'blocked';
  instance_id: string | null; configuration: string | null; template_id: string;
  hourly_cost: number; storage_hourly_cost: number; created_at: number; updated_at: number; error_code: string | null;
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
      CREATE TABLE IF NOT EXISTS comfy_resources (
        key TEXT PRIMARY KEY, name TEXT NOT NULL, state TEXT NOT NULL, instance_id TEXT, configuration TEXT, template_id TEXT NOT NULL,
        hourly_cost REAL NOT NULL, storage_hourly_cost REAL NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS comfy_resource_observations (
        resource_key TEXT PRIMARY KEY, status TEXT NOT NULL, observed_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS comfy_result_archives (
        job_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, object_key TEXT NOT NULL UNIQUE, storage_identity TEXT NOT NULL,
        output TEXT NOT NULL, ready_at INTEGER NOT NULL, state TEXT NOT NULL,
        file TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
        uploaded_at INTEGER, expires_at INTEGER, error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS comfy_result_archives_due ON comfy_result_archives(state,next_at);
      CREATE TABLE IF NOT EXISTS comfy_ssh_host_keys (
        instance_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL
      );
    `);
    for (const [table, columns] of Object.entries({
      comfy_jobs: { direct_inputs: 'TEXT', result_wake_requested: 'INTEGER NOT NULL DEFAULT 0', result_checked_at: 'INTEGER', finished_at: 'INTEGER', collected_at: 'INTEGER',
        upload_reservations: 'INTEGER NOT NULL DEFAULT 0', eligible_at: 'INTEGER', queue_deadline: 'INTEGER', reservation_started_at: 'INTEGER', native_checkpoint: 'TEXT' },
      comfy_instances: { capacity_started_at: 'INTEGER', next_action_at: 'INTEGER', idle_policy_applied_at: 'INTEGER', idle_since: 'INTEGER', stopped_at: 'INTEGER' },
      comfy_result_archives: { storage_identity: "TEXT NOT NULL DEFAULT ''" },
    })) {
      const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(column => column.name));
      for (const [name, type] of Object.entries(columns)) if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
      if (table === 'comfy_jobs' && !existing.has('queue_deadline')) {
        db.exec('UPDATE comfy_jobs SET queue_deadline=CASE WHEN instance_id IS NULL THEN deadline ELSE created_at+21600000 END');
      }
    }
    this.events = new ComfyEventLog(db, sink);
  }
  registerInstances(ids: string[]): void {
    this.db.transaction(() => { for (const id of ids) this.db.prepare('INSERT OR IGNORE INTO comfy_instances(id) VALUES(?)').run(id); })();
  }
  verifySshHostKey(instanceId: string, fingerprint: string): boolean {
    if (!this.instance(instanceId) || !/^[a-f0-9]{64}$/i.test(fingerprint)) return false;
    const normalized = fingerprint.toLowerCase();
    this.db.prepare('INSERT OR IGNORE INTO comfy_ssh_host_keys(instance_id,fingerprint) VALUES(?,?)').run(instanceId, normalized);
    const stored = this.db.prepare('SELECT fingerprint FROM comfy_ssh_host_keys WHERE instance_id=?').get(instanceId) as { fingerprint: string };
    return stored.fingerprint === normalized;
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
      this.db.prepare(`INSERT INTO comfy_jobs(id,owner,request_key,fingerprint,input,stage,prompt_id,created_at,deadline,updated_at,queue_deadline)
        VALUES(?,?,?,?,?,'queued',?,?,?,?,?)`).run(id, owner, input.requestKey, fingerprint, JSON.stringify(input), randomUUID(), now, now + timeoutMs, now, now + Math.max(timeoutMs, 21_600_000));
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
  updateJob(id: string, patch: Partial<Pick<ComfyJob, 'stage' | 'prompt_id' | 'error_code' | 'result' | 'result_pending' | 'cancel_requested' | 'provider_confirmed' | 'direct_inputs' | 'deadline' | 'result_wake_requested' | 'result_checked_at' | 'upload_reservations' | 'eligible_at' | 'queue_deadline' | 'reservation_started_at' | 'collected_at' | 'native_checkpoint'>>, details?: ComfyEventDetails): void {
    const prior = this.get(id);
    const terminal = patch.stage && ['succeeded', 'failed', 'cancelled'].includes(patch.stage);
    const fields = Object.entries({ ...patch, updated_at: Date.now(), ...(patch.stage && prior?.stage !== patch.stage ? { finished_at: terminal ? Date.now() : null } : {}) });
    this.db.prepare(`UPDATE comfy_jobs SET ${fields.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...fields.map(([, value]) => value), id);
    const current = this.get(id);
    if (prior && current && ['stage', 'error_code', 'provider_confirmed', 'cancel_requested', 'direct_inputs', 'result_pending', 'result_wake_requested', 'collected_at'].some(key => prior[key as keyof ComfyJob] !== current[key as keyof ComfyJob])) {
      this.events.record({ type: 'job.updated', jobId: id, ...(current.instance_id ? { instanceId: current.instance_id } : {}), stage: current.stage,
        ...(current.error_code ? { code: current.error_code } : current.collected_at !== prior.collected_at ? { code: 'COMFY_CLIENT_COLLECTED' } : {}), details: { fromStage: prior.stage, toStage: current.stage, ...details } });
    }
  }
  claim(instanceId: string, workflowIds: string[], now = Date.now()): ComfyJob | undefined {
    return this.db.transaction(() => {
      const instance = this.instance(instanceId);
      if (!instance || instance.state !== 'ready' || instance.draining || instance.job_id) return;
      const next = (this.db.prepare("SELECT * FROM comfy_jobs WHERE stage='queued' AND deadline>? AND (eligible_at IS NULL OR eligible_at<=?) AND (instance_id IS NULL OR instance_id=?) ORDER BY COALESCE(eligible_at,created_at),created_at,id").all(now, now, instanceId) as ComfyJob[])
        .find(job => workflowIds.includes((JSON.parse(job.input) as FrozenComfyInput).workflowId));
      if (!next) return;
      const direct = !next.native_checkpoint && (JSON.parse(next.input) as FrozenComfyInput).transport === 'direct';
      this.db.prepare("UPDATE comfy_jobs SET stage='preparing',instance_id=?,updated_at=?,upload_reservations=upload_reservations+?,reservation_started_at=? WHERE id=? AND stage='queued'")
        .run(instanceId, now, direct ? 1 : 0, direct ? now : null, next.id);
      this.events.record({ type: 'job.updated', jobId: next.id, instanceId, stage: 'preparing', details: { fromStage: 'queued', toStage: 'preparing' } });
      this.updateInstance(instanceId, { state: 'busy', job_id: next.id, error_code: null });
      return this.get(next.id);
    })();
  }
  releaseSlot(id: string): void {
    this.db.transaction(() => {
      const job = this.get(id);
      const native = job?.native_checkpoint ? JSON.parse(job.native_checkpoint) as { selectedPromptId?: string; attempts: Array<{ promptId?: string; state?: string }> } : undefined;
      if (native?.attempts.some(attempt => attempt.promptId !== native.selectedPromptId && attempt.state === 'running')) return;
      const instances = this.db.prepare('SELECT * FROM comfy_instances WHERE job_id=?').all(id) as ComfyInstanceRow[];
      for (const instance of instances) this.updateInstance(instance.id, { job_id: null, state: instance.draining ? 'offline' : 'ready' });
    })();
  }
  terminalSlot(instanceId: string): ComfyJob | undefined {
    const id = this.instance(instanceId)?.job_id;
    const job = id ? this.get(id) : undefined;
    return job && ['failed', 'cancelled'].includes(job.stage) && !job.result && !job.result_pending
      ? job : undefined;
  }
  settleStoppedSlot(instanceId: string): boolean {
    return this.db.transaction(() => {
      const instance = this.instance(instanceId);
      const job = this.terminalSlot(instanceId);
      if (!instance || !job) return false;
      // The platform has stopped execution. Retain the last native observations rather than inventing render failures.
      this.updateInstance(instanceId, { state: 'offline', stopped_at: instance.stopped_at ?? Date.now(),
        job_id: null, error_code: null, next_action_at: null, action_started_at: null, action_sent: 0 });
      this.events.record({ type: 'job.updated', jobId: job.id, instanceId, stage: job.stage, code: 'COMFY_EXECUTION_SLOT_RELEASED' });
      return true;
    })();
  }
  selectNativeResult(id: string, promptId: string): boolean {
    return this.db.transaction(() => {
      const job = this.get(id)!;
      const checkpoint = JSON.parse(job.native_checkpoint!) as { selectedPromptId?: string };
      if (job.cancel_requested || checkpoint.selectedPromptId || job.stage === 'succeeded') return false;
      checkpoint.selectedPromptId = promptId;
      this.updateJob(id, { native_checkpoint: JSON.stringify(checkpoint), prompt_id: promptId });
      return true;
    })();
  }
  pendingResults(instanceId: string): ComfyJob[] {
    return this.db.prepare('SELECT * FROM comfy_jobs WHERE instance_id=? AND result_pending=1').all(instanceId) as ComfyJob[];
  }
  unarchivedResults(owner: string): ComfyJob[] {
    return this.db.prepare(`SELECT * FROM comfy_jobs WHERE owner=? AND stage='succeeded' AND result_pending=1
      AND result IS NOT NULL AND NOT EXISTS (SELECT 1 FROM comfy_result_archives WHERE job_id=comfy_jobs.id)`).all(owner) as ComfyJob[];
  }
  requeueUpload(id: string, retryDelayMs: number, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const job = this.get(id);
      if (!job || job.stage !== 'awaiting_upload' || job.cancel_requested || job.provider_confirmed || job.direct_inputs || !job.instance_id) return false;
      if (this.instance(job.instance_id)?.job_id !== id) return false;
      const deadline = job.queue_deadline ?? job.created_at + 21_600_000;
      if (deadline <= now) return false;
      this.updateJob(id, { stage: 'queued', deadline, eligible_at: now + retryDelayMs, reservation_started_at: null, error_code: 'COMFY_UPLOAD_RESERVATION_EXPIRED' });
      this.releaseSlot(id);
      return true;
    })();
  }
  hasUnresolvedWork(instanceId: string): boolean {
    return !!this.instance(instanceId)?.job_id || this.hasPendingWork(instanceId);
  }
  hasComputeWork(instanceId: string): boolean {
    const slot = this.instance(instanceId)?.job_id;
    if (slot) {
      const job = this.get(slot);
      if (!job || !['failed', 'cancelled'].includes(job.stage) || job.result || job.result_pending) return true;
    }
    return this.hasPendingWork(instanceId);
  }
  private hasPendingWork(instanceId: string): boolean {
    return !!this.db.prepare(`SELECT 1 FROM comfy_jobs WHERE instance_id=?
      AND (result_pending=1 OR stage IN ('queued','preparing','awaiting_upload','submitting','running','collecting')) LIMIT 1`).get(instanceId)
      || !!this.db.prepare("SELECT 1 FROM comfy_result_archives WHERE instance_id=? AND state='transferring' LIMIT 1").get(instanceId);
  }
  resources(): ComfyResource[] { return this.db.prepare('SELECT * FROM comfy_resources ORDER BY key').all() as ComfyResource[]; }
  resource(key: string): ComfyResource | undefined { return this.db.prepare('SELECT * FROM comfy_resources WHERE key=?').get(key) as ComfyResource | undefined; }
  observeResource(key: string, status: string, now = Date.now()): void {
    if (!this.resource(key) || !/^[A-Za-z0-9_-]{1,40}$/.test(status)) throw new Error('Invalid ComfyUI resource observation');
    this.db.prepare('INSERT INTO comfy_resource_observations(resource_key,status,observed_at) VALUES(?,?,?) ON CONFLICT(resource_key) DO UPDATE SET status=excluded.status,observed_at=excluded.observed_at').run(key, status, now);
  }
  resourceObservations(): Array<{ resource_key: string; status: string; observed_at: number }> {
    return this.db.prepare('SELECT * FROM comfy_resource_observations ORDER BY resource_key').all() as Array<{ resource_key: string; status: string; observed_at: number }>;
  }
  saveResource(row: ComfyResource): void {
    const configuration = row.configuration === null ? null : JSON.stringify(JSON.parse(row.configuration),
      (key, value: unknown) => /token|authorization|password|secret|headers|api.?key/i.test(key) ? undefined : value);
    this.db.prepare(`INSERT INTO comfy_resources(key,name,state,instance_id,configuration,template_id,hourly_cost,storage_hourly_cost,created_at,updated_at,error_code)
      VALUES(@key,@name,@state,@instance_id,@configuration,@template_id,@hourly_cost,@storage_hourly_cost,@created_at,@updated_at,@error_code)
      ON CONFLICT(key) DO UPDATE SET name=excluded.name,state=excluded.state,instance_id=excluded.instance_id,configuration=excluded.configuration,
        template_id=excluded.template_id,hourly_cost=excluded.hourly_cost,storage_hourly_cost=excluded.storage_hourly_cost,
        updated_at=excluded.updated_at,error_code=excluded.error_code`).run({ ...row, configuration });
  }
  queued(): ComfyJob[] { return this.db.prepare("SELECT * FROM comfy_jobs WHERE stage='queued' ORDER BY created_at,id").all() as ComfyJob[]; }
}
export function publicStatus(stage: ComfyStage): 'queued' | 'running' | 'succeeded' | 'failed' {
  return stage === 'queued' ? 'queued' : stage === 'succeeded' ? 'succeeded' : stage === 'failed' || stage === 'cancelled' ? 'failed' : 'running';
}
