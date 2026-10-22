import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import { AigateError } from './aigate-client.js';
import { ComfyPowerPolicy } from './power-policy.js';
import { ComfyStore } from './store.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  const store = new ComfyStore(db);
  store.registerInstances(['1']);
  // A timestamp from the old "enable GPU idle shutdown" implementation is not cancellation evidence.
  store.updateInstance('1', { state: 'busy', idle_policy_applied_at: Date.now() });
  const clearGpuIdleShutdown = vi.fn().mockResolvedValue(undefined);
  const setGpuIdleShutdown = vi.fn();
  const assertWorker = vi.fn();
  const options = { store, platform: { clearGpuIdleShutdown, setGpuIdleShutdown }, assertWorker, retryIntervalMs: 30_000 };
  return { store, options, clearGpuIdleShutdown, setGpuIdleShutdown, policy: new ComfyPowerPolicy(options) };
}

test('cancels the legacy timer for running instances once per power cycle and again after service restart', async () => {
  const { store, options, policy, clearGpuIdleShutdown, setGpuIdleShutdown } = fixture();
  await policy.reconcile('1', '2');
  await policy.reconcile('1', '2');
  expect(clearGpuIdleShutdown).toHaveBeenCalledExactlyOnceWith('1');
  expect(setGpuIdleShutdown).not.toHaveBeenCalled();
  expect(store.events.list({ instanceId: '1' }).at(-1)?.code).toBe('COMFY_GPU_IDLE_CLEARED');
  await policy.reconcile('1', '22');
  expect(clearGpuIdleShutdown).toHaveBeenCalledTimes(1);
  await policy.reconcile('1', '2');
  expect(clearGpuIdleShutdown).toHaveBeenCalledTimes(2);
  await new ComfyPowerPolicy(options).reconcile('1', '2');
  expect(clearGpuIdleShutdown).toHaveBeenCalledTimes(3);
});

test('a cancellation failure records the real error, preserves work, and retries without blocking the caller', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { store, policy, clearGpuIdleShutdown } = fixture();
  clearGpuIdleShutdown.mockRejectedValueOnce(new AigateError('BUSINESS_REJECTED', 'private provider text', '40301'));
  const before = store.instance('1');
  await expect(policy.reconcile('1', '2')).resolves.toBeUndefined();
  expect(store.instance('1')).toEqual(before);
  expect(store.events.list({ instanceId: '1' }).at(-1)).toMatchObject({ code: 'COMFY_GPU_IDLE_CLEAR_FAILED',
    details: { errorType: 'BUSINESS_REJECTED', upstreamCode: '40301' } });
  await policy.reconcile('1', '2');
  expect(clearGpuIdleShutdown).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(Date.now() + 30_000);
  await policy.reconcile('1', '2');
  expect(clearGpuIdleShutdown).toHaveBeenCalledTimes(2);
  expect(store.events.list({ instanceId: '1' }).at(-1)?.code).toBe('COMFY_GPU_IDLE_CLEARED');
});
