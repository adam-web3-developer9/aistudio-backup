import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { SystemError } from '../system/types.js';

const identifier = /^[A-Za-z0-9_-]{1,128}$/;
export const asrRequestKey = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const clipSchema = z.object({
  id: z.string().regex(identifier),
  filename: z.string().min(1).max(255).refine(name => !/[\/\\\x00]/.test(name)),
  contentType: z.string().regex(/^(audio\/[\w.+-]+|application\/octet-stream)$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive().max(32 * 1024 * 1024),
  durationMs: z.number().int().positive(),
});

export const asrJobSchema = z.object({
  requestKey: asrRequestKey,
  language: z.enum(['Chinese', 'Auto']).default('Chinese'),
  clips: z.array(clipSchema).min(1).max(128),
}).refine(input => new Set(input.clips.map(clip => clip.id)).size === input.clips.length,
  { path: ['clips'], message: 'Clip IDs must be unique' });
type AsrInput = z.infer<typeof asrJobSchema>;
type Stage = 'queued' | 'preparing' | 'awaiting_upload' | 'submitting' | 'running' | 'succeeded' | 'failed';
type Row = { id: string; request_key: string; input: string; stage: Stage; worker: string | null; token: string | null;
  created_at: number; updated_at: number; upload_deadline: number | null; result: string | null;
  error_code: string | null; error_message: string | null; worker_timing: string | null };
const transcriptSchema = z.object({ id: z.string(), text: z.string(), durationMs: z.number().int().nonnegative().optional() });
const workerSchema = z.object({
  id: z.string(),
  status: z.enum(['awaiting_upload', 'queued', 'running', 'succeeded', 'failed']),
  uploadToken: z.string().min(1).optional(),
  queuedAt: z.number().int().positive().optional(),
  startedAt: z.number().int().positive().optional(),
  finishedAt: z.number().int().positive().optional(),
  results: z.array(transcriptSchema).optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
type WorkerReceipt = z.infer<typeof workerSchema>;
const uploadReservationMs = 600_000;
const activeStages = "('preparing','awaiting_upload','submitting','running')";

export interface AsrOptions {
  workers: string[];
  key: string;
  fetch?: typeof fetch;
}

export function asrOptionsFromEnv(env = process.env): AsrOptions | undefined {
  if (!env.SYSTEM_ASR_WORKERS) return undefined;
  const workers = env.SYSTEM_ASR_WORKERS.split(',').map(value => {
    const url = new URL(value.trim());
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.search || url.hash ||
        url.username || url.password || url.pathname !== '/') throw new Error('ASR worker must be an HTTPS origin');
    return url.origin;
  });
  const key = env.SYSTEM_ASR_WORKER_KEY?.trim();
  if (!key) throw new Error('SYSTEM_ASR_WORKER_KEY is required for the ASR pool');
  return { workers: [...new Set(workers)], key };
}

class WorkerHttpError extends Error {
  constructor(readonly status: number, readonly code?: string) { super(`ASR worker HTTP ${status}`); }
}

export class AsrService {
  private timer?: NodeJS.Timeout;
  private tick?: Promise<void>;
  private readonly owner: string;
  constructor(private readonly db: Database.Database, private readonly options: AsrOptions,
      apiKey: string, private readonly onError: (error: unknown) => void) {
    this.owner = createHash('sha256').update(apiKey).digest('hex');
    db.exec(`CREATE TABLE IF NOT EXISTS aigate_asr_jobs (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, input TEXT NOT NULL,
      stage TEXT NOT NULL, worker TEXT, token TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      upload_deadline INTEGER, result TEXT, error_code TEXT, error_message TEXT, worker_timing TEXT,
      UNIQUE(owner, request_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS aigate_asr_worker_slot ON aigate_asr_jobs(worker)
      WHERE stage IN ${activeStages};`);
  }

  create(input: AsrInput) {
    const id = `asr_${randomUUID()}`;
    const payload = JSON.stringify(input);
    const now = Date.now();
    const created = this.db.prepare(`INSERT INTO aigate_asr_jobs
      (id, owner, request_key, input, stage, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?)
      ON CONFLICT(owner, request_key) DO NOTHING`).run(id, this.owner, input.requestKey, payload, now, now).changes > 0;
    const row = this.byRequest(input.requestKey);
    if (row.input !== payload) throw new SystemError(409, 'ASR_REQUEST_CONFLICT', 'ASR request key already has a different manifest');
    return { created, job: this.project(row) };
  }

  find(id: string) { return this.project(this.byId(id)); }
  findRequest(requestKey: string) { return this.project(this.byRequest(requestKey)); }

  confirm(id: string) {
    const row = this.byId(id);
    if (row.stage === 'queued' || row.stage === 'preparing') throw new SystemError(409, 'ASR_UPLOAD_NOT_READY', 'ASR GPU upload is not ready');
    this.db.prepare(`UPDATE aigate_asr_jobs SET stage='submitting', updated_at=?, error_code=NULL, error_message=NULL
      WHERE id=? AND stage='awaiting_upload'`).run(Date.now(), id);
    return this.find(id);
  }

  start() {
    const run = () => {
      if (this.tick) return;
      this.tick = this.step().catch(this.onError).finally(() => { this.tick = undefined; });
    };
    run();
    this.timer = setInterval(run, 2_000);
    this.timer.unref();
  }

  async close() {
    clearInterval(this.timer);
    await this.tick;
  }

  async step() {
    this.db.prepare(`UPDATE aigate_asr_jobs SET stage='failed', token=NULL, updated_at=?, error_code='ASR_UPLOAD_TIMEOUT',
      error_message='ASR upload reservation expired' WHERE stage IN ('preparing','awaiting_upload') AND upload_deadline <= ?`)
      .run(Date.now(), Date.now());
    await Promise.all(this.options.workers.map(worker => this.stepWorker(worker).catch(this.onError)));
  }

  private async stepWorker(worker: string) {
    let active = this.db.prepare(`SELECT * FROM aigate_asr_jobs WHERE worker=? AND stage IN ${activeStages}`)
      .get(worker) as Row | undefined;
    if (!active) {
      if (!this.db.prepare("SELECT 1 FROM aigate_asr_jobs WHERE stage='queued' LIMIT 1").get()) return;
      const health = await this.request(worker, '/health');
      if (health?.ready !== true) return;
      const now = Date.now();
      active = this.db.prepare(`UPDATE aigate_asr_jobs SET stage='preparing', worker=?, updated_at=?, upload_deadline=?
        WHERE id=(SELECT id FROM aigate_asr_jobs WHERE stage='queued' ORDER BY created_at, rowid LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM aigate_asr_jobs WHERE worker=? AND stage IN ${activeStages}) RETURNING *`)
        .get(worker, now, now + uploadReservationMs, worker) as Row | undefined;
      if (!active) return;
    }
    const path = `/v1/jobs/${active.id}`;
    if (active.stage === 'preparing') {
      const input = JSON.parse(active.input) as AsrInput;
      const value = await this.workerReceipt(worker, '/v1/jobs', active.id, {
        id: active.id, language: input.language,
        inputs: input.clips.map(({ id, sha256, size, durationMs }) => ({ id, sha256, size, durationMs })),
      });
      if (value.status !== 'awaiting_upload' || !value.uploadToken) throw new Error('ASR worker create response invalid');
      const now = Date.now();
      this.db.prepare(`UPDATE aigate_asr_jobs SET stage='awaiting_upload', token=?, updated_at=?, upload_deadline=?
        WHERE id=? AND stage='preparing'`).run(value.uploadToken, now, now + uploadReservationMs, active.id);
    } else if (active.stage === 'submitting') {
      try { this.applyReceipt(active, await this.workerReceipt(worker, `${path}/start`, active.id, {})); }
      catch (error) {
        if (!(error instanceof WorkerHttpError && error.status === 409 && error.code === 'ASR_INPUTS_MISSING')) throw error;
        this.db.prepare(`UPDATE aigate_asr_jobs SET stage='awaiting_upload', updated_at=?, error_code=?,
          error_message='Upload all declared audio clips before confirming' WHERE id=? AND stage='submitting'`)
          .run(Date.now(), error.code, active.id);
      }
    } else if (active.stage === 'running') {
      this.applyReceipt(active, await this.workerReceipt(worker, path, active.id));
    }
  }

  private async request(worker: string, path: string, body?: object) {
    const fetch = this.options.fetch ?? globalThis.fetch;
    const response = await fetch(`${worker}${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${this.options.key}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000),
    });
    const value = await response.json().catch(() => null);
    if (!response.ok) throw new WorkerHttpError(response.status, value?.error?.code ?? value?.detail?.code);
    return value;
  }

  private async workerReceipt(worker: string, path: string, id: string, body?: object) {
    const value = workerSchema.safeParse(await this.request(worker, path, body));
    if (!value.success || value.data.id !== id) throw new Error('ASR worker job receipt invalid');
    return value.data;
  }

  private applyReceipt(row: Row, receipt: WorkerReceipt) {
    const now = Date.now();
    const { queuedAt, startedAt, finishedAt } = receipt;
    const timing = JSON.stringify({ queuedAt, startedAt, finishedAt });
    if (receipt.status === 'succeeded') {
      const manifest = JSON.parse(row.input) as AsrInput;
      const results = new Map(receipt.results?.map(item => [item.id, item]) ?? []);
      if (receipt.results?.length !== manifest.clips.length || !manifest.clips.every(clip => results.has(clip.id)))
        throw new Error('ASR worker result does not match manifest');
      const result = JSON.stringify({ transcripts: manifest.clips.map(clip => results.get(clip.id)!) });
      this.db.prepare(`UPDATE aigate_asr_jobs SET stage='succeeded', token=NULL, result=?, worker_timing=?, updated_at=?
        WHERE id=? AND stage IN ('running','submitting')`).run(result, timing, now, row.id);
    } else if (receipt.status === 'failed' && receipt.error) {
      this.db.prepare(`UPDATE aigate_asr_jobs SET stage='failed', token=NULL, error_code=?, error_message=?, worker_timing=?, updated_at=?
        WHERE id=? AND stage IN ('running','submitting')`).run(receipt.error.code, receipt.error.message, timing, now, row.id);
    } else if (receipt.status === 'queued' || receipt.status === 'running') {
      this.db.prepare(`UPDATE aigate_asr_jobs SET stage='running', worker_timing=?, updated_at=?
        WHERE id=? AND stage IN ('running','submitting') AND (worker_timing IS NULL OR worker_timing != ?)`)
        .run(timing, now, row.id, timing);
    } else {
      throw new Error('ASR worker has not confirmed start');
    }
  }

  private byId(id: string): Row {
    const row = this.db.prepare('SELECT * FROM aigate_asr_jobs WHERE owner=? AND id=?').get(this.owner, id) as Row | undefined;
    if (!row) throw new SystemError(404, 'ASR_JOB_NOT_FOUND', 'ASR job not found');
    return row;
  }

  private byRequest(requestKey: string): Row {
    const row = this.db.prepare('SELECT * FROM aigate_asr_jobs WHERE owner=? AND request_key=?')
      .get(this.owner, requestKey) as Row | undefined;
    if (!row) throw new SystemError(404, 'ASR_JOB_NOT_FOUND', 'ASR job not found');
    return row;
  }

  private project(row: Row) {
    const input = JSON.parse(row.input) as AsrInput;
    const status = ['queued', 'succeeded', 'failed'].includes(row.stage) ? row.stage : 'running';
    return {
      id: row.id, status, stage: row.stage,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
      billing: { unit: 'second', requestedSeconds: Math.ceil(input.clips.reduce((sum, clip) => sum + clip.durationMs, 0) / 1_000) },
      ...(row.stage === 'awaiting_upload' ? { upload: {
        token: row.token,
        files: input.clips.map(clip => ({ id: clip.id, url: `${row.worker}/v1/jobs/${row.id}/audio/${clip.id}` })),
      } } : {}),
      ...(row.result ? { result: JSON.parse(row.result) } : {}),
      ...(row.worker_timing ? { workerTiming: JSON.parse(row.worker_timing) } : {}),
      ...(row.error_code ? { error: { code: row.error_code, message: row.error_message, providerTerminal: row.stage === 'failed' } } : {}),
    };
  }
}
