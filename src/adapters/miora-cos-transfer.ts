import { createHash } from 'node:crypto';
import { fetch } from 'undici';
import { MioraApiError, prepareCosUpload } from './miora-api.js';
import type { MioraClient } from './miora-client.js';
import { mediaIdleWatchdog } from '../system-media/resources.js';
import { sleep } from './provider-retry.js';
import { mioraDiagnostic, mioraSourceIdentity } from './miora-diagnostics.js';

export type MioraTransferStage = 'source_fetch' | 'source_verify' | 'cos_grant' | 'cos_put' | 'internal';

export interface MioraTransferFailure {
  code: string;
  stage: MioraTransferStage;
  retryable: boolean;
  httpStatus?: number;
  networkCode?: string;
  cosCode?: string;
  cosRequestId?: string;
  providerCode?: string;
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

async function* abortableBody(body: AsyncIterable<Uint8Array>, signal?:AbortSignal) {
  const iterator = body[Symbol.asyncIterator]();
  let reject!: (reason:unknown) => void;
  const aborted = new Promise<never>((_, fail) => { reject=fail; });
  const abort = () => reject(signal?.reason);
  signal?.addEventListener('abort', abort, {once:true});
  try {
    for (;;) { signal?.throwIfAborted(); const next=await Promise.race([iterator.next(),aborted]); if(next.done)return; yield next.value; }
  } finally { signal?.removeEventListener('abort',abort); void iterator.return?.().catch(()=>{}); }
}
function operationFailure(stage:MioraTransferStage, error:unknown, signal?:AbortSignal):MioraTransferError {
  if(signal?.aborted && signal.reason instanceof MioraTransferError) return signal.reason.failure.code === 'TRANSFER_SERVICE_STOPPED'
    ? failureError({...signal.reason.failure,stage},error) : signal.reason;
  return transientFailure(stage,error);
}
function failureOutcome(failure:MioraTransferFailure, signal?:AbortSignal):string {
  return failure.code==='TRANSFER_IDLE_TIMEOUT'?'timeout':failure.code==='TRANSFER_SERVICE_STOPPED'?'stopped':signal?.aborted?'cancelled':'failed';
}

/** COS error XML is untrusted: keep only bounded, non-secret identifiers. */
async function cosFailureIdentifiers(response: Awaited<ReturnType<typeof fetch>>, signal?:AbortSignal, progress?:()=>void): Promise<Pick<MioraTransferFailure, 'cosCode' | 'cosRequestId'>> {
  if (!response.body) return {};
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of abortableBody(response.body,signal)) {
      progress?.();
      const bytes = Buffer.from(chunk);
      chunks.push(bytes.subarray(0, Math.max(0, 8192 - size)));
      size += bytes.length;
      if (size >= 8192) break;
    }
  } catch (error) { if(signal?.aborted)throw error;return {}; }
  const xml = Buffer.concat(chunks).toString('utf8');
  const cosCode = /<Code>([A-Za-z][A-Za-z0-9]{0,79})<\/Code>/.exec(xml)?.[1];
  const cosRequestId = /<RequestId>([A-Za-z0-9_-]{1,128})<\/RequestId>/.exec(xml)?.[1];
  return { ...(cosCode ? { cosCode } : {}), ...(cosRequestId ? { cosRequestId } : {}) };
}

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
    return failureError({ code:'COS_GRANT_HTTP', stage, retryable:RETRYABLE_HTTP(error.status), httpStatus:error.status, ...(error.apiCode && /^[A-Za-z0-9_.-]{1,80}$/.test(error.apiCode) ? { providerCode:error.apiCode } : {}) }, error);
  }
  const code = networkCode(error);
  const recognizedCode = code && RETRYABLE_NETWORK_CODES.has(code) ? code : undefined;
  const retryable = error instanceof TypeError && (error as { name?:string }).name !== 'AbortError' || !!recognizedCode;
  return failureError({ code:retryable ? 'NETWORK_ERROR' : 'INTERNAL_ERROR', stage, retryable,
    ...(recognizedCode ? { networkCode:recognizedCode } : {}) }, error);
}

async function retry<T>(operation: (attempt: number) => Promise<T>, delays: readonly number[], signal?:AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { signal?.throwIfAborted(); return await operation(attempt + 1); }
    catch (error) {
      const typed = error instanceof MioraTransferError ? error
        : failureError({ code:'INTERNAL_ERROR', stage:'internal', retryable:false }, error);
      if (signal?.aborted && signal.reason instanceof MioraTransferError) throw typed.failure.code===signal.reason.failure.code?typed:signal.reason;
      if (signal?.aborted) throw failureError({ code:'TRANSFER_CANCELLED', stage:typed.failure.stage, retryable:false }, error);
      if (!typed.failure.retryable || attempt >= delays.length) throw typed;
      mioraDiagnostic('miora.transfer.retry', { ...typed.failure, attempt:attempt + 1, retry:attempt + 1, delayMs:delays[attempt] });
      try { await sleep(delays[attempt]!, signal); }
      catch (cause) { if(signal?.reason instanceof MioraTransferError)throw signal.reason;throw failureError({ code:'TRANSFER_CANCELLED', stage:typed.failure.stage, retryable:false }, cause); }
    }
  }
}

async function fetchSource(input: { sourceUrl:string; allowedHosts:readonly string[]; size:number; signal?:AbortSignal; progress?:()=>void }) {
  let source = safeSource(input.sourceUrl, input.allowedHosts);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    let response;
    const started = performance.now();
    mioraDiagnostic('miora.transfer.source_fetch', { outcome:'started', attempt:redirects + 1 });
    try { response = await fetch(source, { redirect:'manual', signal:input.signal }); }
    catch (error) {
      const failure = operationFailure('source_fetch', error,input.signal);
      mioraDiagnostic('miora.transfer.source_fetch', { ...failure.failure, outcome:failureOutcome(failure.failure,input.signal), elapsedMs:performance.now() - started });
      throw failure;
    }
    input.progress?.();
    mioraDiagnostic('miora.transfer.source_fetch', { outcome:'response', httpStatus:response.status, elapsedMs:performance.now() - started });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok || !response.body) { await response.body?.cancel?.().catch(()=>{}); throw failureError({ code:'SOURCE_FETCH_HTTP', stage:'source_fetch',
        retryable:RETRYABLE_HTTP(response.status), httpStatus:response.status }); }
      const declared = Number(response.headers.get('content-length') || input.size);
      if (declared !== input.size) { await response.body.cancel?.().catch(()=>{});throw failureError({ code:'SOURCE_SIZE_CHANGED', stage:'source_verify', retryable:false }); }
      return response;
    }
    await response.body?.cancel?.().catch(()=>{});
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
  idleTimeoutMs?: number;
}): Promise<string> {
  const started = performance.now();
  mioraDiagnostic('miora.transfer.started', { expectedBytes:input.size, sourceId:mioraSourceIdentity(input.sourceUrl) });
  try {
    const key = await transfer(input);
    mioraDiagnostic('miora.transfer.finished', { outcome:'succeeded', elapsedMs:performance.now() - started, bytes:input.size });
    return key;
  } catch (error) {
    const failure = describeMioraTransferFailure(error);
    mioraDiagnostic('miora.transfer.finished', { ...failure, outcome:failureOutcome(failure,input.signal), elapsedMs:performance.now() - started });
    throw error;
  }
}

async function transfer(input: Parameters<typeof transferPublicMediaToMioraCos>[0]): Promise<string> {
  const delays = input.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  let grant = await retry(async attempt => {
    const started = performance.now();
    mioraDiagnostic('miora.transfer.cos_grant', { outcome:'started', attempt });
    try {
      const grant = await input.client.getCosGrant(input.signal);
      mioraDiagnostic('miora.transfer.cos_grant', { outcome:'succeeded', attempt, elapsedMs:performance.now() - started });
      return grant;
    }
    catch (error) {
      const failure = operationFailure('cos_grant', error,input.signal);
      mioraDiagnostic('miora.transfer.cos_grant', { ...failure.failure, outcome:failureOutcome(failure.failure,input.signal), attempt, elapsedMs:performance.now() - started });
      throw failure;
    }
  }, delays, input.signal);
  return retry(async attempt => {
    const started = performance.now();
    let stage:MioraTransferStage='source_fetch';
    const controller=new AbortController();
    const stop=()=>controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort',stop,{once:true});
    if(input.signal?.aborted)stop();
    const idle=mediaIdleWatchdog(input.idleTimeoutMs ?? 10 * 60_000,
      ()=>failureError({code:'TRANSFER_IDLE_TIMEOUT',stage,retryable:true}),controller.signal);
    const signal=idle.signal;
    try {
    if(attempt > 1) {
      stage='cos_grant';
      mioraDiagnostic('miora.transfer.cos_grant',{outcome:'started',attempt});
      try {grant=await input.client.getCosGrant(signal);}
      catch(error) {throw operationFailure('cos_grant',error,signal);}
      idle.progress();stage='source_fetch';
      mioraDiagnostic('miora.transfer.cos_grant',{outcome:'succeeded',attempt});
    }
    const upload = prepareCosUpload(grant, input.fileName, input.mimeType, input.size);
    const response = await fetchSource({...input,signal,progress:idle.progress});
    let received = 0;
    const digest = createHash('sha256');
    const counted = (async function* () {
      try {
        for await (const chunk of abortableBody(response.body!,signal)) {
          idle.progress();stage='source_fetch';
          const bytes = Buffer.from(chunk);
          received += bytes.length;
          digest.update(bytes);
          if (received > input.size) throw failureError({ code:'SOURCE_SIZE_EXCEEDED', stage:'source_verify', retryable:false });
          yield bytes;
        }
      } catch (error) {
        const failure = operationFailure('source_fetch', error,signal);
        mioraDiagnostic('miora.transfer.source_read', { ...failure.failure, outcome:failureOutcome(failure.failure,signal), bytes:received, expectedBytes:input.size, elapsedMs:performance.now() - started });
        throw failure;
      }
      if (received !== input.size) throw failureError({ code:'SOURCE_ENDED_EARLY', stage:'source_verify', retryable:false });
      if (digest.digest('hex') !== input.sha256.toLowerCase()) {
        throw failureError({ code:'SOURCE_HASH_CHANGED', stage:'source_verify', retryable:false });
      }
      stage='cos_put';idle.progress();
      mioraDiagnostic('miora.transfer.source_verify', { outcome:'succeeded', bytes:received, expectedBytes:input.size, elapsedMs:performance.now() - started, attempt });
    })();
    let uploaded;
    mioraDiagnostic('miora.transfer.cos_put', { outcome:'started', attempt, expectedBytes:input.size });
    try {
      uploaded = await fetch(upload.url, { method:'PUT', headers:upload.headers, body:counted, signal, duplex:'half' });
    } catch (error) {
      const failure = operationFailure('cos_put', error,signal);
      mioraDiagnostic('miora.transfer.cos_put', { ...failure.failure, outcome:failureOutcome(failure.failure,signal), attempt, bytes:received, elapsedMs:performance.now() - started });
      throw failure;
    }
    stage='cos_put';idle.progress();
    mioraDiagnostic('miora.transfer.cos_put', { outcome:'response', httpStatus:uploaded.status, bytes:received, attempt, elapsedMs:performance.now() - started });
    if (uploaded.status !== 200) throw failureError({ code:'COS_PUT_HTTP', stage:'cos_put',
      retryable:RETRYABLE_HTTP(uploaded.status), httpStatus:uploaded.status,
      ...await cosFailureIdentifiers(uploaded,signal,idle.progress) });
    await uploaded.body?.cancel?.().catch(()=>{});
    return upload.key;
    } catch(error) {
      if(signal.aborted && signal.reason instanceof MioraTransferError)throw operationFailure(stage,error,signal);
      throw error;
    } finally { controller.abort();idle.close();input.signal?.removeEventListener('abort',stop); }
  }, delays, input.signal);
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
  private readonly controller=new AbortController();
  get signal():AbortSignal {return this.controller.signal;}
  close():void {this.controller.abort(failureError({code:'TRANSFER_SERVICE_STOPPED',stage:'internal',retryable:true}));}
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
