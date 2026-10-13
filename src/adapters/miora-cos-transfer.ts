import { createHash } from 'node:crypto';
import { fetch } from 'undici';
import { MioraApiError, prepareCosUpload } from './miora-api.js';
import type { MioraClient } from './miora-client.js';

export type MioraTransferStage = 'source_fetch' | 'source_verify' | 'cos_grant' | 'cos_put' | 'internal';

export interface MioraTransferFailure {
  code: string;
  stage: MioraTransferStage;
  retryable: boolean;
  httpStatus?: number;
  networkCode?: string;
}

export class MioraTransferError extends Error {
  constructor(readonly failure: MioraTransferFailure, cause?: unknown) {
    super(`${failure.stage} failed (${failure.code})`, { cause });
    this.name = 'MioraTransferError';
  }
}

const DEFAULT_RETRY_DELAYS_MS = [250, 1_000] as const;
const RETRYABLE_HTTP = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN',
  'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_RESPONSE_STATUS_CODE'
]);

function allowedHost(host: string, allow: readonly string[]): boolean {
  return allow.some(entry => host === entry || entry.startsWith('.') && host.endsWith(entry));
}

function failureError(failure: MioraTransferFailure, cause?: unknown): MioraTransferError {
  return new MioraTransferError(failure, cause);
}

function safeSource(value: string, allow: readonly string[]): URL {
  let url: URL;
  try { url = new URL(value); }
  catch (error) { throw failureError({ code:'SOURCE_URL_INVALID', stage:'source_fetch', retryable:false }, error); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowedHost(url.hostname, allow)) {
    throw failureError({ code:'SOURCE_HOST_NOT_ALLOWED', stage:'source_fetch', retryable:false });
  }
  return url;
}

function networkCode(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const code = (current as { code?:unknown }).code;
    if (typeof code === 'string' && code) return code;
    current = (current as { cause?:unknown }).cause;
  }
  return undefined;
}

function transientFailure(stage: MioraTransferStage, error: unknown): MioraTransferError {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof MioraTransferError) return current;
    seen.add(current);
    current = (current as { cause?:unknown }).cause;
  }
  if (error instanceof MioraApiError) {
    return failureError({ code:'COS_GRANT_HTTP', stage, retryable:RETRYABLE_HTTP(error.status), httpStatus:error.status }, error);
  }
  const code = networkCode(error);
  const recognizedCode = code && RETRYABLE_NETWORK_CODES.has(code) ? code : undefined;
  const retryable = error instanceof TypeError && (error as { name?:string }).name !== 'AbortError' || !!recognizedCode;
  return failureError({ code:retryable ? 'NETWORK_ERROR' : 'INTERNAL_ERROR', stage, retryable,
    ...(recognizedCode ? { networkCode:recognizedCode } : {}) }, error);
}

function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function retry<T>(operation: () => Promise<T>, delays: readonly number[]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      const typed = error instanceof MioraTransferError ? error
        : failureError({ code:'INTERNAL_ERROR', stage:'internal', retryable:false }, error);
      if (!typed.failure.retryable || attempt >= delays.length) throw typed;
      await wait(delays[attempt]!);
    }
  }
}

async function fetchSource(input: { sourceUrl:string; allowedHosts:readonly string[]; size:number; signal?:AbortSignal }) {
  let source = safeSource(input.sourceUrl, input.allowedHosts);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let response;
    try { response = await fetch(source, { redirect:'manual', signal:input.signal }); }
    catch (error) { throw transientFailure('source_fetch', error); }
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok || !response.body) throw failureError({ code:'SOURCE_FETCH_HTTP', stage:'source_fetch',
        retryable:RETRYABLE_HTTP(response.status), httpStatus:response.status });
      const declared = Number(response.headers.get('content-length') || input.size);
      if (declared !== input.size) throw failureError({ code:'SOURCE_SIZE_CHANGED', stage:'source_verify', retryable:false });
      return response;
    }
    const location = response.headers.get('location');
    if (!location || redirects === 3) throw failureError({ code:'SOURCE_REDIRECT_LIMIT', stage:'source_fetch', retryable:false });
    let redirected: string;
    try { redirected = new URL(location, source).toString(); }
    catch (error) { throw failureError({ code:'SOURCE_REDIRECT_INVALID', stage:'source_fetch', retryable:false }, error); }
    source = safeSource(redirected, input.allowedHosts);
  }
  throw failureError({ code:'SOURCE_REDIRECT_LIMIT', stage:'source_fetch', retryable:false });
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
  retryDelaysMs?: readonly number[];
}): Promise<string> {
  const delays = input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const grant = await retry(async () => {
    try { return await input.client.getCosGrant(input.signal); }
    catch (error) { throw transientFailure('cos_grant', error); }
  }, delays);
  const upload = prepareCosUpload(grant, input.fileName, input.mimeType, input.size);
  return retry(async () => {
    const response = await fetchSource(input);
    let received = 0;
    const digest = createHash('sha256');
    const counted = (async function* () {
      try {
        for await (const chunk of response.body!) {
          const bytes = Buffer.from(chunk);
          received += bytes.length;
          digest.update(bytes);
          if (received > input.size) throw failureError({ code:'SOURCE_SIZE_EXCEEDED', stage:'source_verify', retryable:false });
          yield bytes;
        }
      } catch (error) {
        if (error instanceof MioraTransferError) throw error;
        throw transientFailure('source_fetch', error);
      }
      if (received !== input.size) throw failureError({ code:'SOURCE_ENDED_EARLY', stage:'source_verify', retryable:false });
      if (digest.digest('hex') !== input.sha256.toLowerCase()) {
        throw failureError({ code:'SOURCE_HASH_CHANGED', stage:'source_verify', retryable:false });
      }
    })();
    let uploaded;
    try {
      uploaded = await fetch(upload.url, { method:'PUT', headers:upload.headers, body:counted, signal:input.signal, duplex:'half' });
    } catch (error) {
      if (error instanceof MioraTransferError) throw error;
      throw transientFailure('cos_put', error);
    }
    if (uploaded.status !== 200) throw failureError({ code:'COS_PUT_HTTP', stage:'cos_put',
      retryable:RETRYABLE_HTTP(uploaded.status), httpStatus:uploaded.status });
    return upload.key;
  }, delays);
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async use<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active += 1;
    else await new Promise<void>(resolve => this.waiters.push(resolve));
    try { return await operation(); }
    finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

/** Service-scoped bounded execution and account-scoped singleflight for verified public media. */
export class MioraCosTransferCoordinator {
  private readonly global: Semaphore;
  private readonly accounts = new Map<string,Semaphore>();
  private readonly flights = new Map<string,Promise<string>>();
  constructor(globalLimit = 6, private readonly accountLimit = 2) {
    if (!Number.isInteger(globalLimit) || globalLimit < 1 || !Number.isInteger(accountLimit) || accountLimit < 1) {
      throw new Error('Miora transfer concurrency limits must be positive integers');
    }
    this.global = new Semaphore(globalLimit);
  }
  transfer(input: { accountId:string; identity:string; run:() => Promise<string> }): Promise<string> {
    const flightKey = `${input.accountId}\0${input.identity}`;
    const existing = this.flights.get(flightKey);
    if (existing) return existing;
    const account = this.accounts.get(input.accountId) ?? new Semaphore(this.accountLimit);
    this.accounts.set(input.accountId, account);
    const flight = this.global.use(() => account.use(input.run));
    this.flights.set(flightKey, flight);
    const cleanup = () => {
      if (this.flights.get(flightKey) === flight) this.flights.delete(flightKey);
    };
    void flight.then(cleanup, cleanup);
    return flight;
  }
}

export function describeMioraTransferFailure(error: unknown): MioraTransferFailure {
  if (error instanceof MioraTransferError) return error.failure;
  return { code:'INTERNAL_ERROR', stage:'internal', retryable:false };
}
