import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CreateJobInput, JobRecord, JobStatus } from '../types.js';

export interface JobStoreOptions {
  /** When set, every job is mirrored to `<dataDir>/jobs/<id>.json` so a restart keeps it queryable. */
  dataDir?: string;
  onError?: (error: unknown, jobId: string) => void;
}

const FINISHED: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed']);

/**
 * In-memory index of jobs with a write-through copy on disk.
 *
 * Reads stay synchronous (the API serves them straight from the map); writes
 * are queued per job so updates land in order and never block the runner.
 */
export class JobStore {
  private readonly jobs = new Map<string, JobRecord>();
  private readonly directory?: string;
  private readonly writes = new Map<string, Promise<void>>();

  constructor(private readonly options: JobStoreOptions = {}) {
    this.directory = options.dataDir ? path.join(options.dataDir, 'jobs') : undefined;
  }

  /** Load what a previous process left on disk. */
  async initialize(): Promise<void> {
    if (!this.directory) return;
    await mkdir(this.directory, { recursive: true });

    for (const entry of await readdir(this.directory)) {
      if (!entry.endsWith('.json')) continue;
      const id = entry.slice(0, -'.json'.length);
      try {
        const job = JSON.parse(await readFile(path.join(this.directory, entry), 'utf8')) as JobRecord;
        if (job?.id !== id || typeof job.status !== 'string') {
          throw new Error(`Job file ${entry} does not describe job ${id}`);
        }
        this.jobs.set(id, job);
      } catch (error) {
        this.options.onError?.(error, id);
      }
    }
  }

  create(input: CreateJobInput): JobRecord {
    const job: JobRecord = {
      id: `job_${randomUUID()}`,
      ...input,
      status: 'queued',
      createdAt: new Date().toISOString()
    };
    this.jobs.set(job.id, job);
    this.persist(job);
    return structuredClone(job);
  }

  get(id: string): JobRecord | undefined {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : undefined;
  }

  update(id: string, patch: Partial<JobRecord>): JobRecord {
    const current = this.jobs.get(id);
    if (!current) throw new Error(`Job ${id} not found`);
    const updated = { ...current, ...patch };
    this.jobs.set(id, updated);
    this.persist(updated);
    return structuredClone(updated);
  }

  /** Every job, newest first. */
  list(filter: { status?: JobStatus } = {}): JobRecord[] {
    return [...this.jobs.values()]
      .filter((job) => !filter.status || job.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => structuredClone(job));
  }

  /** Forget finished jobs older than `maxAgeMs`; returns how many went. */
  async prune(maxAgeMs: number, now = Date.now()): Promise<number> {
    const expired = [...this.jobs.values()].filter((job) =>
      FINISHED.has(job.status)
      && now - Date.parse(job.finishedAt ?? job.createdAt) > maxAgeMs);

    for (const job of expired) {
      this.jobs.delete(job.id);
      if (!this.directory) continue;
      await this.writes.get(job.id);
      try {
        await unlink(this.filePath(job.id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.options.onError?.(error, job.id);
      }
    }
    return expired.length;
  }

  /** Resolves once every queued write has reached disk. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.writes.values()]);
  }

  private persist(job: JobRecord): void {
    if (!this.directory) return;
    const snapshot = structuredClone(job);
    const previous = this.writes.get(job.id) ?? Promise.resolve();
    const write = previous
      .then(() => this.writeJob(snapshot))
      .catch((error: unknown) => this.options.onError?.(error, job.id));
    this.writes.set(job.id, write);
    void write.then(() => {
      if (this.writes.get(job.id) === write) this.writes.delete(job.id);
    });
  }

  /** Write via a temp file so a crash mid-write cannot leave a truncated record. */
  private async writeJob(job: JobRecord): Promise<void> {
    const target = this.filePath(job.id);
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(job, null, 2), 'utf8');
    await rename(temp, target);
  }

  private filePath(id: string): string {
    const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path.join(this.directory!, `${safeId}.json`);
  }
}
