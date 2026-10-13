import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MioraUploadIntentStore } from './miora-upload-intents.js';

const asset = { sha256: 'a'.repeat(64), size: 12, mimeType: 'image/png', kind: 'image' as const };

describe('Miora upload intents', () => {
  it('keeps cache account-scoped and consumes one stable job only once', () => {
    const db = new Database(':memory:');
    const store = new MioraUploadIntentStore(db, 'x'.repeat(32));
    const id = store.create('task:attempt:manifest', 'account-a', [{ ...asset, index: 0, cosKey: 'prefix/a.png', status: 'upload_required' }]);
    store.assignUploadKey(id, 0, 'rotated-prefix/a.png');
    store.complete(id, [0]);
    // A client PUT is existence/size checked by the route, but its content hash is not independently proven.
    expect(store.cached('account-a', asset)).toBeUndefined();
    expect(store.cached('account-b', asset)).toBeUndefined();
    expect(store.consume(id, 'job_gateway_one')).toMatchObject({ accountId: 'account-a', jobId: 'job_gateway_one' });
    expect(store.consume(id, 'job_gateway_one').references).toEqual([{ key: 'rotated-prefix/a.png', kind: 'image' }]);
    expect(() => store.consume(id, 'job_gateway_two')).toThrow(/already consumed/i);
  });

  it('returns the same intent for one idempotency key', () => {
    const db = new Database(':memory:');
    const store = new MioraUploadIntentStore(db, 'y'.repeat(32));
    const id = store.create('stable-key-123456', 'account-a', [{ ...asset, index: 0, cosKey: 'prefix/a.png', status: 'ready' }]);
    expect(store.findByIdempotencyKey('stable-key-123456')).toBe(id);
  });

  it('atomically subtracts live reservations before selecting an account', () => {
    const db = new Database(':memory:');
    const store = new MioraUploadIntentStore(db, 'z'.repeat(32));
    const candidates = [
      { accountId:'account-a', credits:100, activeJobs:0 },
      { accountId:'account-b', credits:100, activeJobs:0 }
    ];
    const first = store.createReserved('reserved-key-0001', candidates, 70,
      { modelId:'minimax-h3', durationSeconds:10 }, [asset]);
    const second = store.createReserved('reserved-key-0002', candidates, 70,
      { modelId:'minimax-h3', durationSeconds:10 }, [asset]);

    expect(first.accountId).toBe('account-a');
    expect(second.accountId).toBe('account-b');
    expect(store.reservedCredits('account-a')).toBe(70);
    store.assignUploadKey(first.id, 0, 'prefix/a.png');
    store.complete(first.id, [0]);
    store.consume(first.id, 'job_gateway_reserved');
    // Covers the tiny handoff between durable job creation and AccountPool.acquire().
    expect(store.reservedCredits('account-a')).toBe(70);
    expect(() => store.createReserved('reserved-key-0003', candidates, 70,
      { modelId:'minimax-h3', durationSeconds:10 }, [asset])).toThrow(/unreserved credits/i);
    store.releaseReservationForJob('job_gateway_reserved');
    expect(store.reservedCredits('account-a')).toBe(0);
    expect(store.createReserved('reserved-key-0003', candidates, 70,
      { modelId:'minimax-h3', durationSeconds:10 }, [asset]).accountId).toBe('account-a');
  });

  it('adds reservation columns to an existing upload-intent table', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE video_gateway_upload_intents(
      id TEXT PRIMARY KEY,key_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL,account_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,consumed_job_id TEXT,created_at TEXT NOT NULL
    )`);
    expect(() => new MioraUploadIntentStore(db, 'm'.repeat(32))).not.toThrow();
    const columns = db.prepare('PRAGMA table_info(video_gateway_upload_intents)').all() as Array<{name:string}>;
    expect(columns.map(column => column.name)).toEqual(expect.arrayContaining(['reserved_credits', 'reservation_until', 'options_json']));
  });

  it('never turns an unreadable balance into a pool-out-of-credits verdict', () => {
    const db = new Database(':memory:');
    const store = new MioraUploadIntentStore(db, 'u'.repeat(32));
    expect(() => store.createReserved('unknown-balance-1', [
      { accountId:'unknown', credits:undefined, activeJobs:0 },
      { accountId:'low', credits:20, activeJobs:0 }
    ], 70, { durationSeconds:10 }, [asset])).toThrow(/could not be confirmed/i);
  });

  it('persists a safe typed import failure and resumes only failed public items', () => {
    const db = new Database(':memory:');
    const store = new MioraUploadIntentStore(db, 'f'.repeat(32));
    const publicAsset = { ...asset, publicUrl:'https://media.invalid/signed?secret=hidden' };
    const created = store.createReserved('failed-import-0001', [{ accountId:'account-a', credits:100, activeJobs:0 }],
      10, { durationSeconds:10 }, [publicAsset, { ...asset, sha256:'b'.repeat(64) }]);
    store.importFailed(created.id, 0, { code:'SOURCE_FETCH_HTTP', stage:'source_fetch', retryable:true, httpStatus:503 });
    expect(store.describe(created.id).items[0]?.error).toEqual({
      code:'UPLOAD_IMPORT_FAILED', reason:'SOURCE_FETCH_HTTP', stage:'source_fetch', retryable:true, httpStatus:503
    });
    const stored = db.prepare('SELECT error FROM video_gateway_upload_items WHERE intent_id=? AND idx=0')
      .get(created.id) as { error:string };
    expect(stored.error).not.toContain('media.invalid');
    expect(stored.error).not.toContain('secret');
    store.importFailed(created.id, 0, { code:'COS_PUT_HTTP', stage:'cos_put', retryable:false, httpStatus:403,
      cosCode:'SignatureDoesNotMatch', cosRequestId:'cos-123' });
    expect(store.describe(created.id).items[0]?.error).toEqual({
      code:'UPLOAD_IMPORT_FAILED', reason:'COS_PUT_HTTP', stage:'cos_put', retryable:false, httpStatus:403,
      cosCode:'SignatureDoesNotMatch', cosRequestId:'cos-123'
    });
    expect(store.resume(created.id, [publicAsset, { ...asset, sha256:'b'.repeat(64) }]).map(item => item.idx)).toEqual([0]);
    expect(store.plan(created.id).items.map(item => item.status)).toEqual(['importing', 'upload_required']);
  });
});
