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
  // Reapply on service restart even if an older version left a timestamp behind.
  store.updateInstance('1', { state: 'busy', idle_policy_applied_at: Date.now() });
  const clearGpuIdleShutdown = vi.fn();
  const setGpuIdleShutdown = vi.fn().mockResolvedValue(undefined);
  const assertWorker = vi.fn();
  const options = { store, platform: { clearGpuIdleShutdown, setGpuIdleShutdown }, assertWorker, retryIntervalMs: 30_000 };
  return { store, options, clearGpuIdleShutdown, setGpuIdleShutdown, policy: new ComfyPowerPolicy(options) };
}

test('sets the low-GPU fallback for busy instances once per power cycle and again after service restart without cancelling it', async () => {
  const { store, options, policy, clearGpuIdleShutdown, setGpuIdleShutdown } = fixture();
  await policy.reconcile('1', '2');
  await policy.reconcile('1', '2');
  expect(setGpuIdleShutdown).toHaveBeenCalledExactlyOnceWith('1');
  expect(clearGpuIdleShutdown).not.toHaveBeenCalled();
  expect(store.instance('1')?.idle_policy_applied_at).toBeTypeOf('number');
  expect(store.events.list({ instanceId: '1' }).at(-1)?.code).toBe('COMFY_GPU_IDLE_SET');
  await policy.reconcile('1', '22');
  expect(setGpuIdleShutdown).toHaveBeenCalledTimes(1);
  await policy.reconcile('1', '2');
  expect(setGpuIdleShutdown).toHaveBeenCalledTimes(2);
  await new ComfyPowerPolicy(options).reconcile('1', '2');
  expect(setGpuIdleShutdown).toHaveBeenCalledTimes(3);
  expect(clearGpuIdleShutdown).not.toHaveBeenCalled();
});

test('retries a failed fallback setting after backoff without changing task state or cancelling the fallback', async () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
  const { store, policy, setGpuIdleShutdown, clearGpuIdleShutdown } = fixture();
  setGpuIdleShutdown.mockRejectedValueOnce(new AigateError('BUSINESS_REJECTED', 'private provider text', '40301'));
  const before = store.instance('1');
  await expect(policy.reconcile('1', '2')).resolves.toBeUndefined();
  expect(store.instance('1')).toEqual(before);
  expect(store.events.list({ instanceId: '1' }).at(-1)).toMatchObject({ code: 'COMFY_GPU_IDLE_SET_FAILED',
    details: { errorType: 'BUSINESS_REJECTED', upstreamCode: '40301' } });
  await policy.reconcile('1', '2');
  expect(setGpuIdleShutdown).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(Date.now() + 30_000);
  await policy.reconcile('1', '2');
  expect(setGpuIdleShutdown).toHaveBeenCalledTimes(2);
  expect(store.events.list({ instanceId: '1' }).at(-1)?.code).toBe('COMFY_GPU_IDLE_SET');
  expect(clearGpuIdleShutdown).not.toHaveBeenCalled();

  const transient = fixture();
  transient.setGpuIdleShutdown.mockRejectedValueOnce(new AigateError('NETWORK_ERROR', 'private network detail'));
  const original = transient.store.instance('1');
  await expect(transient.policy.reconcile('1', '2')).resolves.toBeUndefined();
  await transient.policy.reconcile('1', '2');
  expect(transient.setGpuIdleShutdown).toHaveBeenCalledTimes(1);
  expect(transient.store.instance('1')).toEqual(original);
  expect(transient.store.events.list({ instanceId: '1' }).at(-1)).toMatchObject({ code: 'COMFY_GPU_IDLE_SET_FAILED',
    details: { errorType: 'NETWORK_ERROR' } });
  clock.mockReturnValue(Date.now() + 30_000);
  await transient.policy.reconcile('1', '2');
  expect(transient.setGpuIdleShutdown).toHaveBeenCalledTimes(2);
  expect(transient.store.events.list({ instanceId: '1' }).at(-1)?.code).toBe('COMFY_GPU_IDLE_SET');
  expect(transient.clearGpuIdleShutdown).not.toHaveBeenCalled();
});
