import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { JobStore } from './job-store.js';

describe('JobStore', () => {
  it('creates and updates a job without leaking mutable state', () => {
    const store = new JobStore();
    const created = store.create({ adapterId: 'demo-v1', text: 'hello', assetId: 'asset_1' });
    created.status = 'failed';

    expect(store.get(created.id)?.status).toBe('queued');
    expect(store.update(created.id, { status: 'running' }).status).toBe('running');
  });

  it('survives a restart when given a data directory', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hailuo-jobs-'));
    const first = new JobStore({ dataDir });
    await first.initialize();
    const job = first.create({ adapterId: 'hailuo-v1', text: 'persist me', assetId: 'asset_1' });
    first.update(job.id, { status: 'running', progress: { providerJobId: 'video-1', updatedAt: 'now' } });
    first.update(job.id, { status: 'succeeded', result: { videoUrl: 'https://example.test/v.mp4' } });
    await first.flush();

    const second = new JobStore({ dataDir });
    await second.initialize();

    expect(second.get(job.id)).toMatchObject({
      id: job.id,
      status: 'succeeded',
      progress: { providerJobId: 'video-1' },
      result: { videoUrl: 'https://example.test/v.mp4' }
    });
    expect(await readdir(path.join(dataDir, 'jobs'))).toEqual([`${job.id}.json`]);
  });

  it('skips a corrupt record and reports it instead of failing to start', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hailuo-jobs-'));
    const jobsDir = path.join(dataDir, 'jobs');
    const good = new JobStore({ dataDir });
    await good.initialize();
    const job = good.create({ adapterId: 'hailuo-v1', text: 'ok', assetId: 'asset_1' });
    await good.flush();
    await writeFile(path.join(jobsDir, 'job_broken.json'), '{ not json', 'utf8');

    const onError = vi.fn();
    const store = new JobStore({ dataDir, onError });
    await store.initialize();

    expect(store.get(job.id)?.status).toBe('queued');
    expect(store.get('job_broken')).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'job_broken');
  });

  it('prunes finished jobs past the retention window but keeps unfinished ones', async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'hailuo-jobs-'));
    const store = new JobStore({ dataDir });
    await store.initialize();
    const old = store.create({ adapterId: 'hailuo-v1', text: 'old', assetId: 'asset_1' });
    const stuck = store.create({ adapterId: 'hailuo-v1', text: 'stuck', assetId: 'asset_1' });
    const fresh = store.create({ adapterId: 'hailuo-v1', text: 'fresh', assetId: 'asset_1' });
    store.update(old.id, { status: 'succeeded', finishedAt: '2026-01-01T00:00:00.000Z' });
    store.update(stuck.id, { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' });
    store.update(fresh.id, { status: 'failed', finishedAt: new Date().toISOString() });

    const pruned = await store.prune(24 * 60 * 60_000);

    expect(pruned).toBe(1);
    expect(store.get(old.id)).toBeUndefined();
    expect(store.list().map((job) => job.id).sort()).toEqual([stuck.id, fresh.id].sort());
    expect(await readdir(path.join(dataDir, 'jobs'))).not.toContain(`${old.id}.json`);
  });
});
