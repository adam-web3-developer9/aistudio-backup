import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { mioraAccountFromExport } from '../jobs/miora-import.js';
import { parseMioraAccounts } from '../jobs/miora-accounts.js';
import { tokenExpiresAt, mioraTokenCookies, type MioraTokens } from '../adapters/miora-api.js';
import { SystemError } from '../system/types.js';
import type { SessionRecord } from '../types.js';

export interface ChannelAccountRow { id: string; label: string; email: string | null; enabled: number; archived_at: string | null; updated_at: string; expires_at: string | null; encrypted: string }
type Row = ChannelAccountRow;
interface CreditRow { credits: number | null; checked_at: string | null; status: 'unknown' | 'ok' | 'error'; error_code: string | null }
export interface ChannelStatistics {
  total:number; enabled:number; disabled:number; archived:number;
  usable:number|null; usableCredits:number|null; unchecked:number; failed:number;
  lowCredit:number|null; minimumCredits:number|null; minimumVideoCount:number|null; lastCheckedAt:string|null;
}
export class ChannelStore {
  private key?: Buffer;
  constructor(public db: Database.Database, key?: string) {
    if (key) { this.key = Buffer.from(key, 'base64'); if (this.key.length !== 32 || this.key.toString('base64') !== key) throw new Error('CHANNEL_CREDENTIAL_KEY must be canonical base64 encoding of 32 bytes'); }
    db.exec(`CREATE TABLE IF NOT EXISTS managed_channel_accounts(id TEXT PRIMARY KEY,label TEXT NOT NULL,email TEXT,enabled INTEGER NOT NULL,archived_at TEXT,updated_at TEXT NOT NULL,expires_at TEXT,encrypted TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS managed_channel_credits(account_id TEXT PRIMARY KEY,credits REAL,checked_at TEXT,status TEXT NOT NULL,error_code TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS managed_channel_cleanup(account_id TEXT PRIMARY KEY,reason TEXT NOT NULL)`);
  }
  private requireKey() { if (!this.key) throw new SystemError(503, 'CHANNEL_VAULT_UNAVAILABLE', 'Channel credential vault is not configured'); return this.key; }
  private encrypt(id: string, tokens: MioraTokens) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv); cipher.setAAD(Buffer.from(id)); const body = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'); }
  private decrypt(row: Row): MioraTokens { try { const data = Buffer.from(row.encrypted, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.requireKey(), data.subarray(0,12)); decipher.setAAD(Buffer.from(row.id)); decipher.setAuthTag(data.subarray(12,28)); return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()) as MioraTokens; } catch { throw new SystemError(503, 'CHANNEL_VAULT_UNAVAILABLE', 'Channel credentials are unavailable'); } }
  row(id: string) { return this.db.prepare('SELECT * FROM managed_channel_accounts WHERE id=?').get(id) as Row | undefined; }
  public(row: Row) { const emailMasked = row.email ? row.email.replace(/^(.).+(@.*)$/, '$1***$2') : null; const credit=this.db.prepare('SELECT * FROM managed_channel_credits WHERE account_id=?').get(row.id) as CreditRow|undefined; return { id: row.id, provider: 'miora', label: row.label, emailMasked, enabled: !!row.enabled, archivedAt: row.archived_at, updatedAt: row.updated_at, credentialExpiresAt: row.expires_at, validationStatus: 'unknown', localCredentialStatus: row.expires_at && row.expires_at < new Date().toISOString() ? 'expired' : 'imported', credits:credit?.credits??null,creditsCheckedAt:credit?.checked_at??null,creditStatus:credit?.status??'unknown',lastErrorCode:credit?.error_code??null,cleanupReason:(this.db.prepare('SELECT reason FROM managed_channel_cleanup WHERE account_id=?').get(row.id) as {reason:string}|undefined)?.reason??null }; }
  list(page=1,pageSize=50,q='',minimumCredits?:number|null) {
    const match=`instr(lower(a.id || ' ' || a.label || ' ' || coalesce(a.email,'')),lower(?))>0`;
    const funded=`a.enabled=1 AND a.archived_at IS NULL AND c.status='ok' AND c.credits>0`;
    const rows=this.db.prepare(`SELECT a.* FROM managed_channel_accounts a LEFT JOIN managed_channel_credits c ON c.account_id=a.id WHERE ${match}
      ORDER BY CASE WHEN ${funded} THEN 0 WHEN a.enabled=1 AND a.archived_at IS NULL THEN 1 WHEN a.archived_at IS NULL THEN 2 ELSE 3 END,
      CASE WHEN ${funded} THEN c.credits END DESC,a.updated_at DESC,a.id ASC LIMIT ? OFFSET ?`).all(q,pageSize,(page-1)*pageSize) as Row[];
    const total=(this.db.prepare(`SELECT count(*) AS n FROM managed_channel_accounts a WHERE ${match}`).get(q) as {n:number}).n;
    return {data:rows.map(row=>this.public(row)),total,statistics:this.statistics(minimumCredits)};
  }
  statistics(minimumCredits?:number|null):ChannelStatistics {
    const minimum=typeof minimumCredits==='number'&&Number.isFinite(minimumCredits)&&minimumCredits>0?minimumCredits:null;
    const usable=`a.enabled=1 AND a.archived_at IS NULL AND c.status='ok' AND c.credits>=@minimum`;
    // Round only binary division noise before truncating each account's estimate.
    // Credits cannot be transferred between accounts, so never divide their sum.
    const aggregate=this.db.prepare(`SELECT count(*) AS total,
      count(CASE WHEN a.enabled=1 AND a.archived_at IS NULL THEN 1 END) AS enabled,
      count(CASE WHEN a.enabled=0 AND a.archived_at IS NULL THEN 1 END) AS disabled,
      count(CASE WHEN a.archived_at IS NOT NULL THEN 1 END) AS archived,
      CASE WHEN @minimum IS NULL THEN NULL ELSE count(CASE WHEN ${usable} THEN 1 END) END AS usable,
      CASE WHEN @minimum IS NULL THEN NULL ELSE round(coalesce(sum(CASE WHEN ${usable} THEN c.credits END),0),2) END AS usableCredits,
      count(CASE WHEN a.archived_at IS NULL AND coalesce(c.status,'unknown')='unknown' THEN 1 END) AS unchecked,
      count(CASE WHEN a.archived_at IS NULL AND c.status='error' THEN 1 END) AS failed,
      CASE WHEN @minimum IS NULL THEN NULL ELSE count(CASE WHEN a.archived_at IS NULL AND c.status='ok' AND c.credits<@minimum THEN 1 END) END AS lowCredit,
      CASE WHEN @minimum IS NULL THEN NULL ELSE coalesce(sum(CASE WHEN ${usable} THEN CAST(round(c.credits/@minimum,10) AS INTEGER) END),0) END AS minimumVideoCount,
      max(c.checked_at) AS lastCheckedAt
      FROM managed_channel_accounts a LEFT JOIN managed_channel_credits c ON c.account_id=a.id`).get({minimum}) as Omit<ChannelStatistics,'minimumCredits'>;
    return {...aggregate,minimumCredits:minimum};
  }
  ids() { return (this.db.prepare('SELECT id FROM managed_channel_accounts WHERE archived_at IS NULL ORDER BY updated_at').all() as {id:string}[]).map(row=>row.id); }
  creditSummary(ids?:readonly string[]) {
    const selected=[...new Set(ids??this.ids())];
    let succeeded=0;
    for(const id of selected){
      if(!this.row(id))throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account is unavailable');
      const credit=this.db.prepare('SELECT status FROM managed_channel_credits WHERE account_id=?').get(id) as Pick<CreditRow,'status'>|undefined;
      if(credit?.status==='ok')succeeded++;
    }
    return {checked:selected.length,succeeded,failed:selected.length-succeeded};
  }
  credentials(id:string) { const row=this.row(id); if(!row)throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account is unavailable');return {row,tokens:this.decrypt(row)}; }
  recordCredits(id:string,encrypted:string,result:{credits:number;checkedAt:string}|{errorCode:string}):boolean {
    if(this.row(id)?.encrypted!==encrypted)return false;
    if('credits' in result){if(!Number.isFinite(result.credits)||result.credits<0)throw new SystemError(400,'INVALID_CREDIT_RESPONSE','Provider balance is invalid');this.db.prepare("INSERT INTO managed_channel_credits VALUES(?,?,?,'ok',NULL) ON CONFLICT(account_id) DO UPDATE SET credits=excluded.credits,checked_at=excluded.checked_at,status='ok',error_code=NULL").run(id,result.credits,result.checkedAt);}
    else this.db.prepare("INSERT INTO managed_channel_credits VALUES(?,NULL,NULL,'error',?) ON CONFLICT(account_id) DO UPDATE SET status='error',error_code=excluded.error_code").run(id,result.errorCode);
    return true;
  }
  archiveIfCurrent(expected:Row,reason:'insufficient-credits'|'credentials-expired'):boolean { return this.db.transaction(()=>{const changed=this.db.prepare('UPDATE managed_channel_accounts SET enabled=0,archived_at=?,updated_at=? WHERE id=? AND encrypted=? AND updated_at=? AND archived_at IS NULL').run(new Date().toISOString(),new Date().toISOString(),expected.id,expected.encrypted,expected.updated_at).changes===1;if(changed)this.db.prepare('INSERT INTO managed_channel_cleanup VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET reason=excluded.reason').run(expected.id,reason);return changed;})(); }
  renewIfCurrent(id:string,encrypted:string,tokens:MioraTokens):boolean { const expiry=tokenExpiresAt(tokens.authToken);return this.db.prepare('UPDATE managed_channel_accounts SET encrypted=?,updated_at=?,expires_at=? WHERE id=? AND encrypted=?').run(this.encrypt(id,tokens),new Date().toISOString(),expiry===undefined?null:new Date(expiry).toISOString(),id,encrypted).changes===1; }
  import(credentials: string, label?: string, expectedId?: string) {
    this.requireKey(); let value: unknown; try { value=JSON.parse(credentials); } catch { value=null; }
    const imported = value ? mioraAccountFromExport(value) : undefined;
    // Plain account JSON owns its refresh token and cookie fields; browser-export
    // detection scans text and must only be used after that structured format.
    const parsed = parseMioraAccounts(credentials).accounts[0] ?? imported;
    const tokens=parsed?.tokens;
    if (!tokens?.authToken || tokens.authToken.length>16384 || /[\r\n]/.test(tokens.cookie ?? '') || tokens.authToken.split('.').length!==3) throw new SystemError(400,'INVALID_CREDENTIALS','A valid Miora export or token is required');
    let subject: string; try { const claims=JSON.parse(Buffer.from(tokens.authToken.split('.')[1]!, 'base64url').toString()); subject=String(claims.sub ?? claims.userId ?? claims.id ?? parsed?.email ?? ''); } catch { subject=''; }
    if (!subject) throw new SystemError(400,'INVALID_CREDENTIALS','Credential account identity is missing');
    const id='managed-miora-'+createHash('sha256').update(subject).digest('hex').slice(0,24);
    if (expectedId && expectedId!==id) throw new SystemError(400,'ACCOUNT_MISMATCH','Credential belongs to another account');
    const current=this.row(id); const expiry=tokenExpiresAt(tokens.authToken); const expiresAt=expiry ? new Date(expiry).toISOString():null;
    const updatedAt=new Date().toISOString();
    this.db.prepare(`INSERT INTO managed_channel_accounts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,email=excluded.email,updated_at=excluded.updated_at,expires_at=excluded.expires_at,encrypted=excluded.encrypted`).run(id,label ?? current?.label ?? 'Miora',parsed?.email ?? null,current?.enabled ?? 1,current?.archived_at ?? null,updatedAt,expiresAt,this.encrypt(id,tokens));
    this.db.prepare("UPDATE managed_channel_credits SET status='unknown',error_code=NULL WHERE account_id=?").run(id);
    return this.public(this.row(id)!);
  }
  update(id: string, changes: {label?:string;enabled?:boolean;archived?:boolean}) { const row=this.row(id); if(!row)throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account is unavailable'); this.db.prepare('UPDATE managed_channel_accounts SET label=?,enabled=?,archived_at=?,updated_at=? WHERE id=?').run(changes.label ?? row.label,changes.archived===true?0:changes.enabled===undefined?row.enabled:Number(changes.enabled),changes.archived===undefined?row.archived_at:changes.archived?new Date().toISOString():null,new Date().toISOString(),id);if(changes.archived===true)this.db.prepare('INSERT INTO managed_channel_cleanup VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET reason=excluded.reason').run(id,'manual');if(changes.archived===false)this.db.prepare('DELETE FROM managed_channel_cleanup WHERE account_id=?').run(id);return this.public(this.row(id)!); }
  session(id: string): SessionRecord | undefined { const row=this.row(id); if (!row) return; return {id,adapterId:'miora-v1',cookies:mioraTokenCookies(this.decrypt(row)),updatedAt:row.updated_at}; }
  sessions() { return (this.db.prepare('SELECT * FROM managed_channel_accounts WHERE enabled=1 AND archived_at IS NULL').all() as Row[]).map(row=>this.session(row.id)!); }
  renew(id: string,tokens:MioraTokens) { const row=this.row(id); if (!row) return; this.renewIfCurrent(id,row.encrypted,tokens); }
}
