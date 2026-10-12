import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { JobRecord } from '../types.js';
import { SystemError } from '../system/types.js';
import type { ChannelStore } from './store.js';

export const gatewayJobIdPrefix = 'job_gateway_';
const resourceId = /^[A-Za-z0-9_-]{1,200}$/;
const gatewayJobId = /^job_gateway_[A-Za-z0-9_-]{1,180}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();

/** This is an explicitly configured operator gateway, independent of user sessions. */
export function assertVideoGatewayConfiguration(enabled: boolean, apiKey?: string): void {
  if (enabled && (!apiKey || !/^[\x21-\x7e]{32,4096}$/.test(apiKey))) {
    throw new SystemError(500, 'VIDEO_GATEWAY_CONFIGURATION_INVALID', 'Video gateway requires an API key of at least 32 non-whitespace characters');
  }
}

/** Proxy credentials may be present, but diagnostics must never include the configured URL. */
export function assertVideoGatewayProxyConfiguration(enabled: boolean, proxyUrl?: string): void {
  if (!enabled) return;
  const invalid = () => { throw new SystemError(500, 'VIDEO_GATEWAY_PROXY_CONFIGURATION_INVALID', 'Video gateway requires a valid HTTP or HTTPS proxy'); };
  if (!proxyUrl || !/^https?:\/\/[^/\\?#]/i.test(proxyUrl) || /[\s\\]/.test(proxyUrl) || proxyUrl.includes('?') || proxyUrl.includes('#')) invalid();
  try {
    const parsed = new URL(proxyUrl!);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname !== '/' || parsed.search || parsed.hash) invalid();
  } catch { invalid(); }
}

/** Check the route before authentication so other legacy administration APIs stay absent. */
export function assertVideoGatewayRequest(request: FastifyRequest, enabled: boolean, apiKey?: string): void {
  const pathname = request.url.split('?')[0]!;
  const allowed = request.method === 'POST' && (pathname === '/v1/assets' || pathname === '/v1/jobs')
    || request.method === 'GET' && (pathname === '/v1/jobs' || pathname.startsWith('/v1/jobs/') && gatewayJobId.test(pathname.slice('/v1/jobs/'.length)));
  if (!enabled || !allowed) throw new SystemError(404, 'LEGACY_API_DISABLED', 'Legacy channel HTTP API is disabled');
  assertVideoGatewayConfiguration(enabled, apiKey);
  const supplied = request.headers['x-api-key'];
  if (typeof supplied !== 'string' || !timingSafeEqual(digest(supplied), digest(apiKey!))) {
    throw new SystemError(401, 'VIDEO_GATEWAY_UNAUTHORIZED', 'A valid video gateway API key is required');
  }
}

/** Resource provenance survives worker restarts and cannot be reassigned by key rotation. */
export class ManagedVideoGatewayRecords {
  private readonly keyHash: string;
  constructor(private readonly channels: ChannelStore, apiKey: string) {
    assertVideoGatewayConfiguration(true, apiKey);
    this.keyHash = digest(apiKey).toString('hex');
    channels.db.exec(`
      CREATE TABLE IF NOT EXISTS video_gateway_assets(asset_id TEXT PRIMARY KEY,key_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS video_gateway_jobs(job_id TEXT PRIMARY KEY,key_hash TEXT NOT NULL);
    `);
  }
  ownAsset(id: string): void {
    if (!resourceId.test(id)) throw new SystemError(400, 'GATEWAY_ASSET_INVALID', 'Gateway asset ID is invalid');
    this.channels.db.prepare('INSERT OR IGNORE INTO video_gateway_assets(asset_id,key_hash) VALUES(?,?)').run(id, this.keyHash);
    if (!this.hasAsset(id)) throw new SystemError(404, 'ASSET_NOT_FOUND', 'Gateway asset is unavailable');
  }
  hasAsset(id: string): boolean {
    return resourceId.test(id) && !!this.channels.db.prepare('SELECT 1 FROM video_gateway_assets WHERE asset_id=? AND key_hash=?').get(id, this.keyHash);
  }
  ownJob(id: string): void {
    if (!gatewayJobId.test(id)) throw new SystemError(400, 'GATEWAY_JOB_INVALID', 'Gateway job ID is invalid');
    this.channels.db.prepare('INSERT OR IGNORE INTO video_gateway_jobs(job_id,key_hash) VALUES(?,?)').run(id, this.keyHash);
    if (!this.hasJob(id)) throw new SystemError(404, 'JOB_NOT_FOUND', 'Gateway job is unavailable');
  }
  hasJob(id: string): boolean {
    return gatewayJobId.test(id) && !!this.channels.db.prepare('SELECT 1 FROM video_gateway_jobs WHERE job_id=? AND key_hash=?').get(id, this.keyHash);
  }
  assertExecution(job: JobRecord): void {
    if (!job.id.startsWith(gatewayJobIdPrefix)) return;
    if (!this.hasJob(job.id)) throw new SystemError(403, 'GATEWAY_EXECUTION_UNAVAILABLE', 'Gateway execution owner is unavailable');
    const account = job.sessionId ? this.channels.row(job.sessionId) : undefined;
    if (!account?.enabled || account.archived_at) throw new SystemError(403, 'GATEWAY_ACCOUNT_UNAVAILABLE', 'Gateway channel account is unavailable');
  }
}

const statusMessages = { queued: 'Video task queued', running: 'Video generation in progress', succeeded: 'Video generation completed', failed: 'Video generation failed' } as const;
const errorMessages: Readonly<Record<string, string>> = {
  AUTOMATION_FAILED: 'Video generation failed',
  ADAPTER_NOT_FOUND: 'The video adapter is unavailable',
  ASSET_NOT_FOUND: 'Reference media is unavailable',
  SESSION_NOT_FOUND: 'The provider account is unavailable',
  SESSION_ADAPTER_MISMATCH: 'The provider account does not support this channel',
  NO_ACCOUNTS_AVAILABLE: 'No provider account is available',
  INTERRUPTED: 'Video generation was interrupted by a service restart',
  JOB_TIMEOUT: 'The video task timed out',
  RENDER_TIMEOUT: 'The provider video task timed out',
  CONTENT_REJECTED: 'The provider rejected the prompt or reference media',
  INSUFFICIENT_CREDITS: 'The provider account has insufficient credits',
  ACCOUNT_BALANCE_UNAVAILABLE: 'The provider account balance could not be confirmed',
  AUTH_FAILED: 'The provider account authentication is unavailable',
  PROVIDER_BUSY: 'The provider is busy',
  PROVIDER_NETWORK_ERROR: 'The provider could not be reached',
  PROVIDER_RENDER_FAILED: 'The provider could not generate the video',
  PROVIDER_JOB_NOT_FOUND: 'The provider task could not be found',
  GATEWAY_ACCOUNT_UNAVAILABLE: 'The gateway channel account is unavailable',
  GATEWAY_EXECUTION_UNAVAILABLE: 'The gateway execution owner is unavailable',
};

function publicVideoUrl(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return;
  const value = (result as { videoUrl?: unknown }).videoUrl;
  if (typeof value !== 'string') return;
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return value;
  } catch { /* A local path or malformed address is never a public video URL. */ }
}

/** Never spread provider records: prompts, credentials, asset paths and raw messages are private. */
export function projectGatewayJob(job: JobRecord) {
  if (!gatewayJobId.test(job.id)) throw new SystemError(404, 'JOB_NOT_FOUND', 'Gateway job is unavailable');
  const videoUrl = publicVideoUrl(job.result);
  const percent = job.progress?.percent;
  const providerJobId = job.progress?.providerJobId;
  const code = job.error && Object.hasOwn(errorMessages, job.error.code) ? job.error.code : 'VIDEO_GENERATION_FAILED';
  return {
    id: job.id, status: job.status, createdAt: job.createdAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(videoUrl ? { result: { videoUrl } } : {}),
    ...(job.progress ? { progress: {
      ...(typeof percent === 'number' && Number.isFinite(percent) ? { percent: Math.max(0, Math.min(100, percent)) } : {}),
      ...(typeof providerJobId === 'string' && resourceId.test(providerJobId) ? { providerJobId } : {}),
      message: statusMessages[job.status],
    } } : {}),
    ...(job.error ? { error: { code, message: errorMessages[code] ?? 'Video generation failed',
      ...(typeof job.error.retryable === 'boolean' ? { retryable: job.error.retryable } : {}) } } : {}),
  };
}
