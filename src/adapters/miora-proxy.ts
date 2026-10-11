import { isIP, type LookupFunction } from 'node:net';
import { ProxyAgent } from 'undici';

/** Override the proxy gateway's DNS address without changing its URI or the target's DNS. */
export function createMioraProxyAgent(proxyUrl: string, proxyAddress?: string): ProxyAgent {
  const address = proxyAddress?.trim();
  if (!address) return new ProxyAgent(proxyUrl);

  const family = isIP(address);
  if (!family) {
    throw new Error('Miora proxy address must be a valid IPv4 or IPv6 address');
  }

  const lookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };

  // Keep the original proxy hostname for authentication, TLS verification and SNI.
  // proxyTls is the connection to the gateway; requestTls belongs to the target.
  return new ProxyAgent({ uri: proxyUrl, proxyTls: { lookup } });
}
