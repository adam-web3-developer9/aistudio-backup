import type { LookupFunction } from 'node:net';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { proxyAgentMock } = vi.hoisted(() => ({ proxyAgentMock: vi.fn() }));
vi.mock('undici', () => ({
  ProxyAgent: class {
    constructor(options: unknown) {
      proxyAgentMock(options);
    }
  }
}));

import { createMioraProxyAgent } from './miora-proxy.js';

const URI = 'https://example-user:example-password@proxy.example.test:12321';
type AgentOptions = { uri: string; proxyTls: { lookup: LookupFunction }; requestTls?: unknown };
const capturedOptions = () => proxyAgentMock.mock.calls[0]![0] as AgentOptions;

beforeEach(() => proxyAgentMock.mockClear());

describe('Miora proxy gateway address', () => {
  it.each([undefined, '', '   '])('keeps default DNS when the override is %j', (address) => {
    createMioraProxyAgent(URI, address);
    expect(proxyAgentMock).toHaveBeenCalledExactlyOnceWith(URI);
  });

  it.each([
    ['192.0.2.10', 4],
    ['2001:db8::10', 6]
  ] as const)('resolves only the gateway to %s with family %i', (address, family) => {
    createMioraProxyAgent(URI, address);
    const options = capturedOptions();
    expect(options.uri).toBe(URI);
    expect(options).not.toHaveProperty('requestTls');
    expect(Object.keys(options)).toEqual(['uri', 'proxyTls']);
    const callback = vi.fn();
    options.proxyTls.lookup('proxy.example.test', { all: false }, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, address, family);
  });

  it.each([
    ['192.0.2.10', 4],
    ['2001:db8::10', 6]
  ] as const)('supports all-address lookup for %s', (address, family) => {
    createMioraProxyAgent(URI, address);
    const callback = vi.fn();
    capturedOptions().proxyTls.lookup('proxy.example.test', { all: true }, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, [{ address, family }]);
  });

  it('trims an address override while preserving the proxy URI verbatim', () => {
    createMioraProxyAgent(URI, ' 192.0.2.10 ');
    const callback = vi.fn();
    const options = capturedOptions();
    expect(options.uri).toBe(URI);
    options.proxyTls.lookup('proxy.example.test', {}, callback);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, '192.0.2.10', 4);
  });

  it.each(['proxy.example.test', '999.0.0.1', '[2001:db8::10]', 'http://192.0.2.10'])
    ('rejects an invalid IP override %s before creating an agent', (address) => {
      expect(() => createMioraProxyAgent(URI, address))
        .toThrow('Miora proxy address must be a valid IPv4 or IPv6 address');
      expect(proxyAgentMock).not.toHaveBeenCalled();
    });
});
