import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { createSystemProxyResolver, parseWindowsSystemProxy, readWindowsSystemProxy } from './system-proxy.js';

const registry = (server: string, enabled = '0x1') => `
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    ${enabled}
    ProxyServer    REG_SZ    ${server}
    AutoConfigURL    REG_SZ    https://example.test/proxy.pac
`;

describe('Windows system proxy parser', () => {
  it.each([
    ['127.0.0.1:7897', 'http://127.0.0.1:7897'],
    ['localhost:8080', 'http://localhost:8080'],
    ['http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892', 'http://127.0.0.1:7891'],
    ['http=127.0.0.1:7890;socks=127.0.0.1:7892', 'http://127.0.0.1:7890'],
    ['HTTPS = [::1]:7891;http=localhost:7890', 'http://[::1]:7891'],
    ['http://127.0.0.1:7897', 'http://127.0.0.1:7897'],
    ['socks=127.0.0.1:7892;localhost:8080', 'http://localhost:8080'],
    ['https=invalid;http=localhost:7890', 'http://localhost:7890']
  ])('reads %s', (server, expected) => {
    expect(parseWindowsSystemProxy(registry(server))).toBe(expected);
  });

  it.each(['0x0', '0x2', 'invalid'])('ignores disabled or invalid ProxyEnable %s', (enabled) => {
    expect(parseWindowsSystemProxy(registry('localhost:7890', enabled))).toBeUndefined();
  });

  it('accepts decimal enable values', () => {
    expect(parseWindowsSystemProxy(registry('localhost:7890', '1'))).toBe('http://localhost:7890');
  });

  it.each([
    '', 'socks=127.0.0.1:7892', 'socks5://127.0.0.1:7892',
    'localhost', 'localhost:0', 'localhost:65536', 'localhost:abc',
    'localhost:7890/path', 'user:password@localhost:7890', '999.0.0.1:7890',
    '[invalid]:7890', '::1:7890', '-bad.test:7890', 'bad..test:7890',
    'https://localhost:7890', '%PROXY_HOST%:7890'
  ])('ignores an unsupported or malformed proxy %s', (server) => {
    expect(parseWindowsSystemProxy(registry(server))).toBeUndefined();
  });

  it('ignores missing settings and PAC-only configurations', () => {
    expect(parseWindowsSystemProxy('')).toBeUndefined();
    expect(parseWindowsSystemProxy('    ProxyServer    REG_SZ    localhost:7890')).toBeUndefined();
    expect(parseWindowsSystemProxy('    ProxyEnable    REG_DWORD    0x1\n    AutoConfigURL    REG_SZ    https://example.test/proxy.pac')).toBeUndefined();
  });
});

describe('Windows system proxy reader', () => {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  beforeEach(() => {
    execFileMock.mockReset();
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  });
  afterEach(() => Object.defineProperty(process, 'platform', platformDescriptor));

  it('uses a bounded hidden registry query without a shell', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, registry('localhost:7890'));
    });
    await expect(readWindowsSystemProxy()).resolves.toBe('http://localhost:7890');
    expect(execFileMock).toHaveBeenCalledWith('reg.exe', [
      'query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
    ], { encoding: 'utf8', shell: false, windowsHide: true, timeout: 1500, maxBuffer: 65536 }, expect.any(Function));
  });

  it('returns undefined if the registry query fails', async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(new Error('query timed out'), '');
    });
    await expect(readWindowsSystemProxy()).resolves.toBeUndefined();
  });

  it('does not query the registry on other platforms', async () => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'linux' });
    await expect(readWindowsSystemProxy()).resolves.toBeUndefined();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('system proxy resolver cache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
  });
  afterEach(() => vi.useRealTimers());

  it('caches a configured proxy for two seconds by default', async () => {
    const read = vi.fn().mockResolvedValue('http://localhost:7890');
    const resolve = createSystemProxyResolver(read);
    expect(await resolve()).toBe('http://localhost:7890');
    vi.setSystemTime(2999);
    expect(await resolve()).toBe('http://localhost:7890');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent reads and starts the TTL when reading completes', async () => {
    let complete!: (proxy: string | undefined) => void;
    const read = vi.fn(() => new Promise<string | undefined>((resolve) => { complete = resolve; }));
    const resolve = createSystemProxyResolver(read);
    const first = resolve();
    const second = resolve();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(5000);
    complete('http://localhost:7890');
    await expect(first).resolves.toBe('http://localhost:7890');
    vi.setSystemTime(6999);
    expect(await resolve()).toBe('http://localhost:7890');
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('rereads after expiry to follow the newly selected proxy port', async () => {
    const read = vi.fn().mockResolvedValueOnce('http://localhost:7890').mockResolvedValueOnce('http://localhost:7897');
    const resolve = createSystemProxyResolver(read, 500);
    expect(await resolve()).toBe('http://localhost:7890');
    vi.setSystemTime(1500);
    expect(await resolve()).toBe('http://localhost:7897');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('caches disabled settings and discovers a proxy after expiry', async () => {
    const read = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('http://localhost:7897');
    const resolve = createSystemProxyResolver(read);
    expect(await resolve()).toBeUndefined();
    vi.setSystemTime(2999);
    expect(await resolve()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    vi.setSystemTime(3000);
    expect(await resolve()).toBe('http://localhost:7897');
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('drops a previously configured proxy when system proxy is disabled', async () => {
    const read = vi.fn().mockResolvedValueOnce('http://localhost:7890').mockResolvedValueOnce(undefined);
    const resolve = createSystemProxyResolver(read);
    expect(await resolve()).toBe('http://localhost:7890');
    vi.setSystemTime(3000);
    expect(await resolve()).toBeUndefined();
    vi.setSystemTime(4000);
    expect(await resolve()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('releases a failed in-flight read so the next call can retry', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('failed')).mockResolvedValueOnce('http://localhost:7890');
    const resolve = createSystemProxyResolver(read);
    await expect(resolve()).rejects.toThrow('failed');
    expect(await resolve()).toBe('http://localhost:7890');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
