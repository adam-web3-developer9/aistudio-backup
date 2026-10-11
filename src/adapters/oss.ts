import { createHash, createHmac } from 'node:crypto';
// Same undici the Hailuo client uses. Importing undici anywhere replaces the
// dispatcher behind Node's built-in fetch (they share a globalThis symbol), so
// the whole project stays on one HTTP stack rather than a mix of two versions.
import { fetch } from 'undici';

/** STS credentials handed out by `/v1/api/files/request_policy`. */
export interface OssPolicy {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiration: string;
  dir: string;
  endpoint: string;
  bucketName: string;
  serverTime: string;
}

/**
 * Single-shot signed PUT (Aliyun OSS signature V1).
 *
 * The web app uses ali-oss `multipartUpload`, which only matters for large media;
 * reference images are a few MB, so one PUT keeps this dependency-free.
 */
export async function putObject(options: {
  policy: OssPolicy;
  key: string;
  body: Buffer;
  contentType: string;
}): Promise<string> {
  const { policy, key, body, contentType } = options;
  const date = new Date().toUTCString();
  const contentMd5 = createHash('md5').update(body).digest('base64');

  // CanonicalizedOSSHeaders: every x-oss-* header, lowercased and sorted.
  const ossHeaders = { 'x-oss-security-token': policy.securityToken };
  const canonicalizedOssHeaders = Object.entries(ossHeaders)
    .map(([name, value]) => `${name.toLowerCase()}:${value}\n`)
    .sort()
    .join('');

  const stringToSign = [
    'PUT',
    contentMd5,
    contentType,
    date,
    `${canonicalizedOssHeaders}/${policy.bucketName}/${key}`
  ].join('\n');

  const signature = createHmac('sha1', policy.accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64');

  // No proxy dispatcher here on purpose: this PUT is several MB straight to
  // Aliyun under an STS signature and carries no account token, so it goes
  // direct. Residential proxies drop it mid-body (UND_ERR_SOCKET after ~67s).
  // content-length is left to fetch — setting it by hand is rejected, and the
  // signature covers content-md5/content-type/date, not the length.
  const url = `https://${policy.bucketName}.${policy.endpoint}/${encodeKey(key)}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      ...ossHeaders,
      'content-type': contentType,
      'content-md5': contentMd5,
      date,
      authorization: `OSS ${policy.accessKeyId}:${signature}`
    },
    body: new Uint8Array(body)
  });

  if (!response.ok) {
    throw new Error(`OSS PUT ${key} failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
  }
  return url;
}

/** Percent-encode each path segment but keep the `/` separators. */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}
