import { afterEach, expect, test, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MioraAdapter, type MioraAdapterOptions } from '../adapters/miora-adapter.js';
import { MioraClient } from '../adapters/miora-client.js';
import { MioraTaskFailedError } from '../adapters/miora-retry.js';
import type { AdapterInput } from '../adapters/adapter.js';
import type { MioraTokens } from '../adapters/miora-api.js';

const directories: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const options: MioraAdapterOptions = { video: { model: 'minimax-h3', resolution: '768P', durationSeconds: 4, aspectRatio: '16:9' }, pollTimeoutMs: 100, pollIntervalMs: 1, retryDelaysMs: [1, 1] };
async function generate() {
  const directory = await mkdtemp(path.join(tmpdir(), 'single-paid-submit-')); directories.push(directory);
  const imagePath = path.join(directory, 'fake.png'); await writeFile(imagePath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  vi.spyOn(MioraClient.prototype, 'getCredits').mockResolvedValue({ totalCredits: 1000, breakdown: [] });
  vi.spyOn(MioraClient.prototype, 'uploadImage').mockResolvedValue('fake-image-key');
  vi.spyOn(MioraClient.prototype, 'getOrCreateWorkflowId').mockResolvedValue('fake-workflow');
  const adapter = new MioraAdapter(options);
  // Exercise the actual adapter workflow; only provider I/O is replaced.
  return (adapter as unknown as { generate: (tokens: MioraTokens, input: AdapterInput, options: MioraAdapterOptions) => Promise<unknown> })
    .generate({ authToken: 'isolated-token' }, { text: 'isolated', imagePath, allowPaidRetries: false, beforeSubmit: async () => {} }, options);
}
test('system submit losing its response never implicitly submits again', async () => {
  const paid = vi.spyOn(MioraClient.prototype, 'generateVideo').mockRejectedValue(new Error('fetch failed after provider acceptance'));
  await expect(generate()).rejects.toThrow('fetch failed');
  expect(paid).toHaveBeenCalledTimes(1);
});
test('system render failure preserves the original provider task instead of paying again', async () => {
  const paid = vi.spyOn(MioraClient.prototype, 'generateVideo').mockResolvedValue('accepted-original');
  const poll = vi.spyOn(MioraClient.prototype, 'waitForTask').mockRejectedValue(new MioraTaskFailedError('accepted-original', 'render failed'));
  await expect(generate()).rejects.toThrow('render failed');
  expect(paid).toHaveBeenCalledTimes(1);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(poll.mock.calls[0]?.[0]).toBe('accepted-original');
});
