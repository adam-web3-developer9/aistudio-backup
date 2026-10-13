import { describe, expect, it } from 'vitest';
import { MioraAdapter, mioraEstimatedVideoCredits, mioraMinimumVideoCredits } from './miora-adapter.js';
import type { MioraClient, MioraTask } from './miora-client.js';

const adapter = new MioraAdapter();
const describeResult = (adapter as unknown as {
  describeResult: (client: MioraClient, text: string, task: MioraTask,
    context: { creditsBefore?: number; renderAttempts: number }) => Promise<{ videoUrl: string }>;
}).describeResult.bind(adapter);

describe('Miora cost estimate', () => {
  it('uses the actual four-second price for cleanup, and leaves unknown models alone', () => {
    expect(mioraMinimumVideoCredits('minimax-h3')).toBe(26.48);
    expect(mioraMinimumVideoCredits('minimax-h3-max')).toBe(27.4);
    expect(mioraMinimumVideoCredits('unknown')).toBeUndefined();
  });
  const priced = new MioraAdapter({
    video: { model: 'minimax-h3', resolution: '768P', durationSeconds: 15, aspectRatio: '9:16' },
    pollTimeoutMs: 1_000,
    pollIntervalMs: 1
  });
  const balance = { totalCredits: 500, breakdown: [] };

  it('prices a job per second so a batch reserves what it will spend', () => {
    expect(priced.estimateJobCost(balance)).toBe(100);
    expect(priced.estimateJobCost(balance, { durationSeconds: 6 })).toBe(40);
  });

  it('can conservatively reserve fifteen seconds for old upload-intent clients', () => {
    expect(mioraEstimatedVideoCredits(undefined, { model:'minimax-h3', durationSeconds:15 })).toBe(100);
    expect(mioraEstimatedVideoCredits({ durationSeconds:13 }, { model:'minimax-h3', durationSeconds:15 })).toBe(87);
  });

  it('leaves models it has no price for unpriced', () => {
    expect(priced.estimateJobCost(balance, { modelId: 'kling-3.0-video' })).toBeUndefined();
  });
});

describe('Miora completed results', () => {
  it('reports a missing result URL instead of claiming success', async () => {
    const task = { taskId: 'done-1', status: 'succeeded', raw: {} } as MioraTask;
    await expect(describeResult({} as MioraClient, 'prompt', task, { renderAttempts: 1 }))
      .rejects.toThrow('completed but has no downloadable result URL');
  });

  it('surfaces a signing failure for a completed task with a result key', async () => {
    const task = { taskId: 'done-2', status: 'succeeded', resultFileKey: 'key.mp4', raw: {} } as MioraTask;
    const client = { getCdnSignUrl: async () => { throw new Error('signing failed'); } } as unknown as MioraClient;
    await expect(describeResult(client, 'prompt', task, { renderAttempts: 1 }))
      .rejects.toThrow('signing failed');
  });
});
