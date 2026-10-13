import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { fetch } from 'undici';
import { MioraApiError } from './miora-api.js';
import { MioraCosTransferCoordinator, MioraTransferError, transferPublicMediaToMioraCos } from './miora-cos-transfer.js';
import type { MioraClient } from './miora-client.js';
import { MioraDiagnosticSink, withMioraDiagnostics } from './miora-diagnostics.js';

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
    await expect(transferPublicMediaToMioraCos({ ...input, size: 5 })).rejects.toMatchObject({
      failure: { code:'SOURCE_SIZE_EXCEEDED', stage:'source_verify', retryable:false }
    });
    expect(uploadedChunks.map(chunk => Buffer.from(chunk).toString())).toEqual(['abc']);
    uploadedChunks.length = 0;
    declaredSize = 6;
    await expect(transferPublicMediaToMioraCos({ ...input, sha256: '0'.repeat(64) })).rejects.toMatchObject({
      failure: { code:'SOURCE_HASH_CHANGED', stage:'source_verify', retryable:false }
    });
  } finally { vi.restoreAllMocks(); }
});

test('Miora cloud transfer retries transient source and COS failures without exposing signed locations', async () => {
  const bytes = Buffer.from('verified');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const client = { getCosGrant: vi.fn(async () => ({ prefix:'safe-prefix', bucket:'bucket', region:'ap-test',
    token:'secret-token', secret_id:'secret-id', secret_key:'secret-key' })) } as unknown as MioraClient;
  let sourceCalls = 0;
  let putCalls = 0;
  vi.mocked(fetch).mockImplementation(async address => {
    if (String(address).startsWith('https://source.invalid/')) {
      sourceCalls += 1;
      if (sourceCalls === 1) return { ok:false, status:503, headers:new Headers(), body:null } as unknown as Awaited<ReturnType<typeof fetch>>;
      return { ok:true, status:200, headers:new Headers({ 'content-length':String(bytes.length) }),
        body:(async function* () { yield bytes; })() } as unknown as Awaited<ReturnType<typeof fetch>>;
    }
    putCalls += 1;
    return { status:putCalls === 1 ? 503 : 200 } as Awaited<ReturnType<typeof fetch>>;
  });
  try {
    await expect(transferPublicMediaToMioraCos({ client, sourceUrl:'https://source.invalid/private?signature=do-not-log',
      allowedHosts:['source.invalid'], fileName:'verified.png', mimeType:'image/png', size:bytes.length, sha256,
      retryDelaysMs:[0, 0] })).resolves.toBe('safe-prefix/verified.png');
    expect(sourceCalls).toBe(3);
    expect(putCalls).toBe(2);
  } finally { vi.restoreAllMocks(); }
});

test('Miora transfer failure is typed and contains no source URL', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok:false, status:403, headers:new Headers(), body:null } as unknown as Awaited<ReturnType<typeof fetch>>);
  const client = { getCosGrant:vi.fn(async () => ({ prefix:'safe-prefix', bucket:'bucket', region:'ap-test',
    token:'secret-token', secret_id:'secret-id', secret_key:'secret-key' })) } as unknown as MioraClient;
  try {
    let error: MioraTransferError | undefined;
    try {
      await transferPublicMediaToMioraCos({ client, sourceUrl:'https://source.invalid/private?signature=secret',
        allowedHosts:['source.invalid'], fileName:'a.png', mimeType:'image/png', size:1, sha256:'0'.repeat(64), retryDelaysMs:[] });
    } catch (value) { error = value as MioraTransferError; }
    expect(error).toBeInstanceOf(MioraTransferError);
    if (!error) throw new Error('Expected transfer to fail');
    expect(error.failure).toEqual({ code:'SOURCE_FETCH_HTTP', stage:'source_fetch', retryable:false, httpStatus:403 });
    expect(JSON.stringify(error.failure)).not.toContain('source.invalid');
    expect(error.message).not.toContain('signature');
  } finally { vi.restoreAllMocks(); }
});

test('Miora COS rejection retains only safe XML identifiers', async () => {
  const bytes = Buffer.from('x');
  const client = { getCosGrant: vi.fn(async () => ({ prefix:'safe-prefix', bucket:'bucket', region:'ap-test',
    token:'secret-token', secret_id:'secret-id', secret_key:'secret-key' })) } as unknown as MioraClient;
  vi.mocked(fetch).mockImplementation(async address => String(address).startsWith('https://source.invalid/')
    ? { ok:true, status:200, headers:new Headers({ 'content-length':'1' }),
      body:(async function* () { yield bytes; })() } as unknown as Awaited<ReturnType<typeof fetch>>
    : { status:403, body:(async function* () {
      yield Buffer.from('<Error><Code>SignatureDoesNotMatch</Code><Message>secret-token</Message><RequestId>cos-123</RequestId></Error>');
    })() } as unknown as Awaited<ReturnType<typeof fetch>>);
  try {
    await expect(transferPublicMediaToMioraCos({ client, sourceUrl:'https://source.invalid/x',
      allowedHosts:['source.invalid'], fileName:'x.png', mimeType:'image/png', size:1,
      sha256:createHash('sha256').update(bytes).digest('hex'), retryDelaysMs:[] })).rejects.toMatchObject({
      failure:{ code:'COS_PUT_HTTP', stage:'cos_put', retryable:false, httpStatus:403,
        cosCode:'SignatureDoesNotMatch', cosRequestId:'cos-123' }
    });
  } finally { vi.restoreAllMocks(); }
});

test('Miora cloud transfer retries a transient COS grant without downloading the source first', async () => {
  const bytes = Buffer.from('x');
  const getCosGrant = vi.fn()
    .mockRejectedValueOnce(new MioraApiError(503, undefined, 'temporarily unavailable', '/sts/tokens'))
    .mockResolvedValue({ prefix:'safe-prefix', bucket:'bucket', region:'ap-test', token:'token', secret_id:'id', secret_key:'key' });
  vi.mocked(fetch).mockImplementation(async (address, options) => {
    if (String(address).startsWith('https://source.invalid/')) return { ok:true, status:200,
      headers:new Headers({ 'content-length':'1' }), body:(async function* () { yield bytes; })() } as unknown as Awaited<ReturnType<typeof fetch>>;
    for await (const _chunk of options!.body as AsyncIterable<Uint8Array>) { /* consume and verify */ }
    return { status:200 } as Awaited<ReturnType<typeof fetch>>;
  });
  try {
    await expect(transferPublicMediaToMioraCos({ client:{ getCosGrant } as unknown as MioraClient,
      sourceUrl:'https://source.invalid/a', allowedHosts:['source.invalid'], fileName:'a.png', mimeType:'image/png',
      size:1, sha256:createHash('sha256').update(bytes).digest('hex'), retryDelaysMs:[0] })).resolves.toBe('safe-prefix/a.png');
    expect(getCosGrant).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { vi.restoreAllMocks(); }
});

test('Miora transfer coordinator singleflights by account and bounds account concurrency', async () => {
  const coordinator = new MioraCosTransferCoordinator(4, 1);
  let active = 0;
  let peak = 0;
  let runs = 0;
  const gates: Array<() => void> = [];
  const run = async (value:string) => {
    runs += 1; active += 1; peak = Math.max(peak, active);
    await new Promise<void>(resolve => gates.push(resolve));
    active -= 1;
    return value;
  };
  const first = coordinator.transfer({ accountId:'a', identity:'same', run:() => run('key-a') });
  const shared = coordinator.transfer({ accountId:'a', identity:'same', run:() => run('should-not-run') });
  const queued = coordinator.transfer({ accountId:'a', identity:'other', run:() => run('key-b') });
  await vi.waitFor(() => expect(gates).toHaveLength(1));
  gates.shift()!();
  await vi.waitFor(() => expect(gates).toHaveLength(1));
  gates.shift()!();
  await expect(Promise.all([first, shared, queued])).resolves.toEqual(['key-a', 'key-a', 'key-b']);
  expect(runs).toBe(2);
  expect(peak).toBe(1);
});

test('Miora source read failure retains its stage, byte count and intent correlation through the PUT wrapper', async () => {
  const records: Record<string, unknown>[] = [];
  const sink = new MioraDiagnosticSink({ info:fields => { records.push(fields); } });
  const client = { getCosGrant:vi.fn(async () => ({ prefix:'SECRET-prefix', bucket:'bucket', region:'ap-test',
    token:'SECRET-token', secret_id:'SECRET-id', secret_key:'SECRET-key' })) } as unknown as MioraClient;
  vi.mocked(fetch).mockImplementation(async (address, options) => {
    if (String(address).startsWith('https://source.invalid/')) return { ok:true, status:200,
      headers:new Headers({ 'content-length':'2' }), body:(async function* () {
        yield Buffer.from('x');
        throw new TypeError('SECRET signed source response', { cause:Object.assign(new Error('SECRET'), { code:'ECONNRESET' }) });
      })() } as unknown as Awaited<ReturnType<typeof fetch>>;
    try { for await (const _chunk of options!.body as AsyncIterable<Uint8Array>) { /* consume */ } }
    catch (error) { throw new TypeError('SECRET fetch failed', { cause:error }); }
    return { status:200 } as Awaited<ReturnType<typeof fetch>>;
  });
  try {
    await expect(withMioraDiagnostics(sink, { requestId:'req-source', uploadIntentId:'upload-source', itemIndex:3 }, () =>
      transferPublicMediaToMioraCos({ client, sourceUrl:'https://source.invalid/SECRET?signature=SECRET',
        allowedHosts:['source.invalid'], fileName:'SECRET.png', mimeType:'image/png', size:2,
        sha256:'0'.repeat(64), retryDelaysMs:[] }))).rejects.toMatchObject({
          failure:{ stage:'source_fetch', code:'NETWORK_ERROR', networkCode:'ECONNRESET', retryable:true }
        });
    sink.flush();
    expect(records).toContainEqual(expect.objectContaining({ event:'miora.transfer.source_read', bytes:1,
      requestId:'req-source', uploadIntentId:'upload-source', itemIndex:3, stage:'source_fetch', networkCode:'ECONNRESET' }));
    expect(records).toContainEqual(expect.objectContaining({ event:'miora.transfer.finished', outcome:'failed', stage:'source_fetch' }));
    expect(JSON.stringify(records)).not.toContain('SECRET');
  } finally { vi.restoreAllMocks(); }
});

test('Miora caller cancellation cannot be mistaken for a retryable TypeError or restart source reads', async () => {
  const controller = new AbortController();
  const client = { getCosGrant:vi.fn(async () => ({ prefix:'prefix', bucket:'bucket', region:'ap-test', token:'token', secret_id:'id', secret_key:'key' })) } as unknown as MioraClient;
  vi.mocked(fetch).mockImplementation(async () => {
    const reason = new TypeError('user cancellation'); controller.abort(reason); throw reason;
  });
  try {
    const before = vi.mocked(fetch).mock.calls.length;
    await expect(transferPublicMediaToMioraCos({ client, sourceUrl:'https://source.invalid/x', allowedHosts:['source.invalid'],
      fileName:'x.png', mimeType:'image/png', size:1, sha256:'0'.repeat(64), signal:controller.signal, retryDelaysMs:[0,0] }))
      .rejects.toMatchObject({ failure:{code:'TRANSFER_CANCELLED',retryable:false,stage:'source_fetch'} });
    expect(vi.mocked(fetch).mock.calls.length - before).toBe(1);
  } finally { vi.restoreAllMocks(); }
});
