import type { AigateClient } from './aigate-client.js';
import type { ComfyStore } from './store.js';

/** Business work and native queue state own shutdown; GPU utilization does not. */
export class ComfyPowerPolicy {
  private readonly cleared = new Set<string>();
  private readonly nextAttempt = new Map<string, number>();

  constructor(private readonly options: {
    platform: Partial<Pick<AigateClient, 'clearGpuIdleShutdown'>>;
    store: Pick<ComfyStore, 'instance' | 'events'>;
    assertWorker: () => void;
    retryIntervalMs: number;
  }) {}

  async reconcile(instanceId: string, platformStatus: string): Promise<void> {
    if (platformStatus !== '2') {
      this.cleared.delete(instanceId);
      this.nextAttempt.delete(instanceId);
      return;
    }
    if (this.cleared.has(instanceId) || !this.options.platform.clearGpuIdleShutdown
      || (this.nextAttempt.get(instanceId) ?? 0) > Date.now()) return;
    try {
      await this.options.platform.clearGpuIdleShutdown(instanceId);
    } catch (error) {
      this.options.assertWorker();
      this.nextAttempt.set(instanceId, Date.now() + this.options.retryIntervalMs);
      const failure = error as { code?: unknown; errCode?: unknown } | null;
      const safe = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
      this.options.store.events.record({ type: 'instance.updated', instanceId,
        jobId: this.options.store.instance(instanceId)?.job_id ?? undefined,
        code: 'COMFY_GPU_IDLE_CLEAR_FAILED', details: { errorType: safe(failure?.code), upstreamCode: safe(failure?.errCode) } });
      return;
    }
    this.options.assertWorker();
    this.cleared.add(instanceId);
    this.nextAttempt.delete(instanceId);
    this.options.store.events.record({ type: 'instance.updated', instanceId,
      jobId: this.options.store.instance(instanceId)?.job_id ?? undefined, code: 'COMFY_GPU_IDLE_CLEARED' });
  }
}
