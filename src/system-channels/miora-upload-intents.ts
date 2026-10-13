import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SystemError } from '../system/types.js';
import type { JobOptions } from '../types.js';

export type UploadItemKind = 'image' | 'video' | 'audio';
export type UploadItemStatus = 'ready' | 'upload_required' | 'importing' | 'failed';

export interface UploadIntentAssetInput {
  sha256: string;
  size: number;
  mimeType: string;
  kind: UploadItemKind;
  fileName?: string;
  publicUrl?: string;
}

export interface PreparedUploadItem extends UploadIntentAssetInput {
  index: number;
  cosKey: string;
  status: UploadItemStatus;
  upload?: { method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: string };
  error?: UploadImportFailure;
}

export interface UploadImportFailure extends MioraTransferFailure {
  code: 'UPLOAD_IMPORT_FAILED';
  reason: string;
}

interface MioraTransferFailure {
  code: string;
  stage: 'source_fetch' | 'source_verify' | 'cos_grant' | 'cos_put' | 'internal';
  retryable: boolean;
  httpStatus?: number;
  networkCode?: string;
}

interface IntentRow { id:string; key_hash:string; idempotency_key:string; account_id:string; expires_at:string; consumed_job_id:string|null; created_at:string; reserved_credits:number|null; reservation_until:string|null; options_json:string|null }
export interface UploadIntentAccountCandidate { accountId:string; credits?:number; activeJobs:number }
export interface UploadIntentItemRow { intent_id:string; idx:number; sha256:string; size:number; mime_type:string; kind:UploadItemKind; file_name:string|null; cos_key:string; status:UploadItemStatus; source_url:string|null; error:string|null }

export class MioraUploadIntentStore {
  private readonly keyHash: string;
  constructor(private readonly db: Database.Database, apiKey: string) {
    this.keyHash = createHash('sha256').update(apiKey).digest('hex');
    db.exec(`
      CREATE TABLE IF NOT EXISTS video_gateway_upload_intents(
        id TEXT PRIMARY KEY,key_hash TEXT NOT NULL,idempotency_key TEXT NOT NULL,account_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,consumed_job_id TEXT,created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS video_gateway_upload_intents_idempotency
        ON video_gateway_upload_intents(key_hash,idempotency_key);
      CREATE TABLE IF NOT EXISTS video_gateway_upload_items(
        intent_id TEXT NOT NULL,idx INTEGER NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,kind TEXT NOT NULL,file_name TEXT,cos_key TEXT NOT NULL,
        status TEXT NOT NULL,source_url TEXT,error TEXT,PRIMARY KEY(intent_id,idx)
      );
      CREATE TABLE IF NOT EXISTS video_gateway_miora_cos_cache(
        account_id TEXT NOT NULL,sha256 TEXT NOT NULL,size INTEGER NOT NULL,mime_type TEXT NOT NULL,
        kind TEXT NOT NULL,cos_key TEXT NOT NULL,verified_at TEXT NOT NULL,last_used_at TEXT NOT NULL,
        PRIMARY KEY(account_id,sha256,size,mime_type,kind)
      );
    `);
    this.ensureColumn('video_gateway_upload_intents', 'reserved_credits', 'REAL');
    this.ensureColumn('video_gateway_upload_intents', 'reservation_until', 'TEXT');
    this.ensureColumn('video_gateway_upload_intents', 'options_json', 'TEXT');
  }

  cached(accountId: string, asset: UploadIntentAssetInput): string | undefined {
    const row = this.db.prepare(`SELECT cos_key FROM video_gateway_miora_cos_cache
      WHERE account_id=? AND sha256=? AND size=? AND mime_type=? AND kind=?`)
      .get(accountId, asset.sha256, asset.size, asset.mimeType, asset.kind) as {cos_key:string}|undefined;
    if (row) this.db.prepare(`UPDATE video_gateway_miora_cos_cache SET last_used_at=?
      WHERE account_id=? AND sha256=? AND size=? AND mime_type=? AND kind=?`)
      .run(new Date().toISOString(), accountId, asset.sha256, asset.size, asset.mimeType, asset.kind);
    return row?.cos_key;
  }

  findByIdempotencyKey(key: string): string | undefined {
    return (this.db.prepare('SELECT id FROM video_gateway_upload_intents WHERE key_hash=? AND idempotency_key=?')
      .get(this.keyHash, key) as {id:string}|undefined)?.id;
  }

  createOrGet(idempotencyKey: string, accountId: string, items: PreparedUploadItem[], ttlMs = 15 * 60_000): { id:string; created:boolean } {
    const id = `upload_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    return this.db.transaction(() => {
      const existing = this.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        this.assertManifest(existing, items);
        return { id: existing, created: false };
      }
      this.db.prepare(`INSERT INTO video_gateway_upload_intents
        (id,key_hash,idempotency_key,account_id,expires_at,consumed_job_id,created_at,reserved_credits,reservation_until,options_json)
        VALUES(?,?,?,?,?,NULL,?,NULL,NULL,NULL)`)
        .run(id, this.keyHash, idempotencyKey, accountId, expiresAt, createdAt);
      const insert = this.db.prepare(`INSERT INTO video_gateway_upload_items
        (intent_id,idx,sha256,size,mime_type,kind,file_name,cos_key,status,source_url,error)
        VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`);
      for (const item of items) insert.run(id, item.index, item.sha256, item.size, item.mimeType,
        item.kind, item.fileName ?? null, item.cosKey, item.status, item.publicUrl ?? null);
      return { id, created: true };
    })();
  }

  create(idempotencyKey: string, accountId: string, items: PreparedUploadItem[], ttlMs = 15 * 60_000): string {
    return this.createOrGet(idempotencyKey, accountId, items, ttlMs).id;
  }

  /**
   * Atomically chooses an account after subtracting every live, unconsumed
   * upload-intent reservation, then persists this intent's own reservation.
   * Existing idempotency keys remain stable and never reserve twice.
   */
  createReserved(
    idempotencyKey: string,
    candidates: UploadIntentAccountCandidate[],
    requiredCredits: number | undefined,
    options: JobOptions | undefined,
    assets: UploadIntentAssetInput[],
    ttlMs = 15 * 60_000
  ): { id:string; created:boolean; accountId:string } {
    const id = `upload_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    return this.db.transaction(() => {
      const existingId = this.findByIdempotencyKey(idempotencyKey);
      if (existingId) {
        this.assertManifest(existingId, assets.map((asset, index) => ({ ...asset, index, cosKey:'', status:'upload_required' })));
        const existing = this.owned(existingId);
        return { id:existingId, created:false, accountId:existing.account_id };
      }

      const required = requiredCredits ?? 0;
      const selected = candidates.map(candidate => ({
        ...candidate,
        available: (candidate.credits ?? -1) - this.reservedCredits(candidate.accountId)
      })).filter(candidate => candidate.credits !== undefined && candidate.available >= required)
        .sort((left, right) => left.activeJobs - right.activeJobs
          || (requiredCredits === undefined ? right.available - left.available : left.available - right.available)
          || left.accountId.localeCompare(right.accountId))[0];
      if (!selected) {
        if (candidates.some(candidate => candidate.credits === undefined)) {
          throw new SystemError(503, 'ACCOUNT_BALANCE_UNAVAILABLE', 'One or more enabled Miora account balances could not be confirmed');
        }
        throw new SystemError(409, 'INSUFFICIENT_CREDITS', 'No enabled Miora account has enough unreserved credits for this job');
      }

      this.db.prepare(`INSERT INTO video_gateway_upload_intents
        (id,key_hash,idempotency_key,account_id,expires_at,consumed_job_id,created_at,reserved_credits,reservation_until,options_json)
        VALUES(?,?,?,?,?,NULL,?,?,?,?)`)
        .run(id, this.keyHash, idempotencyKey, selected.accountId, expiresAt, createdAt,
          requiredCredits ?? null, expiresAt, options ? JSON.stringify(options) : null);
      const insert = this.db.prepare(`INSERT INTO video_gateway_upload_items
        (intent_id,idx,sha256,size,mime_type,kind,file_name,cos_key,status,source_url,error)
        VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`);
      for (const [index, asset] of assets.entries()) {
        const cached = this.cached(selected.accountId, asset);
        insert.run(id, index, asset.sha256, asset.size, asset.mimeType, asset.kind, asset.fileName ?? null,
          cached ?? '', cached ? 'ready' : asset.publicUrl ? 'importing' : 'upload_required', asset.publicUrl ?? null);
      }
      return { id, created:true, accountId:selected.accountId };
    })();
  }

  /** Live reservations for an account, excluding one intent during its own submit validation. */
  reservedCredits(accountId: string, excludingIntentId?: string): number {
    const row = this.db.prepare(`SELECT COALESCE(SUM(reserved_credits),0) total
      FROM video_gateway_upload_intents
      WHERE key_hash=? AND account_id=? AND reservation_until>?
        AND reserved_credits IS NOT NULL AND (? IS NULL OR id<>?)`)
      .get(this.keyHash, accountId, new Date().toISOString(), excludingIntentId ?? null, excludingIntentId ?? null) as {total:number};
    return Number(row.total) || 0;
  }

  /** Release the durable handoff reservation only after AccountPool holds its lease. */
  releaseReservationForJob(jobId: string): void {
    this.db.prepare(`UPDATE video_gateway_upload_intents SET reservation_until=NULL
      WHERE key_hash=? AND consumed_job_id=?`).run(this.keyHash, jobId);
  }

  describe(id: string) {
    const intent = this.owned(id);
    const items = this.rows(id).map(row => ({ index: row.idx, status: row.status,
      ...(row.error ? { error: this.publicFailure(row.error) } : {}) }));
    return { id, expiresAt: intent.expires_at,
      status: intent.consumed_job_id ? 'consumed' : items.every(item => item.status === 'ready') ? 'ready'
        : items.some(item => item.status === 'failed') ? 'failed' : 'preparing',
      ...(intent.consumed_job_id ? { jobId: intent.consumed_job_id } : {}), items };
  }

  pendingImports(id: string): UploadIntentItemRow[] { this.owned(id); return this.rows(id).filter(row => row.status === 'importing'); }

  plan(id: string): { accountId:string; expiresAt:string; consumedJobId?:string; items:UploadIntentItemRow[] } {
    const intent = this.owned(id);
    return { accountId: intent.account_id, expiresAt: intent.expires_at,
      ...(intent.consumed_job_id ? { consumedJobId: intent.consumed_job_id } : {}), items: this.rows(id) };
  }

  resume(id: string, assets: UploadIntentAssetInput[], ttlMs = 15 * 60_000): UploadIntentItemRow[] {
    return this.db.transaction(() => {
      const intent = this.owned(id);
      this.assertManifest(id, assets.map((asset, index) => ({ ...asset, index, cosKey: '', status: 'upload_required' })));
      if (intent.consumed_job_id) return [];
      if (Date.parse(intent.expires_at) <= Date.now()) {
        this.db.prepare('UPDATE video_gateway_upload_intents SET expires_at=? WHERE id=? AND key_hash=?')
          .run(new Date(Date.now() + ttlMs).toISOString(), id, this.keyHash);
      }
      this.db.prepare("UPDATE video_gateway_upload_items SET status='importing',error=NULL WHERE intent_id=? AND status='failed' AND source_url IS NOT NULL")
        .run(id);
      return this.rows(id).filter(row => row.status === 'importing');
    })();
  }

  directUploadItems(id: string, indexes: number[]): { accountId:string; items:UploadIntentItemRow[] } {
    const intent = this.active(id);
    const items = indexes.map(index => this.item(id, index));
    for (const item of items) if (item.status !== 'upload_required' && item.status !== 'ready') {
      throw new SystemError(409, 'UPLOAD_ITEM_NOT_COMPLETABLE', `Upload item ${item.idx} is not awaiting a direct upload`);
    }
    return { accountId: intent.account_id, items: items.filter(item => item.status === 'upload_required') };
  }

  assignUploadKey(id: string, index: number, key: string): void {
    this.active(id);
    const item = this.item(id, index);
    if (item.status !== 'upload_required') throw new SystemError(409, 'UPLOAD_ITEM_NOT_SIGNABLE', `Upload item ${index} is not awaiting a direct upload`);
    this.db.prepare('UPDATE video_gateway_upload_items SET cos_key=? WHERE intent_id=? AND idx=?')
      .run(key, id, index);
  }

  complete(id: string, indexes: number[]): void {
    const intent = this.active(id);
    this.db.transaction(() => {
      for (const index of indexes) {
        const item = this.item(id, index);
        if (item.status === 'ready') continue;
        if (item.status !== 'upload_required') throw new SystemError(409, 'UPLOAD_ITEM_NOT_COMPLETABLE', `Upload item ${index} is not awaiting a direct upload`);
        this.ready(intent.account_id, item, false);
      }
    })();
  }

  importReady(id: string, index: number, key: string): void {
    const intent = this.active(id); const item = this.item(id, index);
    if (item.status === 'ready') return;
    if (item.status !== 'importing') throw new SystemError(409, 'UPLOAD_ITEM_NOT_IMPORTING', `Upload item ${index} is not being imported`);
    this.db.prepare('UPDATE video_gateway_upload_items SET cos_key=? WHERE intent_id=? AND idx=?').run(key, id, index);
    this.ready(intent.account_id, { ...item, cos_key: key }, true);
  }

  importFailed(id: string, index: number, failure: MioraTransferFailure): void {
    this.owned(id);
    this.db.prepare('UPDATE video_gateway_upload_items SET status=?,error=? WHERE intent_id=? AND idx=?')
      .run('failed', JSON.stringify({ code:'UPLOAD_IMPORT_FAILED', reason:failure.code, stage:failure.stage,
        retryable:failure.retryable, ...(failure.httpStatus !== undefined ? { httpStatus:failure.httpStatus } : {}),
        ...(failure.networkCode ? { networkCode:failure.networkCode } : {}) } satisfies UploadImportFailure), id, index);
  }

  consume(id: string, jobId: string): { accountId:string; jobId:string; references:Array<{key:string;kind:UploadItemKind}> } {
    return this.db.transaction(() => {
      const intent = this.owned(id);
      if (intent.consumed_job_id && intent.consumed_job_id !== jobId) throw new SystemError(409, 'UPLOAD_INTENT_CONSUMED', 'Upload intent was already consumed');
      if (!intent.consumed_job_id && Date.parse(intent.expires_at) <= Date.now()) throw new SystemError(410, 'UPLOAD_INTENT_EXPIRED', 'Upload intent expired');
      const items = this.rows(id);
      const unfinished = items.find(item => item.status !== 'ready');
      if (unfinished) throw new SystemError(409, 'UPLOAD_INTENT_NOT_READY', `Upload item ${unfinished.idx} is ${unfinished.status}`);
      if (!intent.consumed_job_id) this.db.prepare(`UPDATE video_gateway_upload_intents
        SET consumed_job_id=?,reservation_until=? WHERE id=? AND key_hash=?`)
        // Keep a conservative handoff reservation while the queued JobRunner
        // acquires its in-memory lease. The pool ledger takes over afterwards.
        .run(jobId, new Date(Date.now() + 15 * 60_000).toISOString(), id, this.keyHash);
      return { accountId: intent.account_id, jobId: intent.consumed_job_id ?? jobId,
        references: items.map(item => ({ key: item.cos_key, kind: item.kind })) };
    })();
  }

  readyForJob(id: string, jobId: string): { accountId:string; jobId:string; consumed:boolean; references:Array<{key:string;kind:UploadItemKind}> } {
    const intent = this.owned(id);
    if (intent.consumed_job_id && intent.consumed_job_id !== jobId) throw new SystemError(409, 'UPLOAD_INTENT_CONSUMED', 'Upload intent was already consumed');
    if (!intent.consumed_job_id && Date.parse(intent.expires_at) <= Date.now()) throw new SystemError(410, 'UPLOAD_INTENT_EXPIRED', 'Upload intent expired');
    const items = this.rows(id); const unfinished = items.find(item => item.status !== 'ready');
    if (unfinished) throw new SystemError(409, 'UPLOAD_INTENT_NOT_READY', `Upload item ${unfinished.idx} is ${unfinished.status}`);
    return { accountId:intent.account_id, jobId:intent.consumed_job_id ?? jobId, consumed:Boolean(intent.consumed_job_id),
      references:items.map(item => ({ key:item.cos_key, kind:item.kind })) };
  }

  private ready(accountId:string, item:UploadIntentItemRow, cache: boolean): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE video_gateway_upload_items SET status=?,error=NULL WHERE intent_id=? AND idx=?')
      .run('ready', item.intent_id, item.idx);
    if (!cache) return;
    this.db.prepare(`INSERT INTO video_gateway_miora_cos_cache
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,sha256,size,mime_type,kind)
      DO UPDATE SET cos_key=excluded.cos_key,verified_at=excluded.verified_at,last_used_at=excluded.last_used_at`)
      .run(accountId, item.sha256, item.size, item.mime_type, item.kind, item.cos_key, now, now);
  }
  private publicFailure(value:string):UploadImportFailure {
    try {
      const parsed = JSON.parse(value) as Partial<UploadImportFailure>;
      if (parsed.code === 'UPLOAD_IMPORT_FAILED' && typeof parsed.reason === 'string'
        && ['source_fetch','source_verify','cos_grant','cos_put','internal'].includes(parsed.stage ?? '')
        && typeof parsed.retryable === 'boolean') return {
          code:'UPLOAD_IMPORT_FAILED', reason:parsed.reason, stage:parsed.stage!, retryable:parsed.retryable,
          ...(Number.isInteger(parsed.httpStatus) ? { httpStatus:parsed.httpStatus } : {}),
          ...(typeof parsed.networkCode === 'string' ? { networkCode:parsed.networkCode } : {})
        };
    } catch { /* Legacy rows contain only UPLOAD_IMPORT_FAILED. */ }
    return { code:'UPLOAD_IMPORT_FAILED', reason:'INTERNAL_ERROR', stage:'internal', retryable:false };
  }
  private assertManifest(id:string, items:Array<Pick<PreparedUploadItem,'index'|'sha256'|'size'|'mimeType'|'kind'|'fileName'|'publicUrl'>>):void {
    const rows = this.rows(id);
    const mismatch = rows.length !== items.length || rows.some((row, index) => {
      const item = items[index];
      return !item || row.idx !== item.index || row.sha256 !== item.sha256 || row.size !== item.size
        || row.mime_type !== item.mimeType || row.kind !== item.kind || (row.file_name ?? undefined) !== item.fileName
        || (row.source_url ?? undefined) !== item.publicUrl;
    });
    if (mismatch) throw new SystemError(409, 'UPLOAD_INTENT_PAYLOAD_MISMATCH', 'Idempotency key was already used with another media manifest');
  }
  private item(id:string,index:number):UploadIntentItemRow { const row=this.db.prepare('SELECT * FROM video_gateway_upload_items WHERE intent_id=? AND idx=?').get(id,index) as UploadIntentItemRow|undefined; if(!row)throw new SystemError(404,'UPLOAD_ITEM_NOT_FOUND','Upload item is unavailable');return row; }
  private rows(id:string):UploadIntentItemRow[]{return this.db.prepare('SELECT * FROM video_gateway_upload_items WHERE intent_id=? ORDER BY idx').all(id) as UploadIntentItemRow[];}
  private owned(id:string):IntentRow { const row=this.db.prepare('SELECT * FROM video_gateway_upload_intents WHERE id=? AND key_hash=?').get(id,this.keyHash) as IntentRow|undefined;if(!row)throw new SystemError(404,'UPLOAD_INTENT_NOT_FOUND','Upload intent is unavailable');return row; }
  private active(id:string):IntentRow { const row=this.owned(id);if(row.consumed_job_id)throw new SystemError(409,'UPLOAD_INTENT_CONSUMED','Upload intent was already consumed');if(Date.parse(row.expires_at)<=Date.now())throw new SystemError(410,'UPLOAD_INTENT_EXPIRED','Upload intent expired');return row; }
  private ensureColumn(table:string,column:string,type:string):void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{name:string}>;
    if (!columns.some(item => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}
