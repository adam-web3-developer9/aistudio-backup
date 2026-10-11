import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { fetchMock, readSystemProxyMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  readSystemProxyMock: vi.fn()
}));

// Replace the wire transport itself: no dispatcher can make a real request.
vi.mock('undici', () => ({
  fetch: fetchMock,
  ProxyAgent: class {
    close = vi.fn().mockResolvedValue(undefined);
    constructor(readonly options: unknown) {}
  }
}));
vi.mock('../adapters/system-proxy.js', () => ({
  createSystemProxyResolver: () => readSystemProxyMock
}));

import { MioraClient } from '../adapters/miora-client.js';
import { useMioraProxy } from '../adapters/miora-api.js';

const input = {
  model: 'minimax-h3', prompt: 'isolated', durationSeconds: 4,
  resolution: '768P', aspectRatio: '16:9'
};

beforeEach(() => {
  fetchMock.mockReset().mockRejectedValue(new Error('Unexpected provider request: network forbidden'));
  readSystemProxyMock.mockReset().mockResolvedValue(undefined);
  useMioraProxy(undefined, '');
});
afterEach(() => {
  useMioraProxy(undefined, '');
  vi.restoreAllMocks();
});

test('checks execution ownership after waiting for automatic proxy discovery', async () => {
  let release!: (value: string | undefined) => void;
  const waiting = new Promise<string | undefined>(resolve => { release = resolve; });
  readSystemProxyMock.mockReturnValue(waiting);
  useMioraProxy(undefined, 'auto');
  let revoked = false;
  const guard = vi.fn(async () => {
    if (revoked) throw new Error('EXECUTION_OWNER_REVOKED');
  });

  const pending = new MioraClient({ authToken: 'isolated-token' }).generateVideo(input, undefined, guard);
  await vi.waitFor(() => expect(readSystemProxyMock).toHaveBeenCalledTimes(1), { timeout: 500 });
  revoked = true;
  const rejected = expect(pending).rejects.toThrow('EXECUTION_OWNER_REVOKED');
  release(undefined);
  await rejected;

  expect(guard).toHaveBeenCalledTimes(1);
  expect(fetchMock).not.toHaveBeenCalled();
});

test('rechecks ownership before trying another outlet after a proven unsent connection failure', async () => {
  useMioraProxy('http://primary.invalid:12321', '');
  let revoked = false;
  const guard = vi.fn(async () => {
    if (revoked) throw new Error('EXECUTION_OWNER_REVOKED');
  });
  fetchMock.mockImplementationOnce(async () => {
    revoked = true;
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('Connection refused before send'), { code: 'ECONNREFUSED' })
    });
  });

  await expect(new MioraClient({ authToken: 'isolated-token' }).generateVideo(input, undefined, guard))
    .rejects.toThrow('EXECUTION_OWNER_REVOKED');

  expect(guard).toHaveBeenCalledTimes(2);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
