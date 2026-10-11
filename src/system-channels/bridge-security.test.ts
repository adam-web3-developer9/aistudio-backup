import { afterEach, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MioraAdapter } from '../adapters/miora-adapter.js';
import { AdapterRegistry } from '../adapters/adapter.js';
import { BrowserPool } from '../browser/browser-pool.js';
import { AccountPool } from '../jobs/account-pool.js';
import { JobRunner } from '../jobs/job-runner.js';
import { ProjectStore } from '../projects/store.js';
import { SystemJobStore } from '../system-jobs/store.js';
import { AssetStore } from '../stores/asset-store.js';
import { JobStore } from '../stores/job-store.js';
import type { SystemRuntime } from '../system/index.js';
import type { CreditBalance } from '../types.js';
import { ChannelJobBridge } from './bridge.js';
import { ManagedSessionStore } from './session-store.js';
import { ChannelStore } from './store.js';

const owner = { id: 'owner', sessionId: 'isolated-session', emailVerified: true, cloudEligible: true, sharingEligible: true };
const adapterId = new MioraAdapter().id;
const balance: CreditBalance = { totalCredits: 1000, breakdown: [] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture(blockCredits = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'system-bridge-security-'));
  const db = new Database(':memory:');
  const channels = new ChannelStore(db, Buffer.alloc(32, 19).toString('base64'));
  const jwt = 'eyJhbGciOiJub25lIn0.' + Buffer.from(JSON.stringify({ sub: 'isolated-user', exp: 4102444800 })).toString('base64url') + '.fake';
  const managed = channels.import(jwt);
  channels.update(managed.id, { enabled: true });
  const sessions = new ManagedSessionStore(directory, channels);
  const assets = new AssetStore(directory);
  const channelJobs = new JobStore({ dataDir: directory });
  await Promise.all([sessions.initialize(), assets.initialize(), channelJobs.initialize()]);
  const projects = new ProjectStore(db);
  projects.share('project', owner, { entities: [{ type: 'shot', id: 'shot', fields: { prompt: 'isolated' } }], collections: {} }, []);
  const jobs = new SystemJobStore(db, projects);
  db.exec('CREATE TABLE shared_project_media(project_id TEXT,generation INTEGER,entity_type TEXT,entity_id TEXT,hash TEXT,size INTEGER,mime TEXT,PRIMARY KEY(project_id,generation,entity_type,entity_id,hash))');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const hash = createHash('sha256').update(png).digest('hex');
  db.prepare('INSERT INTO shared_project_media VALUES(?,?,?,?,?,?,?)').run('project', 1, 'shot', 'shot', hash, png.length, 'image/png');
  let releaseCredits!: (value: CreditBalance) => void;
  const creditPromise = new Promise<CreditBalance>(resolve => { releaseCredits = resolve; });
  const state = { creditStarted: false, paidCalls: 0, beforeMediaRead: () => {} };
  const adapters = new AdapterRegistry();
  adapters.register({
    // Match the original worker contract, rather than inventing a second Miora ID.
    id: adapterId,
    allowedCookieDomains: ['miora.design'],
    getCreditsFromCookies: async () => { state.creditStarted = true; return blockCredits ? creditPromise : balance; },
    estimateJobCost: () => 1,
    runWithoutBrowser: async (_cookies, input) => {
      await input.beforeSubmit?.();
      state.paidCalls++;
      return { videoUrl: 'https://isolated.miora.design/fake.mp4' };
    },
    run: async () => { throw new Error('Browser execution is forbidden in this fixture'); },
  });
  const accountPool = new AccountPool(sessions, adapters, { maxJobsPerAccount: 1, creditsRetryDelaysMs: [] });
  const runner = new JobRunner(channelJobs, assets, sessions, adapters, new BrowserPool(1, true), accountPool, { timeoutMs: 1000, directTimeoutMs: 1000 });
  const runtime = { db, assertPrincipalCurrent: () => {} } as unknown as SystemRuntime;
  const bridge = new ChannelJobBridge({
    runtime, channels, jobs, legacy: { jobs: channelJobs, assets, sessions, accountPool, runner },
    blobs: { get: async () => { state.beforeMediaRead(); return png; }, put: async () => {} },
    pollIntervalMs: 5,
    fetchResult: async () => { throw new Error('External result fetch is forbidden in this fixture'); },
  });
  cleanup.push(async () => { bridge.close(); releaseCredits(balance); await channelJobs.flush(); db.close(); await rm(directory, { recursive: true, force: true }); });
  const create = (requestId: string) => jobs.create('project', owner, {
    requestId, generation: 1, target: { type: 'shot', id: 'shot' }, inputVersion: 0,
    executor: 'server', kind: 'miora.video', parameters: { text: 'isolated', mediaHashes: [hash] },
  });
  return { directory, db, channels, sessions, channelJobs, assets, adapters, accountPool, jobs, runner, bridge, state, releaseCredits, create };
}

test('canceling while the original worker waits for account credit prevents paid submission', async () => {
  const f = await fixture(true);
  expect(f.channels.session(f.channels.sessions()[0]!.id)!.adapterId).toBe(adapterId);
  const created = f.create('cancel-account-wait');
  await f.bridge.submit(created.job.id, owner);
  await vi.waitFor(() => expect(f.state.creditStarted).toBe(true), { timeout: 1000, interval: 5 });
  f.jobs.cancel('project', created.job.id, owner);
  f.releaseCredits(balance);
  await vi.waitFor(() => expect(f.channelJobs.list()[0]?.status).toBe('failed'), { timeout: 1000, interval: 5 });
  expect(f.state.paidCalls).toBe(0);
  expect(f.jobs.row(created.job.id)!.status).toBe('canceled');
});

test('canceling during media preparation durably removes the runnable legacy queue entry', async () => {
  const f = await fixture();
  const created = f.create('cancel-media');
  f.state.beforeMediaRead = () => { f.jobs.cancel('project', created.job.id, owner); };
  await f.bridge.submit(created.job.id, owner);
  await f.channelJobs.flush();
  expect(f.jobs.row(created.job.id)!.status).toBe('canceled');
  expect(f.channelJobs.list({ status: 'queued' })).toHaveLength(0);
  const restored = new JobStore({ dataDir: f.directory });
  await restored.initialize();
  const recoveredRunner = new JobRunner(restored, f.assets, f.sessions, f.adapters, new BrowserPool(1, true), f.accountPool, { timeoutMs: 1000, directTimeoutMs: 1000 });
  expect(recoveredRunner.recover().requeued).toHaveLength(0);
  expect(f.state.paidCalls).toBe(0);
});

test('restart never submits a queued system channel job without its durable execution owner', async () => {
  const f = await fixture();
  const asset = await f.assets.save({ originalName: 'isolated.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  f.channelJobs.create({ adapterId, sessionId: f.channels.sessions()[0]!.id, text: 'isolated', assetId: asset.id }, 'job_system_restart_fixture');
  await f.channelJobs.flushOrThrow('job_system_restart_fixture');
  const restored = new JobStore({ dataDir: f.directory });
  await restored.initialize();
  const recoveredRunner = new JobRunner(restored, f.assets, f.sessions, f.adapters, new BrowserPool(1, true), f.accountPool, { timeoutMs: 1000, directTimeoutMs: 1000 });
  const recovery = recoveredRunner.recover();
  expect(recovery.requeued).toHaveLength(0);
  expect(recovery.interrupted).toContain('job_system_restart_fixture');
  expect(restored.get('job_system_restart_fixture')?.status).toBe('failed');
  await restored.flush();
  expect(f.state.paidCalls).toBe(0);
});
