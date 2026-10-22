import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import { TosClient } from '@volcengine/tos-sdk';
import * as tosSdk from '@volcengine/tos-sdk';
import { describe, expect, it, vi } from 'vitest';
import { TosResultStorage, type ArchiveFile, type ResultArchiveStorage } from './tos-result-storage.js';

const options = {
  bucket: 'public-results',
  region: 'cn-beijing',
  endpoint: 'https://tos-cn-beijing.volces.com',
  accessKeyId: 'test-access-key',
  accessKeySecret: 'test-secret-key',
  keyPrefix: '/archive/results/',
};
const bytes = Buffer.from('offline video fixture');
const file: ArchiveFile = {
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
  md5: createHash('md5').update(bytes).digest('base64'),
};
const lastModified = 'Thu, 22 Oct 2026 01:02:03 GMT';
const etag = `"${Buffer.from(file.md5, 'base64').toString('hex')}"`;

function fixture() {
  const data = {
    'content-length': String(file.size),
    'last-modified': lastModified,
    'content-md5': file.md5,
    'x-tos-meta-sha256': file.sha256,
    'x-tos-storage-class': TosClient.StorageClassType.StorageClassStandard,
    etag,
  } satisfies Awaited<ReturnType<TosClient['headObject']>>['data'];
  const response = { data, statusCode: 200, headers: {}, requestId: 'request', id2: 'id2' };
  const client = {
    getPreSignedUrl: vi.fn<TosClient['getPreSignedUrl']>().mockReturnValue('https://signed.example.test/object'),
    headObject: vi.fn<TosClient['headObject']>().mockResolvedValue(response),
    deleteObject: vi.fn<TosClient['deleteObject']>().mockResolvedValue({
      ...response, data: { 'x-tos-delete-marker': 'false', 'x-tos-version-id': '' },
    }),
  };
  const storage: ResultArchiveStorage = new TosResultStorage(options, client);
  return { client, storage, response };
}

describe('TosResultStorage', () => {
  it('returns public-read MP4 PUT headers and a 900-second target without exposing the client', () => {
    const { storage, client } = fixture();
    const target = storage.uploadTarget('job/video.mp4', file);
    expect(target).toEqual({ url: 'https://signed.example.test/object', headers: {
      'Content-MD5': file.md5, 'Content-Type': 'video/mp4', 'x-tos-meta-sha256': file.sha256, 'x-tos-acl': 'public-read',
    } });
    expect(client.getPreSignedUrl).toHaveBeenCalledWith({
      bucket: options.bucket, key: 'archive/results/job/video.mp4', method: 'PUT', expires: 900,
    });
    for (const value of [JSON.stringify(storage), inspect(storage), JSON.stringify(target.headers)]) {
      expect(value).not.toContain(options.accessKeyId);
      expect(value).not.toContain(options.accessKeySecret);
    }
  });

  it.each([
    'http://tos-cn-beijing.volces.com', 'tos-cn-beijing.volces.com', 'https://localhost',
    'https://tos-cn-beijing.volces.com.evil.test', 'https://tos-cn-shanghai.volces.com',
    'https://tos-cn-beijing.volces.com/path', 'https://tos-cn-beijing.volces.com?secret=x',
    'https://tos-cn-beijing.volces.com#fragment', 'https://user:secret@tos-cn-beijing.volces.com',
    'https://tos-cn-beijing.volces.com:8443', 'https://tos-s3-cn-beijing.volces.com',
    'https://tos.cn-beijing.volces.com',
  ])('rejects unsafe or non-standard endpoint %s', endpoint => {
    const { client } = fixture();
    expect(() => new TosResultStorage({ ...options, endpoint }, client)).toThrow('TOS_ARCHIVE_INVALID_ENDPOINT');
  });

  it.each([{ bucket: 'bad/bucket' }, { accessKeyId: '' }, { accessKeySecret: ' ' }])('validates configuration (%j)', patch => {
    const { client } = fixture();
    expect(() => new TosResultStorage({ ...options, ...patch }, client)).toThrow('TOS_ARCHIVE_INVALID_CONFIG');
  });

  it.each(['', '/absolute', '../escape', 'nested/../escape', 'nested/./file', 'double//slash', 'bad\\key', 'bad\nkey', '字'.repeat(400)])('rejects unsafe key (%#)', async key => {
    const { storage, client } = fixture();
    expect(() => storage.uploadTarget(key, file)).toThrow('TOS_ARCHIVE_INVALID_KEY');
    expect(() => storage.downloadUrl(key, 60)).toThrow('TOS_ARCHIVE_INVALID_KEY');
    await expect(storage.head(key)).rejects.toThrow('TOS_ARCHIVE_INVALID_KEY');
    await expect(storage.delete(key)).rejects.toThrow('TOS_ARCHIVE_INVALID_KEY');
    expect(client.getPreSignedUrl).not.toHaveBeenCalled();
    expect(client.headObject).not.toHaveBeenCalled();
    expect(client.deleteObject).not.toHaveBeenCalled();
  });

  it('rejects an unsafe prefix and supports an omitted prefix', () => {
    const { client } = fixture();
    expect(() => new TosResultStorage({ ...options, keyPrefix: '../escape' }, client)).toThrow('TOS_ARCHIVE_INVALID_KEY');
    expect(new TosResultStorage({ ...options, keyPrefix: undefined }, client).downloadUrl('video.mp4', 60))
      .toBe('https://public-results.tos-cn-beijing.volces.com/video.mp4');
    expect(client.getPreSignedUrl).not.toHaveBeenCalled();
  });

  it.each([
    { size: -1 }, { size: 1.5 }, { size: NaN }, { size: Number.MAX_SAFE_INTEGER + 1 },
    { sha256: 'invalid' }, { sha256: file.sha256 + '\n' }, { md5: '0'.repeat(32) },
    { md5: 'AAAAAAAAAAAAAAAAAAAAAB==' }, { md5: file.md5 + '\n' },
  ])('rejects invalid file metadata (%j)', patch => {
    const { storage, client } = fixture();
    expect(() => storage.uploadTarget('video.mp4', { ...file, ...patch })).toThrow('TOS_ARCHIVE_INVALID_FILE');
    expect(client.getPreSignedUrl).not.toHaveBeenCalled();
  });

  it('reads actual SDK header-shaped data and last-modified time', async () => {
    const { storage, client } = fixture();
    await expect(storage.head('video.mp4')).resolves.toEqual({ ...file, uploadedAt: Date.parse(lastModified) });
    expect(client.headObject).toHaveBeenCalledWith({ bucket: options.bucket, key: 'archive/results/video.mp4' });
  });

  it.each([etag, etag.slice(1, -1), etag.toUpperCase()])('converts single-PUT ETag to base64 when Content-MD5 is absent (%s)', async value => {
    const { storage, client, response } = fixture();
    client.headObject.mockResolvedValue({ ...response, data: { ...response.data, 'content-md5': undefined, etag: value } } as unknown as Awaited<ReturnType<TosClient['headObject']>>);
    await expect(storage.head('video.mp4')).resolves.toMatchObject({ md5: file.md5 });
  });

  it.each([
    { 'content-length': '' }, { 'content-length': '1.5' }, { 'content-length': '-1' },
    { 'content-length': '9007199254740992' }, { 'content-length': ' 12' }, { 'content-length': '12\n' },
    { 'x-tos-meta-sha256': undefined }, { 'x-tos-meta-sha256': {} }, { 'x-tos-meta-sha256': 'invalid' },
    { 'x-tos-meta-sha256': file.sha256 + '\n' }, { etag: etag + '\n' },
    { 'last-modified': '' }, { 'last-modified': 'not-a-date' },
    { etag: '"' + 'a'.repeat(32) + '-2"' }, { etag: 'W/' + etag }, { etag: 'invalid' },
    { 'content-md5': 'AAAAAAAAAAAAAAAAAAAAAA==' }, { 'content-md5': 'invalid' },
    { 'content-md5': undefined, etag: undefined },
  ])('rejects unverifiable or mismatched HEAD metadata (%j)', async patch => {
    const { storage, client, response } = fixture();
    client.headObject.mockResolvedValue({ ...response, data: { ...response.data, ...patch } } as Awaited<ReturnType<TosClient['headObject']>>);
    await expect(storage.head('video.mp4')).rejects.toMatchObject({ code: 'TOS_ARCHIVE_INVALID_OBJECT' });
  });

  it('uses Content-MD5 alone when ETag is absent', async () => {
    const { storage, client, response } = fixture();
    client.headObject.mockResolvedValue({ ...response, data: { ...response.data, etag: undefined } } as unknown as Awaited<ReturnType<TosClient['headObject']>>);
    await expect(storage.head('video.mp4')).resolves.toMatchObject({ md5: file.md5 });
  });

  it('returns null only for HTTP 404', async () => {
    const { storage, client, response } = fixture();
    client.headObject.mockRejectedValue({ statusCode: 404 });
    await expect(storage.head('missing.mp4')).resolves.toBeNull();
    client.headObject.mockResolvedValue({ ...response, statusCode: 404 });
    await expect(storage.head('missing.mp4')).resolves.toBeNull();
    client.headObject.mockRejectedValue({ code: 'NoSuchKey', statusCode: 403 });
    await expect(storage.head('missing.mp4')).rejects.toMatchObject({ code: 'TOS_ARCHIVE_HEAD_FAILED' });
    client.headObject.mockResolvedValue({ ...response, statusCode: 503 });
    await expect(storage.head('video.mp4')).rejects.toThrow('TOS_ARCHIVE_HEAD_FAILED');
  });

  it.each([1, 60, 900, 3600, 86400])('returns the same anonymous public URL regardless of valid TTL %s', requested => {
    const { storage, client } = fixture();
    expect(storage.downloadUrl('video.mp4', requested))
      .toBe('https://public-results.tos-cn-beijing.volces.com/archive/results/video.mp4');
    expect(client.getPreSignedUrl).not.toHaveBeenCalled();
  });

  it('encodes object key segments once without leaking query, fragment or credentials', () => {
    const { storage, client } = fixture();
    const key = "job/视频 +%2F?#&=!'()*.mp4";
    const url = new URL(storage.downloadUrl(key, 60));
    expect(url.href).toBe('https://public-results.tos-cn-beijing.volces.com/archive/results/job/%E8%A7%86%E9%A2%91%20%2B%252F%3F%23%26%3D%21%27%28%29%2A.mp4');
    expect(decodeURIComponent(url.pathname)).toBe('/archive/results/' + key);
    expect([url.search, url.hash, url.username, url.password]).toEqual(['', '', '', '']);
    expect(url.href).not.toContain(options.accessKeyId);
    expect(url.href).not.toContain(options.accessKeySecret);
    expect(client.getPreSignedUrl).not.toHaveBeenCalled();
    const prefixed = new TosResultStorage({ ...options, keyPrefix: '公有/space +%?#' }, client);
    expect(decodeURIComponent(new URL(prefixed.downloadUrl(key, 60)).pathname)).toBe('/公有/space +%?#/' + key);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid download TTL %s', ttl => {
    const { storage, client } = fixture();
    expect(() => storage.downloadUrl('video.mp4', ttl)).toThrow('TOS_ARCHIVE_INVALID_TTL');
    expect(client.getPreSignedUrl).not.toHaveBeenCalled();
  });

  it('deletes the prefixed object using the SDK', async () => {
    const { storage, client } = fixture();
    await expect(storage.delete('video.mp4')).resolves.toBeUndefined();
    expect(client.deleteObject).toHaveBeenCalledWith({ bucket: options.bucket, key: 'archive/results/video.mp4' });
  });

  it('replaces SDK errors with fixed safe codes without retaining causes or credentials', async () => {
    const { storage, client } = fixture();
    const secret = `https://host/?signature=secret ${options.accessKeyId} ${options.accessKeySecret}`;
    const unsafe = Object.assign(new Error(secret), { statusCode: 403, code: secret, config: { url: secret } });
    client.getPreSignedUrl.mockImplementation(() => { throw unsafe; });
    client.headObject.mockRejectedValue(unsafe);
    client.deleteObject.mockRejectedValue(unsafe);
    expect(storage.downloadUrl('video.mp4', 60))
      .toBe('https://public-results.tos-cn-beijing.volces.com/archive/results/video.mp4');
    const operations = [
      [() => storage.uploadTarget('video.mp4', file), 'TOS_ARCHIVE_UPLOAD_SIGN_FAILED'],
      [() => storage.head('video.mp4'), 'TOS_ARCHIVE_HEAD_FAILED'],
      [() => storage.delete('video.mp4'), 'TOS_ARCHIVE_DELETE_FAILED'],
    ] as const;
    for (const [operation, code] of operations) {
      const error = await Promise.resolve().then<unknown>(() => operation()).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ message: code, code });
      expect(error).not.toHaveProperty('cause');
      expect(inspect(error)).not.toContain('signature=secret');
      expect(inspect(error)).not.toContain(options.accessKeyId);
      expect(inspect(error)).not.toContain(options.accessKeySecret);
    }
  });

  it('creates real SDK signatures offline without exporting the secret key', () => {
    const storage = new TosResultStorage({ ...options, endpoint: options.endpoint + '/' });
    const target = storage.uploadTarget('job/视频 +.mp4', file);
    const url = new URL(target.url);
    expect(url.origin).toBe('https://public-results.tos-cn-beijing.volces.com');
    const defaultClient = new TosClient({
      bucket: options.bucket, region: options.region,
      accessKeyId: options.accessKeyId, accessKeySecret: options.accessKeySecret,
    });
    expect(url.origin).toBe(new URL(defaultClient.getPreSignedUrl({ key: 'video.mp4' })).origin);
    expect(decodeURIComponent(url.pathname)).toBe('/archive/results/job/视频 +.mp4');
    expect(url.searchParams.get('X-Tos-Expires')).toBe('900');
    expect(url.searchParams.get('X-Tos-Credential')).toContain(options.accessKeyId + '/');
    expect(url.searchParams.get('X-Tos-Signature')).toMatch(/^[a-f0-9]{64}$/);
    expect(target.url).not.toContain(options.accessKeySecret);
    const download = new URL(storage.downloadUrl('job/视频 +.mp4', 9999));
    expect(download.origin).toBe(url.origin);
    expect(download.pathname).toBe(url.pathname);
    expect(download.search).toBe('');
    expect(target.headers['x-tos-acl']).toBe('public-read');
    expect(url.searchParams.get('X-Tos-SignedHeaders')).toBe('host');
  });

  it('configures bounded SDK requests without retries or CRC and preserves already-prefixed keys', () => {
    const OriginalClient = TosClient;
    const construct = vi.spyOn(tosSdk, 'TosClient').mockImplementation(function (configuration) {
      return new OriginalClient(configuration);
    });
    try {
      const storage = new TosResultStorage({ ...options, keyPrefix: undefined });
      const key = 'archive/results/job/video.mp4';
      expect(new URL(storage.uploadTarget(key, file).url).pathname).toBe('/' + key);
      expect(new URL(storage.downloadUrl(key, 60)).pathname).toBe('/' + key);
      expect(construct).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        endpoint: 'tos-cn-beijing.volces.com', secure: true, enableVerifySSL: true,
        requestTimeout: 30_000, connectionTimeout: 10_000, maxRetryCount: 0, enableCRC: false,
      }));
    } finally {
      construct.mockRestore();
    }
  });
});
