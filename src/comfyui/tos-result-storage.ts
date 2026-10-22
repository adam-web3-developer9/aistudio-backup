import { TosClient } from '@volcengine/tos-sdk';

export interface ArchiveFile {
  size: number;
  sha256: string;
  md5: string;
}

export interface ArchiveObject extends ArchiveFile {
  uploadedAt: number;
}

export interface ResultArchiveStorage {
  uploadTarget(key: string, file: ArchiveFile): { url: string; headers: Record<string, string> };
  head(key: string): Promise<ArchiveObject | null>;
  downloadUrl(key: string, expiresSeconds: number): string;
  delete(key: string): Promise<void>;
}

export interface TosResultStorageOptions {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  keyPrefix?: string;
}

type ArchiveClient = {
  [Method in 'getPreSignedUrl' | 'headObject' | 'deleteObject']: OmitThisParameter<TosClient[Method]>;
};

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function validMd5(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(value)
    && Buffer.from(value, 'base64').toString('base64') === value;
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && value.length === 64 && /^[a-fA-F0-9]+$/.test(value);
}

function validKey(value: string): boolean {
  return value.length > 0 && !/[\\\u0000-\u001f\u007f]/.test(value)
    && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export class TosResultStorage implements ResultArchiveStorage {
  readonly #client: ArchiveClient;
  readonly #bucket: string;
  readonly #publicOrigin: string;
  readonly #prefix: string;

  constructor(options: TosResultStorageOptions, client?: ArchiveClient) {
    const { bucket, region, endpoint, accessKeyId, accessKeySecret } = options;
    if (!/^[a-z]{2}(?:-[a-z0-9]+)+$/.test(region)
      || ![`https://tos-${region}.volces.com`, `https://tos-${region}.volces.com/`].includes(endpoint)) {
      throw failure('TOS_ARCHIVE_INVALID_ENDPOINT');
    }
    if (bucket.trim() !== bucket || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
      || !accessKeyId.trim() || !accessKeySecret.trim()) {
      throw failure('TOS_ARCHIVE_INVALID_CONFIG');
    }
    const prefix = (options.keyPrefix ?? '').replace(/^\/+|\/+$/g, '');
    if (prefix && !validKey(prefix)) throw failure('TOS_ARCHIVE_INVALID_KEY');
    this.#bucket = bucket;
    this.#publicOrigin = `https://${bucket}.tos-${region}.volces.com`;
    this.#prefix = prefix;
    try {
      this.#client = client ?? new TosClient({
        bucket, region, endpoint: `tos-${region}.volces.com`, accessKeyId, accessKeySecret,
        secure: true, enableVerifySSL: true, requestTimeout: 30_000, connectionTimeout: 10_000,
        maxRetryCount: 0, enableCRC: false,
      });
    } catch {
      throw failure('TOS_ARCHIVE_INIT_FAILED');
    }
  }

  private objectKey(key: string): string {
    if (!validKey(key)) throw failure('TOS_ARCHIVE_INVALID_KEY');
    const result = this.#prefix ? `${this.#prefix}/${key}` : key;
    if (Buffer.byteLength(result, 'utf8') > 1024) throw failure('TOS_ARCHIVE_INVALID_KEY');
    return result;
  }

  uploadTarget(key: string, file: ArchiveFile): { url: string; headers: Record<string, string> } {
    const objectKey = this.objectKey(key);
    if (!Number.isSafeInteger(file.size) || file.size < 0
      || !validSha256(file.sha256) || !validMd5(file.md5)) {
      throw failure('TOS_ARCHIVE_INVALID_FILE');
    }
    const headers = {
      'Content-MD5': file.md5,
      'Content-Type': 'video/mp4',
      'x-tos-meta-sha256': file.sha256.toLowerCase(),
      'x-tos-acl': 'public-read',
    };
    try {
      const url = this.#client.getPreSignedUrl({ bucket: this.#bucket, key: objectKey, method: 'PUT', expires: 900 });
      return { url, headers };
    } catch {
      throw failure('TOS_ARCHIVE_UPLOAD_SIGN_FAILED');
    }
  }

  async head(key: string): Promise<ArchiveObject | null> {
    const objectKey = this.objectKey(key);
    let data: Awaited<ReturnType<ArchiveClient['headObject']>>['data'];
    try {
      const response = await this.#client.headObject({ bucket: this.#bucket, key: objectKey });
      if (response.statusCode === 404) return null;
      if (response.statusCode !== 200) throw failure('TOS_ARCHIVE_HEAD_FAILED');
      data = response.data;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 404) return null;
      throw failure('TOS_ARCHIVE_HEAD_FAILED');
    }
    if (!data || typeof data !== 'object') throw failure('TOS_ARCHIVE_INVALID_OBJECT');
    const sizeText = data['content-length'];
    const size = Number(sizeText);
    const sha256 = data['x-tos-meta-sha256'];
    const lastModified = data['last-modified'];
    const uploadedAt = typeof lastModified === 'string' ? Date.parse(lastModified) : NaN;
    const etag = data.etag;
    const etagHex = typeof etag === 'string' && (etag.length === 32 || etag.length === 34)
      && /^(?:[a-fA-F0-9]{32}|"[a-fA-F0-9]{32}")$/.test(etag)
      ? etag.replace(/"/g, '') : undefined;
    const etagMd5 = etagHex === undefined ? undefined : Buffer.from(etagHex, 'hex').toString('base64');
    const contentMd5 = data['content-md5'];
    const md5 = contentMd5 ?? etagMd5;
    if (typeof sizeText !== 'string' || !sizeText.length || /[^0-9]/.test(sizeText) || !Number.isSafeInteger(size) || size < 0
      || !validSha256(sha256)
      || !Number.isFinite(uploadedAt) || uploadedAt < 0 || !validMd5(md5)
      || (etag !== undefined && etagMd5 === undefined)
      || (etagMd5 !== undefined && md5 !== etagMd5)) {
      throw failure('TOS_ARCHIVE_INVALID_OBJECT');
    }
    return { size, sha256: sha256.toLowerCase(), md5, uploadedAt };
  }

  downloadUrl(key: string, expiresSeconds: number): string {
    const objectKey = this.objectKey(key);
    if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds <= 0) throw failure('TOS_ARCHIVE_INVALID_TTL');
    const path = objectKey.split('/').map(part => encodeURIComponent(part)
      .replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
    return `${this.#publicOrigin}/${path}`;
  }

  async delete(key: string): Promise<void> {
    const objectKey = this.objectKey(key);
    try {
      await this.#client.deleteObject({ bucket: this.#bucket, key: objectKey });
    } catch {
      throw failure('TOS_ARCHIVE_DELETE_FAILED');
    }
  }
}
