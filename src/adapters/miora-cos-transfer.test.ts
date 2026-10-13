import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { fetch } from 'undici';
import { transferPublicMediaToMioraCos } from './miora-cos-transfer.js';
import type { MioraClient } from './miora-client.js';

vi.mock('undici', async importOriginal => ({
  ...await importOriginal<typeof import('undici')>(), fetch: vi.fn()
}));

test('Miora cloud transfer streams original chunks and refuses excess bytes or a mismatched content hash', async () => {
  const chunks = [Buffer.from('abc'), Buffer.from('def')];
  const hash = createHash('sha256');
  for (const chunk of chunks) hash.update(chunk);
  const expectedSha = hash.digest('hex');
  const uploadedChunks: Uint8Array[] = [];
  const client = { getCosGrant: vi.fn(async () => ({
    prefix: 'test-prefix', bucket: 'test-bucket', region: 'ap-test', token: 'test-token', secret_id: 'test-id', secret_key: 'test-secret'
  })) } as unknown as MioraClient;
  let declaredSize = 6;
  vi.mocked(fetch).mockImplementation(async (address, options) => {
    if (String(address).startsWith('https://source.invalid/')) {
      return { ok: true, status: 200, headers: new Headers({ 'content-length': String(declaredSize) }),
        body: (async function* () { yield* chunks; })()
      } as unknown as Awaited<ReturnType<typeof fetch>>;
    }
    // The mocked COS endpoint consumes the production counted iterator, just as HTTP would.
    for await (const chunk of options!.body as AsyncIterable<Uint8Array>) uploadedChunks.push(chunk);
    return { status: 200 } as Awaited<ReturnType<typeof fetch>>;
  });
  const input = { client, sourceUrl: 'https://source.invalid/reference.mp4', allowedHosts: ['source.invalid'],
    fileName: 'reference.mp4', mimeType: 'video/mp4', size: 6, sha256: expectedSha };
  try {
    expect(await transferPublicMediaToMioraCos(input)).toBe('test-prefix/reference.mp4');
    expect(uploadedChunks).toHaveLength(2);
    expect(uploadedChunks.map(chunk => Buffer.from(chunk).toString())).toEqual(['abc', 'def']);
    uploadedChunks.length = 0;
    declaredSize = 5;
    await expect(transferPublicMediaToMioraCos({ ...input, size: 5 })).rejects.toThrow('exceeded its declared size');
    expect(uploadedChunks.map(chunk => Buffer.from(chunk).toString())).toEqual(['abc']);
    uploadedChunks.length = 0;
    declaredSize = 6;
    await expect(transferPublicMediaToMioraCos({ ...input, sha256: '0'.repeat(64) })).rejects.toThrow('content hash changed');
  } finally { vi.restoreAllMocks(); }
});
