import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ComfyInstanceLifecycleConfiguration, ComfyPoolConfiguration } from './configuration.js';
import { comfyPoolMetrics } from './metrics.js';
import { ComfyStore, type ComfyInstanceRow, type ComfyResource, type ComfyStage } from './store.js';

const now = Date.UTC(2026, 9, 21, 12);
const dayMs = 86_400_000;
let database: Database.Database;
let store: ComfyStore;
let configuration: ComfyPoolConfiguration;
let jobSequence: number;
let resourceSequence: number;

beforeEach(() => {
  database = new Database(':memory:');
  store = new ComfyStore(database);
  jobSequence = 0;
  resourceSequence = 0;
  configuration = {
    autoOpen: false, pollIntervalMs: 5_000, bootTimeoutMs: 600_000, jobTimeoutMs: 7_200_000,
    instances: [], workflows: [{ id: 'fixture', version: '1', bindings: {}, outputNodeIds: ['1'],
      graph: { '1': { class_type: 'Render', inputs: {} } } }]
  };
});

afterEach(() => { database.close(); });

function job(options: { stage?: ComfyStage; createdAt?: number; finishedAt?: number; eligibleAt?: number; deadline?: number } = {}) {
  const saved = store.submit('owner', { adapterId: 'comfyui-v1', requestKey: 'request-' + ++jobSequence,
    workflowId: 'fixture', values: {}, media: {}, profile: configuration.workflows[0]! }, dayMs, options.createdAt ?? now).job;
  database.prepare('UPDATE comfy_jobs SET stage=?,finished_at=?,eligible_at=?,deadline=? WHERE id=?')
    .run(options.stage ?? 'queued', options.finishedAt ?? null, options.eligibleAt ?? null, options.deadline ?? now + dayMs, saved.id);
  return store.get(saved.id)!;
}

function event(jobId: string, stage: ComfyStage, time: number | string) {
  const saved = store.events.record({ type: 'job.updated', jobId, stage });
  database.prepare('UPDATE comfy_events SET time=? WHERE sequence=?')
    .run(typeof time === 'number' ? new Date(time).toISOString() : time, saved.sequence);
}

function completedSample(preparationMs: number | null, executionMs: number | null, finishedAt = now, stage: ComfyStage = 'succeeded') {
  const saved = job({ stage, createdAt: finishedAt - 2 * dayMs, finishedAt });
  const submittedAt = finishedAt - (executionMs ?? 0) - 1_000;
  if (preparationMs !== null) {
    event(saved.id, 'preparing', submittedAt - preparationMs);
    event(saved.id, 'submitting', submittedAt);
  }
  if (executionMs !== null) event(saved.id, 'running', finishedAt - executionMs);
  event(saved.id, stage, finishedAt);
  return saved;
}

function instance(id: string, lifecycle?: ComfyInstanceLifecycleConfiguration, patch: Partial<Omit<ComfyInstanceRow, 'id'>> = {}) {
  configuration.instances.push({ id, baseUrl: 'https://comfy.example', workflowIds: ['fixture'], ...(lifecycle ? { lifecycle } : {}) });
  store.registerInstances([id]);
  store.updateInstance(id, patch);
}

function policy(hourlyCost = 4, storageHourlyCost = 0.5): ComfyInstanceLifecycleConfiguration {
  return { hourlyCost, storageHourlyCost, allowRelease: false, rebuildVerified: false };
}

function resource(patch: Partial<ComfyResource> = {}) {
  store.saveResource({ key: 'resource-' + ++resourceSequence, name: 'reserved-instance', state: 'creating',
    instance_id: null, configuration: null, template_id: 'template-1', hourly_cost: 4, storage_hourly_cost: 0.5,
    created_at: now - 60_000, updated_at: now, error_code: null, ...patch });
}

describe('comfyPoolMetrics queue and stages', () => {
  it('returns empty counts and null duration summaries without inventing samples', () => {
    const metrics = comfyPoolMetrics(store, configuration, now);
    expect(metrics).toMatchObject({ measuredAt: new Date(now).toISOString(), stages: {}, queued: 0, eligibleQueued: 0, oldestQueuedMs: 0,
      instances: { registered: 0, busy: 0, unhealthy: 0, stopped: 0 },
      last24Hours: { completed: 0, preparation: { samples: 0, medianMs: null, p95Ms: null },
        execution: { samples: 0, medianMs: null, p95Ms: null } } });
  });

  it('counts every persisted stage separately', () => {
    const stages: ComfyStage[] = ['queued', 'preparing', 'awaiting_upload', 'submitting', 'running', 'collecting', 'succeeded', 'failed', 'cancelled'];
    for (const stage of stages) job({ stage });
    job({ stage: 'running' });
    expect(comfyPoolMetrics(store, configuration, now).stages)
      .toEqual({ ...Object.fromEntries(stages.map(stage => [stage, 1])), running: 2 });
  });

  it('separates eligible queue depth from delayed and expired jobs and reports queue elapsed', () => {
    job({ createdAt: now - 90_000 });
    job({ createdAt: now - 70_000, eligibleAt: now });
    job({ createdAt: now - 50_000, eligibleAt: now - 1 });
    job({ createdAt: now - 30_000, eligibleAt: now + 1 });
    job({ createdAt: now - 20_000, deadline: now });
    job({ createdAt: now - 10_000, deadline: now - 1 });
    job({ stage: 'running', createdAt: now - dayMs });
    expect(comfyPoolMetrics(store, configuration, now)).toMatchObject({ queued: 6, eligibleQueued: 3, oldestQueuedMs: 90_000 });
    expect(comfyPoolMetrics(store, configuration, now + 1)).toMatchObject({ queued: 6, eligibleQueued: 4, oldestQueuedMs: 90_001 });
  });

  it('counts instance health only for instances in the active pool configuration', () => {
    const running = job({ stage: 'running' });
    instance('1', policy(), { state: 'busy', job_id: running.id });
    instance('2', policy(), { state: 'quarantined', error_code: 'COMFY_UNAVAILABLE' });
    instance('3', policy(), { state: 'offline', stopped_at: now - 1_000 });
    store.registerInstances(['99']);
    store.updateInstance('99', { state: 'offline', stopped_at: now, error_code: 'COMFY_OLD_INSTANCE' });
    expect(comfyPoolMetrics(store, configuration, now).instances).toEqual({ registered: 3, busy: 1, unhealthy: 1, stopped: 1 });
  });
});

describe('comfyPoolMetrics last 24 hours', () => {
  it('uses completion time, includes the 24-hour boundary, and excludes old or non-successful jobs', () => {
    completedSample(100, 1_000, now - dayMs);
    completedSample(300, 3_000, now);
    completedSample(999_000, 999_000, now - dayMs - 1);
    for (const stage of ['failed', 'cancelled', 'running'] as const) completedSample(999_000, 999_000, now, stage);
    expect(comfyPoolMetrics(store, configuration, now).last24Hours).toEqual({ completed: 2,
      preparation: { samples: 2, medianMs: 200, p95Ms: 300 }, execution: { samples: 2, medianMs: 2_000, p95Ms: 3_000 } });
  });

  it('sorts odd samples before calculating the median and nearest-rank p95', () => {
    for (const duration of [9_000, 1_000, 3_000]) completedSample(duration, duration * 2);
    expect(comfyPoolMetrics(store, configuration, now).last24Hours).toEqual({ completed: 3,
      preparation: { samples: 3, medianMs: 3_000, p95Ms: 9_000 }, execution: { samples: 3, medianMs: 6_000, p95Ms: 18_000 } });
  });

  it('averages middle values for even samples and does not equate p95 to the maximum', () => {
    for (let sample = 20; sample >= 1; sample--) {
      const duration = sample === 20 ? 1_000_000 : sample * 1_000;
      completedSample(duration, duration * 2);
    }
    expect(comfyPoolMetrics(store, configuration, now).last24Hours).toEqual({ completed: 20,
      preparation: { samples: 20, medianMs: 10_500, p95Ms: 19_000 }, execution: { samples: 20, medianMs: 21_000, p95Ms: 38_000 } });
  });

  it('preserves valid zero-duration samples instead of returning null', () => {
    completedSample(0, 0);
    expect(comfyPoolMetrics(store, configuration, now).last24Hours).toEqual({ completed: 1,
      preparation: { samples: 1, medianMs: 0, p95Ms: 0 }, execution: { samples: 1, medianMs: 0, p95Ms: 0 } });
  });

  it('keeps preparation and execution sample counts independent when events are missing', () => {
    completedSample(null, 4_000);
    completedSample(2_000, null);
    job({ stage: 'succeeded', finishedAt: now });
    expect(comfyPoolMetrics(store, configuration, now).last24Hours).toEqual({ completed: 3,
      preparation: { samples: 1, medianMs: 2_000, p95Ms: 2_000 }, execution: { samples: 1, medianMs: 4_000, p95Ms: 4_000 } });
  });

  it('reports null rather than zero when successful jobs have no usable timing events', () => {
    job({ stage: 'succeeded', finishedAt: now });
    expect(comfyPoolMetrics(store, configuration, now).last24Hours).toEqual({ completed: 1,
      preparation: { samples: 0, medianMs: null, p95Ms: null }, execution: { samples: 0, medianMs: null, p95Ms: null } });
  });

  it('excludes malformed and negative elapsed samples', () => {
    const saved = job({ stage: 'succeeded', finishedAt: now });
    event(saved.id, 'preparing', 'invalid-time');
    event(saved.id, 'submitting', now - 1_000);
    event(saved.id, 'running', now);
    event(saved.id, 'succeeded', now - 1);
    expect(comfyPoolMetrics(store, configuration, now).last24Hours).toEqual({ completed: 1,
      preparation: { samples: 0, medianMs: null, p95Ms: null }, execution: { samples: 0, medianMs: null, p95Ms: null } });
  });
});

describe('comfyPoolMetrics cost estimates', () => {
  it('explicitly marks missing legacy prices as unknown rather than silently claiming a free pool', () => {
    instance('1');
    instance('2');
    const cost = comfyPoolMetrics(store, configuration, now).cost;
    expect(cost.unknownCostInstances).toBe(2);
    expect(cost.unknownCostInstances).toBeGreaterThan(0);
    expect(cost).toMatchObject({ isEstimate: true, includesHistoricalBilling: false, maxHourlyCost: null });
  });

  it('retains the known subtotal and separately reports instances with unknown costs', () => {
    instance('1', policy(6, 0.5), { state: 'busy' });
    instance('2');
    expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 6.5, unknownCostInstances: 1 });
  });

  it('distinguishes explicit zero prices from unknown prices', () => {
    instance('1', policy(0, 0), { state: 'ready' });
    expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 0, unknownCostInstances: 0 });
  });

  it('charges only storage for an instance whose shutdown is confirmed', () => {
    instance('1', policy(8, 0.25), { state: 'offline', stopped_at: now - 5_000 });
    expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 0.25, unknownCostInstances: 0 });
  });

  it.each(['offline', 'waiting_capacity', 'starting', 'ready', 'busy', 'closing', 'quarantined'] as const)(
    'reserves compute plus storage for %s without confirmed shutdown', state => {
      instance('1', policy(8, 0.25), { state, stopped_at: null });
      expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 8.25, unknownCostInstances: 0 });
    }
  );

  it('charges a running instance compute plus storage despite a stale shutdown timestamp', () => {
    instance('1', policy(8, 0.25), { state: 'busy', stopped_at: now - 60_000 });
    expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 8.25, unknownCostInstances: 0 });
  });

  it('does not declare a stopped instance free when its storage price is unknown', () => {
    instance('1', undefined, { state: 'offline', stopped_at: now - 1_000 });
    expect(comfyPoolMetrics(store, configuration, now).cost.unknownCostInstances).toBe(1);
  });

  it.each(['creating', 'uncertain', 'releasing', 'blocked'] as const)(
    'reserves the full estimated cost of an unconfirmed %s resource', state => {
      resource({ state, hourly_cost: 10, storage_hourly_cost: 0.75 });
      expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 10.75,
        unknownCostInstances: 0, isEstimate: true, includesHistoricalBilling: false });
    }
  );

  it('adds unconfirmed reservations to registered instance costs without dropping either', () => {
    instance('1', policy(6, 0.5), { state: 'ready' });
    resource({ state: 'creating', hourly_cost: 10, storage_hourly_cost: 0.75 });
    resource({ state: 'uncertain', hourly_cost: 4, storage_hourly_cost: 0.25 });
    expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 21.5, unknownCostInstances: 0 });
  });

  it('does not double count a registered resource and uses its saved prices instead of policy estimates', () => {
    instance('1', policy(100, 100), { state: 'busy' });
    resource({ state: 'registered', instance_id: '1', hourly_cost: 4, storage_hourly_cost: 0.5 });
    expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 4.5, unknownCostInstances: 0 });
  });

  it('can resolve otherwise unknown instance costs from its resource record', () => {
    instance('1', undefined, { state: 'ready' });
    resource({ state: 'registered', instance_id: '1', hourly_cost: 4, storage_hourly_cost: 0.5 });
    expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 4.5, unknownCostInstances: 0 });
  });

  it('charges only saved storage costs for a stopped registered resource', () => {
    instance('1', policy(100, 100), { state: 'offline', stopped_at: now - 1_000 });
    resource({ state: 'registered', instance_id: '1', hourly_cost: 4, storage_hourly_cost: 0.5 });
    expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 0.5, unknownCostInstances: 0 });
  });

  it('excludes released reservations from the ongoing estimate', () => {
    resource({ state: 'released', hourly_cost: 100, storage_hourly_cost: 50 });
    expect(comfyPoolMetrics(store, configuration, now).cost).toMatchObject({ estimatedHourlyCost: 0, unknownCostInstances: 0 });
  });

  it('does not use released resource prices to hide an unknown live instance cost', () => {
    instance('1', undefined, { state: 'ready' });
    resource({ state: 'released', instance_id: '1', hourly_cost: 4, storage_hourly_cost: 0.5 });
    expect(comfyPoolMetrics(store, configuration, now).cost.unknownCostInstances).toBe(1);
  });

  it('labels estimates and the configured budget without presenting historical or actual billing', () => {
    configuration.elastic = { enabled: false, maxInstances: 6, maxHourlyCost: 20, createCooldownMs: 60_000,
      releaseAfterMs: 3_600_000, reconcileTimeoutMs: 300_000, templates: [] };
    instance('1', policy(6, 0.5), { state: 'ready' });
    expect(comfyPoolMetrics(store, configuration, now).cost).toEqual({ estimatedHourlyCost: 6.5,
      unknownCostInstances: 0, isEstimate: true, includesHistoricalBilling: false, maxHourlyCost: 20 });
  });
});
