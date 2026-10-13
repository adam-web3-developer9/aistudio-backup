import { expect, test } from 'vitest';
import { MioraDiagnosticSink, mioraDiagnostic, mioraSourceIdentity, safeMioraDiagnosticFields, withMioraDiagnostics } from './miora-diagnostics.js';

test('Miora diagnostics exclude credentials, bodies, source paths and URL queries', () => {
  const fields = safeMioraDiagnosticFields({ requestId:'req-1', path:'/cos/sts-tokens?signature=secret',
    httpStatus:403, providerCode:'SignatureDoesNotMatch', elapsedMs:12,
    authorization:'Bearer SECRET', cookie:'SECRET', token:'SECRET', body:{secret:'SECRET'},
    sourceUrl:'https://source.invalid/SECRET?token=SECRET', headers:{cookie:'SECRET'},
    error:new Error('SECRET'), code:'SECRET\nforged', taskId:'https://signed.invalid/?SECRET' });
  expect(fields).toEqual({ requestId:'req-1', path:'/cos/sts-tokens', httpStatus:403,
    providerCode:'SignatureDoesNotMatch', elapsedMs:12 });
  expect(JSON.stringify(fields)).not.toContain('SECRET');
  expect(mioraSourceIdentity('https://source.invalid/object?token=one'))
    .toBe(mioraSourceIdentity('https://source.invalid/object?token=two'));
});

test('concurrent asynchronous Miora contexts retain their own request and item identity', async () => {
  const records: Record<string, unknown>[] = [];
  const sink = new MioraDiagnosticSink({ info:fields => { records.push(fields); } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = withMioraDiagnostics(sink, { requestId:'req-a', uploadIntentId:'upload-a' }, async () => {
    await gate;
    await withMioraDiagnostics(sink, { itemIndex:2 }, async () => { await Promise.resolve(); mioraDiagnostic('miora.transfer.finished', { outcome:'failed' }); });
  });
  await withMioraDiagnostics(sink, { requestId:'req-b', uploadIntentId:'upload-b' }, async () => {
    mioraDiagnostic('miora.transfer.finished', { outcome:'succeeded' });
    release();
  });
  await first;
  sink.flush();
  expect(records).toEqual([
    { event:'miora.transfer.finished', requestId:'req-b', uploadIntentId:'upload-b', outcome:'succeeded' },
    { event:'miora.transfer.finished', requestId:'req-a', uploadIntentId:'upload-a', itemIndex:2, outcome:'failed' }
  ]);
});

test('bounded asynchronous Miora logging preserves newest failure and reports overflow and sink failure', () => {
  const records: Record<string, unknown>[] = [];
  let fail = true;
  const sink = new MioraDiagnosticSink({ info:fields => {
    if (fail) { fail = false; throw new Error('sink failure'); }
    records.push(fields);
  } }, 2);
  sink.emit('miora.transfer.started');
  sink.flush();
  sink.emit('miora.transfer.source_fetch');
  sink.emit('miora.transfer.cos_put');
  sink.emit('miora.transfer.finished', { outcome:'failed' });
  expect(records).toHaveLength(0);
  sink.flush();
  expect(records).toEqual([
    { event:'miora.diagnostics.dropped', dropped:1, sinkFailures:1 },
    { event:'miora.transfer.cos_put' },
    { event:'miora.transfer.finished', outcome:'failed' }
  ]);
});
