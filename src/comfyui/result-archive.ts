import { randomUUID } from 'node:crypto';
import type { ComfyOutput } from './comfy-client.js';
import type { ComfyStore, ComfyJob, FrozenComfyInput } from './store.js';
import type { ArchiveFile, ResultArchiveStorage } from './tos-result-storage.js';
import type { ComfyEventDetails } from './events.js';

export interface GpuResultExporter {
  describe(job: ComfyJob, output: ComfyOutput, signal: AbortSignal): Promise<ArchiveFile>;
  upload(job: ComfyJob, output: ComfyOutput, file: ArchiveFile,
    target: { url: string; headers: Record<string, string> }, signal: AbortSignal): Promise<ArchiveFile>;
}
export interface ResultArchiveOptions {
  storage: ResultArchiveStorage;
  exporter: (instanceId: string) => GpuResultExporter;
  keyPrefix: string;
  storageIdentity: string;
}
export interface ResultArchiveRecord {
  job_id: string; instance_id: string; object_key: string; storage_identity: string; output: string; ready_at: number;
  state: 'pending' | 'transferring' | 'stored' | 'failed' | 'skipped' | 'deleted';
  file: string | null; attempts: number; next_at: number; uploaded_at: number | null;
  expires_at: number | null; error_code: string | null;
}
const waitMs = 600_000;
const retentionMs = 86_400_000;

export function validArchiveFile(file: ArchiveFile): boolean {
  return Number.isSafeInteger(file.size) && file.size > 0 && file.size <= 5 * 1024 ** 3
    && /^[a-f0-9]{64}$/.test(file.sha256) && /^[A-Za-z0-9+/]{22}==$/.test(file.md5);
}
function sameFile(left: ArchiveFile, right: ArchiveFile): boolean {
  return validArchiveFile(left) && validArchiveFile(right) && left.size === right.size
    && left.sha256 === right.sha256 && left.md5 === right.md5;
}
function safeErrorType(error: unknown): string {
  const value = error as { code?: unknown; name?: unknown } | null;
  if (typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value.code)) return value.code;
  if (typeof value?.name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value.name)) return value.name;
  return 'Error';
}

export class ComfyResultArchive {
  private readonly active = new Map<string, Promise<void>>();
  constructor(private readonly store: ComfyStore, private readonly options: ResultArchiveOptions,
    private readonly assertWorker: () => void, private readonly signal: AbortSignal) {}

  get(id: string): ResultArchiveRecord | undefined {
    return this.store.db.prepare('SELECT * FROM comfy_result_archives WHERE job_id=?').get(id) as ResultArchiveRecord | undefined;
  }
  plan(job: ComfyJob, output: ComfyOutput): void {
    if (!job.instance_id || job.stage !== 'succeeded' || !job.result_pending || job.cancel_requested
      || (JSON.parse(job.input) as FrozenComfyInput).transport !== 'direct') return;
    const readyAt = job.finished_at ?? Date.now();
    this.store.db.prepare(`INSERT OR IGNORE INTO comfy_result_archives
      (job_id,instance_id,object_key,storage_identity,output,ready_at,state,next_at) VALUES(?,?,?,?,?,?,'pending',?)`)
      .run(job.id, job.instance_id, `${this.options.keyPrefix}/${job.id}/${randomUUID()}.mp4`, this.options.storageIdentity, JSON.stringify(output), readyAt, readyAt + waitMs);
  }
  private patch(id: string, values: Partial<Omit<ResultArchiveRecord, 'job_id'>>, details?: ComfyEventDetails): void {
    const prior = this.get(id);
    const fields = Object.entries(values);
    this.store.db.prepare(`UPDATE comfy_result_archives SET ${fields.map(([key]) => `${key}=?`).join(',')} WHERE job_id=?`)
      .run(...fields.map(([, value]) => value), id);
    if (prior && (details || values.state && values.state !== prior.state || values.error_code && values.error_code !== prior.error_code)) {
      this.store.events.record({ type: 'job.updated', jobId: id, instanceId: prior.instance_id, stage: this.store.get(id)?.stage ?? 'succeeded',
        code: values.error_code ?? `COMFY_ARCHIVE_${(values.state ?? prior.state).toUpperCase()}`, ...(details ? { details } : {}) });
    }
  }
  tick(): void {
    this.assertWorker();
    // Older failed archives retained result_pending forever, including rows without an expiry.
    const abandoned = this.store.db.prepare(`SELECT * FROM comfy_result_archives WHERE
      state='failed' OR (state='deleted' AND error_code='COMFY_ARCHIVE_TRANSFER_FAILED')`).all() as ResultArchiveRecord[];
    for (const row of abandoned) this.abandonResult(row);
    const rows = this.store.db.prepare(`SELECT * FROM comfy_result_archives WHERE
      (state IN ('pending','transferring') AND next_at<=?) OR (state IN ('stored','skipped','failed') AND expires_at<=? AND next_at<=?)
      ORDER BY next_at,job_id`).all(Date.now(), Date.now(), Date.now()) as ResultArchiveRecord[];
    for (const row of rows) {
      if (row.storage_identity !== this.options.storageIdentity) {
        this.patch(row.job_id, { next_at: Date.now() + 60_000, error_code: 'COMFY_ARCHIVE_STORAGE_CHANGED' });
        continue;
      }
      if (this.active.size >= 2) break;
      if (this.active.has(row.job_id)) continue;
      if ([...this.active.keys()].some(id => this.get(id)?.instance_id === row.instance_id)) continue;
      const operation = this.process(row).catch(() => {}).finally(() => this.active.delete(row.job_id));
      this.active.set(row.job_id, operation);
    }
  }
  async close(): Promise<void> { await Promise.allSettled(this.active.values()); }
  async settled(): Promise<void> { await Promise.allSettled(this.active.values()); }
  private abandonResult(row: ResultArchiveRecord): void {
    this.store.db.transaction(() => {
      const job = this.store.get(row.job_id);
      if (!job || job.stage !== 'succeeded' || !job.result_pending || job.collected_at !== null) return;
      this.store.updateJob(job.id, { stage: 'failed', error_code: 'COMFY_ARCHIVE_TRANSFER_FAILED',
        result: null, result_pending: 0, result_wake_requested: 0 });
      this.store.releaseSlot(job.id);
      if (!this.store.hasUnresolvedWork(row.instance_id)) this.store.updateInstance(row.instance_id, { idle_since: 0 });
    })();
  }
  private async process(row: ResultArchiveRecord): Promise<void> {
    let phase = 'archive_describe';
    try {
      this.assertWorker();
      if (row.state === 'stored' || row.state === 'skipped' || row.state === 'failed') {
        phase = 'archive_cleanup';
        await this.options.storage.delete(row.object_key);
        this.assertWorker();
        this.patch(row.job_id, { state: 'deleted', error_code: row.state === 'failed' ? 'COMFY_ARCHIVE_TRANSFER_FAILED' : null });
        return;
      }
      let job = this.store.get(row.job_id);
      if (!job || job.stage !== 'succeeded' || job.cancel_requested || !job.result_pending) {
        this.patch(row.job_id, { state: 'skipped', error_code: null,
          expires_at: row.file ? Date.now() + retentionMs : null, next_at: Date.now() + retentionMs });
        return;
      }
      this.patch(row.job_id, { state: 'transferring', attempts: Math.min(3, row.attempts + 1) });
      if (row.file) phase = 'archive_head';
      let file = row.file ? JSON.parse(row.file) as ArchiveFile : undefined;
      let object = file ? await this.options.storage.head(row.object_key) : null;
      this.assertWorker();
      if (!object) {
        if (row.attempts >= 3) throw new Error('Archive attempts exhausted');
        phase = 'archive_describe';
        const exporter = this.options.exporter(row.instance_id);
        const output = JSON.parse(row.output) as ComfyOutput;
        const observed = await exporter.describe(job, output, this.signal);
        this.assertWorker();
        if (!validArchiveFile(observed) || file && !sameFile(file, observed)) throw new Error('Archive file changed');
        file ??= observed;
        this.patch(row.job_id, { file: JSON.stringify(file) });
        job = this.store.get(row.job_id)!;
        if (!job.result_pending || job.cancel_requested) {
          this.patch(row.job_id, { state: 'skipped', expires_at: Date.now() + retentionMs, next_at: Date.now() + retentionMs });
          return;
        }
        phase = 'archive_upload';
        const receipt = await exporter.upload(job, output, file, this.options.storage.uploadTarget(row.object_key, file), this.signal);
        this.assertWorker();
        if (!sameFile(file, receipt)) throw new Error('Archive receipt mismatch');
        phase = 'archive_head';
        object = await this.options.storage.head(row.object_key);
        this.assertWorker();
      }
      if (!file || !object || !sameFile(file, object) || !Number.isSafeInteger(object.uploadedAt)
        || object.uploadedAt < row.ready_at - 1_000 || object.uploadedAt > Date.now() + 60_000
        || object.uploadedAt + retentionMs <= Date.now()) throw new Error('Archive verification failed');
      const expiresAt = object.uploadedAt + retentionMs;
      this.store.db.transaction(() => {
        const current = this.store.get(row.job_id)!;
        const needed = !current.cancel_requested && current.stage === 'succeeded' && current.result_pending === 1 && current.collected_at === null;
        this.patch(row.job_id, { state: needed ? 'stored' : 'skipped', uploaded_at: object.uploadedAt, expires_at: expiresAt, next_at: expiresAt, error_code: null });
        if (needed) {
          this.store.updateJob(row.job_id, { result: JSON.stringify({ storage: 'tos', objectKey: row.object_key, expiresAt }),
            result_pending: 0, result_wake_requested: 0, error_code: null });
          this.store.releaseSlot(row.job_id);
          if (!this.store.hasUnresolvedWork(row.instance_id)) {
            this.store.updateInstance(row.instance_id, { idle_since: 0 });
          }
        }
      })();
    } catch (error) {
      if (this.signal.aborted) return;
      try { this.assertWorker(); } catch { return; }
      const cleanup = ['stored', 'skipped', 'failed'].includes(row.state);
      const failed = !cleanup && row.attempts >= 3;
      this.store.db.transaction(() => {
        this.patch(row.job_id, { state: cleanup ? row.state : failed ? 'failed' : 'pending',
          ...(failed && this.get(row.job_id)?.file ? { expires_at: Date.now() + retentionMs } : {}),
          next_at: Date.now() + 60_000, error_code: cleanup ? 'COMFY_ARCHIVE_DELETE_FAILED' : 'COMFY_ARCHIVE_TRANSFER_FAILED' },
        { upstreamCode: phase, errorType: safeErrorType(error) });
        if (failed) this.abandonResult(row);
      })();
    }
  }
  result(id: string): { videoUrl?: string; storage: 'tos'; expiresAt: number; expired: boolean } | undefined {
    const job = this.store.get(id);
    if (!job?.result || (JSON.parse(job.result) as { storage?: string }).storage !== 'tos') return;
    const row = this.get(id);
    if (!row || row.storage_identity !== this.options.storageIdentity || !['stored', 'deleted'].includes(row.state) || row.expires_at === null) return;
    const remainingSeconds = Math.floor((row.expires_at - Date.now()) / 1_000);
    const expired = row.state === 'deleted' || remainingSeconds <= 0;
    return { storage: 'tos', expiresAt: row.expires_at, expired,
      ...(!expired ? { videoUrl: this.options.storage.downloadUrl(row.object_key, Math.min(900, remainingSeconds)) } : {}) };
  }
}
