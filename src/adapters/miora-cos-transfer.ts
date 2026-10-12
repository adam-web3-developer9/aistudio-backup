import { fetch } from 'undici';
import { createHash } from 'node:crypto';
import { prepareCosUpload } from './miora-api.js';
import type { MioraClient } from './miora-client.js';

function allowedHost(host: string, allow: readonly string[]): boolean {
  return allow.some(entry => host === entry || entry.startsWith('.') && host.endsWith(entry));
}

function safeSource(value: string, allow: readonly string[]): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHost(url.hostname, allow)) {
    throw new Error(`Public media host is not allowed: ${url.hostname || 'invalid'}`);
  }
  return url;
}

export async function transferPublicMediaToMioraCos(input: {
  client: MioraClient;
  sourceUrl: string;
  allowedHosts: readonly string[];
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  signal?: AbortSignal;
}): Promise<string> {
  let source = safeSource(input.sourceUrl, input.allowedHosts);
  let response;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    response = await fetch(source, { redirect: 'manual', signal: input.signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirects === 3) throw new Error('Public media redirected too many times');
    source = safeSource(new URL(location, source).toString(), input.allowedHosts);
  }
  if (!response || !response.ok || !response.body) throw new Error(`Public media fetch failed: HTTP ${response?.status ?? 0}`);
  const declared = Number(response.headers.get('content-length') || input.size);
  if (declared !== input.size) throw new Error(`Public media size changed: expected ${input.size}, received ${declared}`);
  const grant = await input.client.getCosGrant(input.signal);
  const upload = prepareCosUpload(grant, input.fileName, input.mimeType, input.size);
  let received = 0;
  const digest = createHash('sha256');
  const counted = (async function* () {
    for await (const chunk of response.body!) {
      const bytes = Buffer.from(chunk);
      received += bytes.length;
      digest.update(bytes);
      if (received > input.size) throw new Error('Public media exceeded its declared size');
      yield bytes;
    }
    if (received !== input.size) throw new Error(`Public media ended early: expected ${input.size}, received ${received}`);
    const actualSha = digest.digest('hex');
    if (actualSha !== input.sha256.toLowerCase()) throw new Error('Public media content hash changed');
  })();
  const uploaded = await fetch(upload.url, {
    method: 'PUT', headers: upload.headers, body: counted, signal: input.signal, duplex: 'half'
  });
  if (uploaded.status !== 200) throw new Error(`COS PUT ${upload.key} failed: HTTP ${uploaded.status}`);
  return upload.key;
}
