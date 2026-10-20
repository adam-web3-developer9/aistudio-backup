import type Database from 'better-sqlite3';

const eventTypes = ['job.accepted', 'job.updated', 'instance.updated'] as const;
const stages = ['queued', 'preparing', 'awaiting_upload', 'submitting', 'running', 'collecting', 'succeeded', 'failed', 'cancelled'] as const;
const states = ['offline', 'waiting_capacity', 'starting', 'ready', 'busy', 'closing', 'quarantined'] as const;

export type ComfyEventType = typeof eventTypes[number];
export interface ComfyEventDetails {
  fromStage?: typeof stages[number];
  toStage?: typeof stages[number];
  fromState?: typeof states[number];
  toState?: typeof states[number];
  completed?: number;
  total?: number;
  areaName?: '华东一区' | '华东二区';
  gpuModel?: '5090' | '4090';
  upstreamCode?: string;
  httpStatus?: number;
  nodeId?: string;
  errorType?: string;
}
export interface ComfyEventInput {
  jobId?: string;
  instanceId?: string;
  type: ComfyEventType;
  stage?: typeof stages[number];
  code?: string;
  details?: ComfyEventDetails;
}
export interface ComfyEvent extends ComfyEventInput {
  sequence: number;
  time: string;
}
export interface ComfyEventQuery {
  jobId?: string;
  instanceId?: string;
  after?: number;
  limit?: number;
}
export type ComfyEventSink = (event: ComfyEvent) => void;

function invalid(): never {
  throw new Error('Invalid Comfy event');
}

function fields(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) invalid();
  }
}

function identifier(value: unknown): asserts value is string | undefined {
  if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value))) invalid();
}

function member(value: unknown, allowed: readonly unknown[]): void {
  if (value !== undefined && !allowed.includes(value)) invalid();
}

function counter(value: unknown): void {
  if (value !== undefined && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) invalid();
}

function safeCode(value: unknown): void {
  if (value !== undefined && (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(value))) invalid();
}

function input(value: unknown): ComfyEventInput {
  fields(value, ['jobId', 'instanceId', 'type', 'stage', 'code', 'details']);
  identifier(value.jobId);
  identifier(value.instanceId);
  if (value.jobId === undefined && value.instanceId === undefined) invalid();
  if (!eventTypes.includes(value.type as ComfyEventType)) invalid();
  member(value.stage, stages);
  if (value.code !== undefined && (typeof value.code !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(value.code))) invalid();
  let details: ComfyEventDetails | undefined;
  if (value.details !== undefined) {
    fields(value.details, ['fromStage', 'toStage', 'fromState', 'toState', 'completed', 'total', 'areaName', 'gpuModel',
      'upstreamCode', 'httpStatus', 'nodeId', 'errorType']);
    member(value.details.fromStage, stages);
    member(value.details.toStage, stages);
    member(value.details.fromState, states);
    member(value.details.toState, states);
    counter(value.details.completed);
    counter(value.details.total);
    member(value.details.areaName, ['华东一区', '华东二区']);
    member(value.details.gpuModel, ['5090', '4090']);
    safeCode(value.details.upstreamCode);
    safeCode(value.details.nodeId);
    safeCode(value.details.errorType);
    if (value.details.httpStatus !== undefined && (typeof value.details.httpStatus !== 'number' ||
        !Number.isInteger(value.details.httpStatus) || value.details.httpStatus < 100 || value.details.httpStatus > 599)) invalid();
    details = Object.fromEntries(Object.entries(value.details).filter(([, item]) => item !== undefined));
  }
  return {
    type: value.type as ComfyEventType,
    ...(value.jobId === undefined ? {} : { jobId: value.jobId }),
    ...(value.instanceId === undefined ? {} : { instanceId: value.instanceId }),
    ...(value.stage === undefined ? {} : { stage: value.stage as ComfyEventInput['stage'] }),
    ...(value.code === undefined ? {} : { code: value.code as string }),
    ...(details === undefined ? {} : { details })
  };
}

function query(value: unknown): Required<Pick<ComfyEventQuery, 'after' | 'limit'>> & ComfyEventQuery {
  fields(value, ['jobId', 'instanceId', 'after', 'limit']);
  identifier(value.jobId);
  identifier(value.instanceId);
  if (value.jobId === undefined && value.instanceId === undefined) invalid();
  const after = value.after === undefined ? 0 : value.after;
  const limit = value.limit === undefined ? 100 : value.limit;
  counter(after);
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid();
  return { jobId: value.jobId, instanceId: value.instanceId, after: after as number, limit };
}

function event(row: unknown): ComfyEvent {
  fields(row, ['sequence', 'time', 'job_id', 'instance_id', 'type', 'stage', 'code', 'details']);
  if (typeof row.sequence !== 'number' || !Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
      typeof row.time !== 'string' || !Number.isFinite(Date.parse(row.time)) || new Date(row.time).toISOString() !== row.time) invalid();
  let details: unknown;
  try { details = row.details === null ? undefined : JSON.parse(row.details as string); } catch { return invalid(); }
  return { ...input({ jobId: row.job_id === null ? undefined : row.job_id,
    instanceId: row.instance_id === null ? undefined : row.instance_id, type: row.type,
    stage: row.stage === null ? undefined : row.stage, code: row.code === null ? undefined : row.code, details }),
    sequence: row.sequence, time: row.time };
}

export class ComfyEventLog {
  constructor(readonly db: Database.Database, private readonly sink?: ComfyEventSink) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS comfy_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, job_id TEXT, instance_id TEXT,
        type TEXT NOT NULL, stage TEXT, code TEXT, details TEXT
      );
      CREATE INDEX IF NOT EXISTS comfy_events_job ON comfy_events(job_id, sequence);
      CREATE INDEX IF NOT EXISTS comfy_events_instance ON comfy_events(instance_id, sequence);
    `);
  }

  record(value: ComfyEventInput): ComfyEvent {
    const data = input(value);
    const time = new Date().toISOString();
    const result = this.db.prepare(`INSERT INTO comfy_events(time,job_id,instance_id,type,stage,code,details)
      VALUES(?,?,?,?,?,?,?)`).run(time, data.jobId ?? null, data.instanceId ?? null, data.type,
      data.stage ?? null, data.code ?? null, data.details === undefined ? null : JSON.stringify(data.details));
    const saved: ComfyEvent = { ...data, sequence: Number(result.lastInsertRowid), time };
    if (this.sink) {
      try { void Promise.resolve(this.sink(structuredClone(saved))).catch(() => {}); } catch {}
    }
    return saved;
  }

  list(options: ComfyEventQuery): ComfyEvent[] {
    const scope = query(options);
    const conditions = ['sequence > ?'];
    const parameters: Array<string | number> = [scope.after];
    if (scope.jobId !== undefined) { conditions.push('job_id = ?'); parameters.push(scope.jobId); }
    if (scope.instanceId !== undefined) { conditions.push('instance_id = ?'); parameters.push(scope.instanceId); }
    return this.db.prepare(`SELECT sequence,time,job_id,instance_id,type,stage,code,details FROM comfy_events
      WHERE ${conditions.join(' AND ')} ORDER BY sequence ASC LIMIT ?`).all(...parameters, scope.limit).map(event);
  }

  recent(jobId: string, limit = 20): ComfyEvent[] {
    const scope = query({ jobId, limit });
    return this.db.prepare(`SELECT sequence,time,job_id,instance_id,type,stage,code,details FROM comfy_events
      WHERE job_id = ? ORDER BY sequence DESC LIMIT ?`).all(scope.jobId, scope.limit).reverse().map(event);
  }
}
