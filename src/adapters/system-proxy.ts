import { execFile } from 'node:child_process';
import { isIP } from 'node:net';

const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function normalizeHttpProxy(value: string): string | undefined {
  const endpoint = value.trim().replace(/^http:\/\//i, '');
  const match = /^(\[[^\]]+\]|[a-z\d.-]+):(\d+)$/i.exec(endpoint);
  if (!match) return undefined;

  const host = match[1]!;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;

  if (host.startsWith('[')) {
    if (isIP(host.slice(1, -1)) !== 6) return undefined;
  } else if (!isIP(host)) {
    // Reject malformed numeric IPs and invalid DNS labels before building an agent.
    if (/^[\d.]+$/.test(host) || host.length > 253) return undefined;
    const labels = host.replace(/\.$/, '').split('.');
    if (labels.some((label) => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
      return undefined;
    }
  }

  return `http://${host.toLowerCase()}:${port}`;
}

/** Parse only an enabled, explicit Windows HTTP proxy; PAC and SOCKS are not supported. */
export function parseWindowsSystemProxy(registryOutput: string): string | undefined {
  const enabled = /^\s*ProxyEnable\s+REG_DWORD\s+(0x[\da-f]+|\d+)\s*$/im.exec(registryOutput)?.[1];
  if (!enabled || Number(enabled) !== 1) return undefined;
  const server = /^\s*ProxyServer\s+REG_SZ\s+([^\r\n]+)$/im.exec(registryOutput)?.[1]?.trim();
  if (!server) return undefined;

  const byProtocol = new Map<string, string>();
  const defaults: string[] = [];
  for (const entry of server.split(';')) {
    const trimmed = entry.trim();
    const separator = trimmed.indexOf('=');
    if (separator < 0) defaults.push(trimmed);
    else byProtocol.set(trimmed.slice(0, separator).trim().toLowerCase(), trimmed.slice(separator + 1));
  }

  // The "https=" key selects HTTPS destinations; the proxy itself still speaks HTTP.
  for (const candidate of [byProtocol.get('https'), byProtocol.get('http'), ...defaults]) {
    if (candidate) {
      const proxy = normalizeHttpProxy(candidate);
      if (proxy) return proxy;
    }
  }
  return undefined;
}

/** Read the current user's settings without modifying Windows or launching a shell. */
export async function readWindowsSystemProxy(): Promise<string | undefined> {
  if (process.platform !== 'win32') return undefined;

  return new Promise((resolve) => {
    execFile('reg.exe', ['query', INTERNET_SETTINGS], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: 1500,
      maxBuffer: 64 * 1024
    }, (error, stdout) => {
      resolve(error ? undefined : parseWindowsSystemProxy(stdout));
    });
  });
}

/** Coalesce registry reads and briefly cache both configured and disabled proxy states. */
export function createSystemProxyResolver(
  read: () => Promise<string | undefined> = readWindowsSystemProxy,
  ttlMs = 2000
): () => Promise<string | undefined> {
  let cached: string | undefined;
  let expiresAt = 0;
  let pending: Promise<string | undefined> | undefined;

  return () => {
    if (pending) return pending;
    if (Date.now() < expiresAt) return Promise.resolve(cached);

    pending = Promise.resolve().then(read).then((proxy) => {
      cached = proxy;
      expiresAt = Date.now() + ttlMs;
      return proxy;
    }).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
