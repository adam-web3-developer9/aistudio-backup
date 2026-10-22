import type { ComfyJob } from './store.js';

export interface NativeAttempt {
  number: number;
  marker: string;
  plannedId: string;
  promptId?: string;
  sentAt: number;
  confirmed: boolean;
  state?: 'missing' | 'running' | 'succeeded' | 'failed';
}
export interface NativeCheckpoint {
  attempts: NativeAttempt[];
  nextAt: number;
  windowStart: number;
  windowKey?: string;
  windowKeys?: string[];
  selectedPromptId?: string;
  // Native upload receipts only. Graph, profile, values and seed remain in frozen input.
  mediaValues?: Record<string, string>;
}

export function nativeCheckpoint(job: ComfyJob): NativeCheckpoint {
  if (job.native_checkpoint) return JSON.parse(job.native_checkpoint) as NativeCheckpoint;
  return {
    attempts: [{ number: 1, marker: job.id, plannedId: job.prompt_id,
      ...(job.provider_confirmed ? { promptId: job.prompt_id } : {}),
      sentAt: job.updated_at, confirmed: !!job.provider_confirmed }],
    nextAt: job.updated_at + 10_000, windowStart: 0,
  };
}

export const nativeRetryDelay = (attemptsInWindow: number): number => attemptsInWindow === 1 ? 10_000 : 30_000;
