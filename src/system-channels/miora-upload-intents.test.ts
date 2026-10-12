import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MioraUploadIntentStore } from './miora-upload-intents.js';

const asset = { sha256: 'a'.repeat(64), size: 12, mimeType: 'image/png', kind: 'image' as const };

describe('Miora upload intents', () => {
  it('keeps cache account-scoped and consumes one stable job only once', () => {
    const db = new Database(':memory:');
    const store = new MioraUploadIntentStore(db, 'x'.repeat(32));
    const id = store.create('task:attempt:manifest', 'account-a', [{ ...asset, index: 0, cosKey: 'prefix/a.png', status: 'upload_required' }]);
    store.complete(id, [0]);
    // A client PUT is existence/size checked by the route, but its content hash is not independently proven.
    expect(store.cached('account-a', asset)).toBeUndefined();
    expect(store.cached('account-b', asset)).toBeUndefined();
    expect(store.consume(id, 'job_gateway_one')).toMatchObject({ accountId: 'account-a', jobId: 'job_gateway_one' });
    expect(store.consume(id, 'job_gateway_one').references).toEqual([{ key: 'prefix/a.png', kind: 'image' }]);
    expect(() => store.consume(id, 'job_gateway_two')).toThrow(/already consumed/i);
  });

  it('returns the same intent for one idempotency key', () => {
    const db = new Database(':memory:');
    const store = new MioraUploadIntentStore(db, 'y'.repeat(32));
    const id = store.create('stable-key-123456', 'account-a', [{ ...asset, index: 0, cosKey: 'prefix/a.png', status: 'ready' }]);
    expect(store.findByIdempotencyKey('stable-key-123456')).toBe(id);
  });
});
