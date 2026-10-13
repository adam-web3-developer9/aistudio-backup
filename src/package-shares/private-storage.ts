import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac } from 'node:crypto';
import { ACLType, TosClient } from '@volcengine/tos-sdk';
import type { PackageStorage, PackageStoragePart } from './types.js';

export type PackageStorageConfig = {
  accessKeyId: string; accessKeySecret: string; bucket: string; region: string; endpoint: string; ttlSeconds?: number;
};
const fail = (message: string) => Object.assign(new Error(message), { code: 'PACKAGE_STORAGE_INVALID' });
const integer = (value: number, min = 1) => Number.isSafeInteger(value) && value >= min;
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * SDK 2.9.1 presigns host only and offers no public custom-header parameter.
 * Keep its URL/scope/date/key/query generation, then extend the official TOS4
 * canonical request with mandatory content-length/content-md5. This is an
 * explicit signing shim, not a claim that the SDK binds those headers itself.
 * Source: ve-tos-js-sdk signatureV4.ts (TOS4 key derivation/canonical request).
 */
export function bindTosSignedHeaders(value: string, headers: Record<string, string>, secret: string): string {
  const url = new URL(value);
  const algorithm = url.searchParams.get('X-Tos-Algorithm');
  const credential = url.searchParams.get('X-Tos-Credential');
  const date = url.searchParams.get('X-Tos-Date');
  if (algorithm !== 'TOS4-HMAC-SHA256' || !credential || !date) throw fail('TOS 签名结构不兼容');
  const [access, day, region, service, terminal, ...extra] = credential.split('/');
  if (!access || !day || !region || service !== 'tos' || terminal !== 'request' || extra.length) throw fail('TOS 签名范围不兼容');
  const signed: Record<string, string> = { ...headers, host: url.host };
  const names = Object.keys(signed).sort();
  if (names.some(name => !/^[a-z0-9-]+$/.test(name) || /[\r\n]/.test(signed[name] || ''))) throw fail('TOS 签名请求头无效');
  url.searchParams.delete('X-Tos-Signature');
  url.searchParams.set('X-Tos-SignedHeaders', names.join(';'));
  const query = [...url.searchParams].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, value]) => `${encode(name)}=${encode(value)}`).join('&');
  const canonicalHeaders = names.map(name => `${name}:${signed[name]!.trim().replace(/\s+/g, ' ')}`).join('\n');
  const canonical = ['PUT', url.pathname, query, `${canonicalHeaders}\n`, names.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
  const scope = [day, region, service, terminal].join('/');
  let key: Buffer = Buffer.from(secret);
  for (const component of [day, region, service, terminal]) key = createHmac('sha256', key).update(component).digest();
  url.searchParams.set('X-Tos-Signature', createHmac('sha256', key).update([algorithm, date, scope, hash(canonical)].join('\n')).digest('hex'));
  return url.toString();
}

export function createPackageStorage(config: PackageStorageConfig, dependencies: { client?: TosClient; now?: () => number } = {}): PackageStorage {
  const endpoint = new URL(config.endpoint.startsWith('https://') ? config.endpoint : `https://${config.endpoint}`);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port || endpoint.pathname !== '/' || endpoint.search || endpoint.hash
    || !/^tos-(?!s3-)[a-z0-9-]+\.volces\.com$/.test(endpoint.hostname) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket)
    || !/^[a-z0-9-]{2,64}$/.test(config.region) || !config.accessKeyId || !config.accessKeySecret) throw fail('私有 TOS 桶配置无效，需要受控 HTTPS endpoint 和独立服务端凭据');
  const ttl = config.ttlSeconds ?? 300;
  if (!integer(ttl) || ttl > 900) throw fail('草稿包对象授权有效期必须在 1 到 900 秒之间');
  const client = dependencies.client || new TosClient({ ...config, endpoint: endpoint.hostname, secure: true, enableVerifySSL: true, enableCRC: false, requestTimeout: 30000, maxRetryCount: 1 });
  // SDK legacy Axios otherwise reads an HTTP proxy from the environment while
  // using its HTTPS agent, producing ERR_INVALID_PROTOCOL. This is local to
  // this dedicated client, not a change to machine/application proxy settings.
  client.axiosInst.defaults.proxy = false;
  const signals = new AsyncLocalStorage<{ signal?: AbortSignal; cleanups: Set<() => void> }>();
  client.axiosInst.interceptors.request.use(request => {
    const context = signals.getStore(), signal = context?.signal;
    if (signal && context) {
      // The SDK uses legacy Axios without AbortSignal support. Bridge to its
      // supported CancelToken instead of casting an ignored signal property.
      const cancel = TosClient.CancelToken.source();
      const abort = () => cancel.cancel('PACKAGE_STORAGE_CANCELLED');
      request.cancelToken = cancel.token;
      signal.addEventListener('abort', abort, { once: true });
      context.cleanups.add(() => signal.removeEventListener('abort', abort));
      if (signal.aborted) abort();
    }
    return request;
  });
  const now = dependencies.now || Date.now;
  const run = <T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    const context = { signal, cleanups: new Set<() => void>() };
    return signals.run(context, async () => { try { return await work(); } finally { for (const cleanup of context.cleanups) cleanup(); } });
  };
  const key = (value: string) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./-]*\.zip$/.test(value) || Buffer.byteLength(value) > 1024 || value.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw fail('草稿包对象键无效');
    return value;
  };
  const upload = (value: string) => { if (!value || /[\r\n]/.test(value) || value.length > 4096) throw fail('分片上传编号无效'); return value; };
  const signed = (url: string, headers: Record<string, string> = {}) => {
    const address = new URL(url);
    if (address.protocol !== 'https:' || address.hostname !== `${config.bucket}.${endpoint.hostname}` || address.username || address.password || address.port) throw fail('SDK 返回了非受控存储地址');
    return { url, headers, expiresAt: new Date(now() + ttl * 1000).toISOString() };
  };
  return {
    kind: 'private-tos',
    allowedStorageHosts: [`${config.bucket}.${endpoint.hostname}`],
    // Official ve-tos-python-sdk/tos/consts.py: 5 MiB minimum (except
    // last), 5 GiB maximum and 10000 parts. These are provider constraints.
    multipartLimits: { minPartBytes: 5 * 1024 * 1024, maxPartBytes: 5 * 1024 ** 3, maxParts: 10000 },
    async begin(input, signal) {
      if (!integer(input.size) || !/^[a-f0-9]{64}$/.test(input.sha256)) throw fail('草稿包大小或 SHA256 无效');
      const objectKey = key(input.objectKey);
      // Recover the provider-success / local-DB-persist crash gap by exact,
      // server-generated immutable key; never enumerate the whole bucket.
      let keyMarker: string | undefined, uploadIdMarker: string | undefined;
      for (;;) {
        const existing = await run(signal, () => client.listMultipartUploads({ bucket: config.bucket, prefix: objectKey, maxUploads: 1000, keyMarker, uploadIdMarker }));
        const match = existing.data.Uploads?.filter(item => item.Key === objectKey).sort((a, b) => a.Initiated.localeCompare(b.Initiated) || a.UploadId.localeCompare(b.UploadId))[0];
        if (match) return { uploadId: upload(match.UploadId) };
        if (!existing.data.IsTruncated) break;
        if (existing.data.NextKeyMarker === keyMarker && existing.data.NextUploadIdMarker === uploadIdMarker || !existing.data.NextKeyMarker) throw fail('存储初始化恢复分页无效');
        keyMarker = existing.data.NextKeyMarker; uploadIdMarker = existing.data.NextUploadIdMarker;
      }
      const result = await run(signal, () => client.createMultipartUpload({ bucket: config.bucket, key: objectKey, contentType: 'application/zip', acl: ACLType.ACLPrivate,
        forbidOverwrite: true, meta: { sha256: input.sha256, size: String(input.size) } }));
      return { uploadId: upload(result.data.UploadId) };
    },
    async signPart(input, signal) {
      signal?.throwIfAborted();
      if (!integer(input.partNumber) || input.partNumber > 10000 || !integer(input.size) || input.size > 5 * 1024 ** 3 || !/^[A-Za-z0-9+/]{22}==$/.test(input.md5Base64)) throw fail('分片编号、大小或 MD5 无效；TOS 每片最多 5 GiB、最多 10000 片');
      const headers = { 'content-length': String(input.size), 'content-md5': input.md5Base64 };
      const url = client.getPreSignedUrl({ bucket: config.bucket, key: key(input.objectKey), method: 'PUT', expires: ttl,
        query: { uploadId: upload(input.uploadId), partNumber: String(input.partNumber) } });
      return signed(bindTosSignedHeaders(url, headers, config.accessKeySecret), headers);
    },
    async listParts(input, signal) {
      const result: PackageStoragePart[] = []; let marker = 0;
      for (;;) {
        const page = await run(signal, () => client.listParts({ bucket: config.bucket, key: key(input.objectKey), uploadId: upload(input.uploadId), maxParts: 1000, partNumberMarker: marker }));
        for (const part of page.data.Parts || []) result.push({ partNumber: part.PartNumber, etag: part.ETag, size: part.Size });
        if (!page.data.IsTruncated) return result;
        if (!integer(page.data.NextPartNumberMarker) || page.data.NextPartNumberMarker <= marker || result.length > 10000) throw fail('存储分片分页结果无效');
        marker = page.data.NextPartNumberMarker;
      }
    },
    async complete(input, signal) {
      if (!input.parts.length || input.parts.some((part, index) => !integer(part.partNumber) || part.partNumber !== index + 1 || !part.etag || /[\r\n]/.test(part.etag))) throw fail('完成分片列表无效');
      await run(signal, () => client.completeMultipartUpload({ bucket: config.bucket, key: key(input.objectKey), uploadId: upload(input.uploadId), forbidOverwrite: true,
        parts: input.parts.map(part => ({ partNumber: part.partNumber, eTag: part.etag })) }));
    },
    async abort(input, signal) { await run(signal, () => client.abortMultipartUpload({ bucket: config.bucket, key: key(input.objectKey), uploadId: upload(input.uploadId) })); },
    async head(objectKey, signal) {
      try {
        const result = await run(signal, () => client.headObject({ bucket: config.bucket, key: key(objectKey) }));
        const size = Number(result.data['content-length']), sha256 = String(result.data['x-tos-meta-sha256'] || result.headers['x-tos-meta-sha256'] || '');
        if (!integer(size) || !/^[a-f0-9]{64}$/.test(sha256)) throw fail('存储对象大小或 SHA256 元数据无效');
        return { size, metadata: { sha256 } };
      } catch (error) { if ((error as { statusCode?: number }).statusCode === 404) return null; throw error; }
    },
    async signDownload(input, signal) {
      signal?.throwIfAborted();
      const filename = input.filename.replace(/[\r\n"\\/]/g, '_');
      return signed(client.getPreSignedUrl({ bucket: config.bucket, key: key(input.objectKey), method: 'GET', expires: ttl,
        response: { contentType: 'application/zip', contentDisposition: `attachment; filename*=UTF-8''${encode(filename)}` } }));
    }
  };
}

/** Missing configuration disables only package storage; no public/client bucket fallback. */
export function createPackageStorageFromEnv(env: NodeJS.ProcessEnv = process.env): PackageStorage | null {
  const fields = ['PACKAGE_STORAGE_ACCESS_KEY_ID', 'PACKAGE_STORAGE_ACCESS_KEY_SECRET', 'PACKAGE_STORAGE_BUCKET', 'PACKAGE_STORAGE_REGION', 'PACKAGE_STORAGE_ENDPOINT'] as const;
  if (fields.some(field => !env[field]?.trim())) return null;
  return createPackageStorage({ accessKeyId: env.PACKAGE_STORAGE_ACCESS_KEY_ID!.trim(), accessKeySecret: env.PACKAGE_STORAGE_ACCESS_KEY_SECRET!.trim(),
    bucket: env.PACKAGE_STORAGE_BUCKET!.trim(), region: env.PACKAGE_STORAGE_REGION!.trim(), endpoint: env.PACKAGE_STORAGE_ENDPOINT!.trim(),
    ...(env.PACKAGE_STORAGE_TTL_SECONDS ? { ttlSeconds: Number(env.PACKAGE_STORAGE_TTL_SECONDS) } : {}) });
}
