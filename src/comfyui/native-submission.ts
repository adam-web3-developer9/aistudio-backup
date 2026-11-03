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

// The export protocol's jobId is the identity written to hailuoAttemptId,
// not the business job ID used by archive storage and events.
export function nativeResultIdentity(job: ComfyJob): { jobId: string; promptId: string } {
  if (!job.native_checkpoint) return { jobId: job.id, promptId: job.prompt_id };
  const checkpoint = nativeCheckpoint(job);
  if (!checkpoint.selectedPromptId || checkpoint.selectedPromptId !== job.prompt_id) {
    throw new Error('Native result identity is inconsistent');
  }
  const matches = checkpoint.attempts.filter(attempt => attempt.promptId === job.prompt_id);
  const attempt = matches[0];
  if (matches.length !== 1 || !attempt?.confirmed || attempt.state !== 'succeeded'
    || typeof attempt.marker !== 'string' || !/^[A-Za-z0-9_.:-]{1,256}$/.test(attempt.marker)) {
    throw new Error('Native result identity is inconsistent');
  }
  return { jobId: attempt.marker, promptId: job.prompt_id };
}

export const nativeRetryDelay = (attemptsInWindow: number): number => attemptsInWindow === 1 ? 10_000 : 30_000;
