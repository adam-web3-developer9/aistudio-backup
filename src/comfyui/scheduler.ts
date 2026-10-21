import type { ComfyPoolConfiguration } from './configuration.js';

export function schedulerPolicy(configuration: ComfyPoolConfiguration) {
  return {
    uploadReservationTimeoutMs: 600_000, uploadRetryDelayMs: 60_000, maxUploadReservations: 3,
    idleStopAfterMs: 300_000, minWarmInstances: 0, maxConcurrentInstances: 6,
    estimatedJobMs: 600_000, targetQueueWaitMs: 600_000, ...configuration.scheduler,
  };
}
