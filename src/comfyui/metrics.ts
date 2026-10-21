import type { ComfyPoolConfiguration } from './configuration.js';
import type { ComfyStore } from './store.js';

export function comfyPoolMetrics(store: ComfyStore, configuration: ComfyPoolConfiguration, now = Date.now()) {
  const stages = store.db.prepare('SELECT stage,COUNT(*) AS count FROM comfy_jobs GROUP BY stage').all() as Array<{ stage: string; count: number }>;
  const queued = store.queued();
  const durations = store.db.prepare([
    'SELECT j.id,',
    "MIN(CASE WHEN e.stage='preparing' THEN e.time END) AS assigned,",
    "MIN(CASE WHEN e.stage='submitting' THEN e.time END) AS submitted,",
    "MIN(CASE WHEN e.stage='running' THEN e.time END) AS running,",
    "MIN(CASE WHEN e.stage='succeeded' THEN e.time END) AS succeeded",
    'FROM comfy_jobs j LEFT JOIN comfy_events e ON e.job_id=j.id',
    "WHERE j.stage='succeeded' AND j.finished_at>=? GROUP BY j.id",
  ].join(' ')).all(now - 86_400_000) as Array<Record<string, string | null>>;
  const samples = (start: string, end: string) => durations.flatMap(row => {
    const duration = row[start] && row[end] ? Date.parse(row[end]!) - Date.parse(row[start]!) : NaN;
    return Number.isFinite(duration) && duration >= 0 ? [duration] : [];
  }).sort((left, right) => left - right);
  const summarize = (values: number[]) => ({ samples: values.length,
    medianMs: values.length ? (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2 : null,
    p95Ms: values.length ? values[Math.ceil(values.length * 0.95) - 1]! : null });
  const instances = store.instances().filter(row => configuration.instances.some(item => item.id === row.id));
  const resources = store.resources();
  let estimatedHourlyCost = 0;
  let unknownCostInstances = 0;
  for (const instance of instances) {
    const policy = configuration.instances.find(item => item.id === instance.id)?.lifecycle;
    const resource = resources.find(item => item.instance_id === instance.id && item.state !== 'released');
    const compute = resource?.hourly_cost ?? policy?.hourlyCost;
    const storage = resource?.storage_hourly_cost ?? policy?.storageHourlyCost;
    if (compute === undefined || storage === undefined) { unknownCostInstances++; continue; }
    estimatedHourlyCost += storage + (instance.stopped_at !== null && instance.state === 'offline' ? 0 : compute);
  }
  for (const resource of resources.filter(item => !item.instance_id && item.state !== 'released')) {
    estimatedHourlyCost += resource.hourly_cost + resource.storage_hourly_cost;
  }
  return {
    measuredAt: new Date(now).toISOString(), stages: Object.fromEntries(stages.map(row => [row.stage, row.count])),
    queued: queued.length, eligibleQueued: queued.filter(job => (job.eligible_at ?? 0) <= now && job.deadline > now).length,
    oldestQueuedMs: queued.length ? Math.max(...queued.map(job => now - job.created_at)) : 0,
    last24Hours: { completed: durations.length, preparation: summarize(samples('assigned', 'submitted')),
      execution: summarize(samples('running', 'succeeded')) },
    instances: { registered: instances.length, busy: instances.filter(item => item.job_id).length,
      unhealthy: instances.filter(item => item.error_code).length, stopped: instances.filter(item => item.stopped_at !== null && item.state === 'offline').length },
    cost: { estimatedHourlyCost, unknownCostInstances, isEstimate: true, includesHistoricalBilling: false,
      maxHourlyCost: configuration.elastic?.maxHourlyCost ?? null },
  };
}
