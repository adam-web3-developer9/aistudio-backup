import type { AigateClient } from './aigate-client.js';
import type { ComfyStore } from './store.js';

/** Business idle shutdown and the platform's low-GPU fallback remain independent. */
export class ComfyPowerPolicy {
  private readonly configured = new Set<string>();
  private readonly nextAttempt = new Map<string, number>();

  constructor(private readonly options: {
    platform: Partial<Pick<AigateClient, 'setGpuIdleShutdown'>>;
    store: Pick<ComfyStore, 'instance' | 'updateInstance' | 'events'>;
    assertWorker: () => void;
    retryIntervalMs: number;
  }) {}

  async reconcile(instanceId: string, platformStatus: string): Promise<void> {
    if (platformStatus !== '2') {
      this.configured.delete(instanceId);
      this.nextAttempt.delete(instanceId);
      return;
    }
    if (this.configured.has(instanceId) || !this.options.platform.setGpuIdleShutdown
      || (this.nextAttempt.get(instanceId) ?? 0) > Date.now()) return;
    try {
      await this.options.platform.setGpuIdleShutdown(instanceId);
    } catch (error) {
      this.options.assertWorker();
      const failure = error as { code?: unknown; errCode?: unknown } | null;
      this.nextAttempt.set(instanceId, Date.now() + this.options.retryIntervalMs);
      const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
      this.options.store.events.record({ type: 'instance.updated', instanceId,
        jobId: this.options.store.instance(instanceId)?.job_id ?? undefined,
        code: 'COMFY_GPU_IDLE_SET_FAILED', details: { errorType: safe(failure?.code), upstreamCode: safe(failure?.errCode) } });
      return;
    }
    this.options.assertWorker();
    this.options.store.updateInstance(instanceId, { idle_policy_applied_at: Date.now() });
    this.configured.add(instanceId);
    this.nextAttempt.delete(instanceId);
    this.options.store.events.record({ type: 'instance.updated', instanceId,
      jobId: this.options.store.instance(instanceId)?.job_id ?? undefined, code: 'COMFY_GPU_IDLE_SET' });
  }
}
