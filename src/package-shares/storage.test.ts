import { createHash } from 'node:crypto';
import { StorageClassType, TosClient } from '@volcengine/tos-sdk';
import { describe, expect, it, vi } from 'vitest';
import { bindTosSignedHeaders, createPackageStorage, createPackageStorageFromEnv } from './private-storage.js';

const config = { accessKeyId: 'fixture-key', accessKeySecret: 'fixture-secret', bucket: 'fixture-package-private', region: 'cn-beijing', endpoint: 'tos-cn-beijing.volces.com' };
const key = 'package-shares/share-id/version-id.zip';
const sha = 'a'.repeat(64);
const reply = <T>(data: T) => ({ data, statusCode: 200, headers: {}, requestId: 'fixture', id2: '' });
describe('independent private package storage', () => {
  it('missing configuration has no public fallback and invalid destinations fail explicitly', () => {
    expect(createPackageStorageFromEnv({ TOS_ACCESS_KEY_ID: 'public-key', TOS_ACCESS_KEY_SECRET: 'public-secret' })).toBeNull();
    expect(() => createPackageStorage({ ...config, endpoint: 'https://127.0.0.1' })).toThrow(/配置无效/);
    expect(() => createPackageStorage({ ...config, endpoint: 'http://tos-cn-beijing.volces.com' })).toThrow();
  });
  it('matches the official SDK signer before extension, then binds exact MD5/size/key/part with short TTL', async () => {
    const client = new TosClient({ ...config, secure: true, enableCRC: false });
    const baseline = client.getPreSignedUrl({ key, method: 'PUT', expires: 300, query: { uploadId: 'fixture-upload', partNumber: '2' } });
    expect(new URL(bindTosSignedHeaders(baseline, {}, config.accessKeySecret)).searchParams.get('X-Tos-Signature')).toBe(new URL(baseline).searchParams.get('X-Tos-Signature'));
    const storage = createPackageStorage(config, { client });
    const md5Base64 = createHash('md5').update('fixture part').digest('base64');
    const signed = await storage.signPart({ objectKey: key, uploadId: 'fixture-upload', partNumber: 2, size: 12, md5Base64 });
    const url = new URL(signed.url);
    expect(url.hostname).toBe(storage.allowedStorageHosts?.[0]);
    expect(url.searchParams.get('X-Tos-SignedHeaders')).toBe('content-length;content-md5;host');
    expect(url.searchParams.get('partNumber')).toBe('2');
    expect(url.searchParams.get('uploadId')).toBe('fixture-upload');
    expect(url.searchParams.get('X-Tos-Expires')).toBe('300');
    expect(signed.headers).toEqual({ 'content-length': '12', 'content-md5': md5Base64 });
    expect(bindTosSignedHeaders(signed.url, { ...signed.headers, 'content-length': '13' }, config.accessKeySecret)).not.toBe(signed.url);
    expect(bindTosSignedHeaders(signed.url, { ...signed.headers, 'content-md5': createHash('md5').update('different').digest('base64') }, config.accessKeySecret)).not.toBe(signed.url);
    expect(signed.url).not.toContain(config.accessKeySecret);
    await expect(storage.signPart({ objectKey: '../escape.zip', uploadId: 'fixture-upload', partNumber: 1, size: 1, md5Base64 })).rejects.toThrow(/对象键/);
  });
  it('reuses exact-key interrupted initialization and validates server multipart/head through the SDK without byte relay', async () => {
    const client = new TosClient({ ...config, secure: true, enableCRC: false });
    const listing = vi.spyOn(client, 'listMultipartUploads').mockResolvedValue(reply({ Uploads: [{ Key: `${key}-other`, UploadId: 'other', Initiated: '2026-10-13', StorageClass: StorageClassType.StorageClassStandard }, { Key: key, UploadId: 'recover-owned-upload', Initiated: '2026-10-13', StorageClass: StorageClassType.StorageClassStandard }], CommonPrefixes: [], NextKeyMarker: '', NextUploadIdMarker: '', IsTruncated: false, Bucket: config.bucket }));
    const create = vi.spyOn(client, 'createMultipartUpload').mockResolvedValue(reply({ UploadId: 'fresh-upload', Key: key, Bucket: config.bucket }));
    const parts = vi.spyOn(client, 'listParts').mockResolvedValue(reply({ Parts: [{ PartNumber: 1, ETag: 'fixture-etag', Size: 12, LastModified: '' }], IsTruncated: false, NextPartNumberMarker: 1, PartNumberMarker: 0, MaxParts: 1000, Bucket: config.bucket, Key: key, UploadId: 'recover-owned-upload', StorageClass: 'STANDARD', Owner: { ID: '', DisplayName: '' } }));
    const complete = vi.spyOn(client, 'completeMultipartUpload').mockResolvedValue(reply({ Bucket: config.bucket, Key: key, ETag: 'completed', Location: '' }));
    vi.spyOn(client, 'headObject').mockResolvedValue(reply({ 'content-length': '12', 'last-modified': '', 'content-md5': '', etag: 'completed', 'x-tos-storage-class': StorageClassType.StorageClassStandard, 'x-tos-meta-sha256': sha }));
    const storage = createPackageStorage(config, { client });
    expect(await storage.begin({ objectKey: key, size: 12, sha256: sha, contentType: 'application/zip' })).toEqual({ uploadId: 'recover-owned-upload' });
    expect(listing.mock.calls[0]?.[0]?.prefix).toBe(key); expect(create).not.toHaveBeenCalled();
    expect(await storage.listParts({ objectKey: key, uploadId: 'recover-owned-upload' })).toEqual([{ partNumber: 1, etag: 'fixture-etag', size: 12 }]);
    await storage.complete({ objectKey: key, uploadId: 'recover-owned-upload', parts: [{ partNumber: 1, etag: 'fixture-etag' }] });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({ key, forbidOverwrite: true, parts: [{ partNumber: 1, eTag: 'fixture-etag' }] });
    expect(await storage.head(key)).toEqual({ size: 12, metadata: { sha256: sha } });
    expect(new URL((await storage.signDownload({ objectKey: key, filename: '草稿.zip' })).url).protocol).toBe('https:');
    const cancelled = new AbortController(); cancelled.abort();
    await expect(storage.listParts({ objectKey: key, uploadId: 'recover-owned-upload' }, cancelled.signal)).rejects.toThrow();
    expect(parts).toHaveBeenCalledTimes(1);
  });
  it('cancels an in-flight SDK metadata request through its real legacy Axios CancelToken', async () => {
    let entered = false;
    const client = new TosClient({ ...config, secure: true, enableCRC: false });
    // 2.9.1 normalizeOpts overwrites the constructor requestAdapter; inject on
    // the actual instance so this metadata test cannot contact any bucket.
    client.opts.requestAdapter = request => new Promise((_resolve, reject) => {
      entered = true; expect(request.cancelToken).toBeDefined();
      request.cancelToken!.promise.then(reject);
    });
    const storage = createPackageStorage(config, { client });
    const controller = new AbortController();
    const pending = storage.head(key, controller.signal);
    const rejected = expect(pending).rejects.toThrow(/PACKAGE_STORAGE_CANCELLED/);
    await new Promise(resolve => setImmediate(resolve)); expect(entered).toBe(true);
    controller.abort(); await rejected;
  });
});
