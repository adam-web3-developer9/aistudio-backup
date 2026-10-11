import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { mioraAccountFromExport } from '../jobs/miora-import.js';
import { parseMioraAccounts } from '../jobs/miora-accounts.js';
import { tokenExpiresAt, mioraTokenCookies, type MioraTokens } from '../adapters/miora-api.js';
import { SystemError } from '../system/types.js';
import type { SessionRecord } from '../types.js';

interface Row { id: string; label: string; email: string | null; enabled: number; archived_at: string | null; updated_at: string; expires_at: string | null; encrypted: string }
export class ChannelStore {
  private key?: Buffer;
  constructor(public db: Database.Database, key?: string) {
    if (key) { this.key = Buffer.from(key, 'base64'); if (this.key.length !== 32 || this.key.toString('base64') !== key) throw new Error('CHANNEL_CREDENTIAL_KEY must be canonical base64 encoding of 32 bytes'); }
    db.exec(`CREATE TABLE IF NOT EXISTS managed_channel_accounts(id TEXT PRIMARY KEY,label TEXT NOT NULL,email TEXT,enabled INTEGER NOT NULL,archived_at TEXT,updated_at TEXT NOT NULL,expires_at TEXT,encrypted TEXT NOT NULL)`);
  }
  private requireKey() { if (!this.key) throw new SystemError(503, 'CHANNEL_VAULT_UNAVAILABLE', 'Channel credential vault is not configured'); return this.key; }
  private encrypt(id: string, tokens: MioraTokens) { const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv); cipher.setAAD(Buffer.from(id)); const body = Buffer.concat([cipher.update(JSON.stringify(tokens)), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64'); }
  private decrypt(row: Row): MioraTokens { try { const data = Buffer.from(row.encrypted, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.requireKey(), data.subarray(0,12)); decipher.setAAD(Buffer.from(row.id)); decipher.setAuthTag(data.subarray(12,28)); return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString()) as MioraTokens; } catch { throw new SystemError(503, 'CHANNEL_VAULT_UNAVAILABLE', 'Channel credentials are unavailable'); } }
  row(id: string) { return this.db.prepare('SELECT * FROM managed_channel_accounts WHERE id=?').get(id) as Row | undefined; }
  public(row: Row) { const emailMasked = row.email ? row.email.replace(/^(.).+(@.*)$/, '$1***$2') : null; return { id: row.id, provider: 'miora', label: row.label, emailMasked, enabled: !!row.enabled, archivedAt: row.archived_at, updatedAt: row.updated_at, credentialExpiresAt: row.expires_at, validationStatus: 'unknown', localCredentialStatus: row.expires_at && row.expires_at < new Date().toISOString() ? 'expired' : 'imported', lastErrorCode: null }; }
  list(page=1,pageSize=50) { const rows=this.db.prepare('SELECT * FROM managed_channel_accounts ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(pageSize,(page-1)*pageSize) as Row[]; return {data:rows.map(row=>this.public(row)),total:(this.db.prepare('SELECT count(*) AS n FROM managed_channel_accounts').get() as {n:number}).n}; }
  import(credentials: string, label?: string, expectedId?: string) {
    this.requireKey(); let value: unknown; try { value=JSON.parse(credentials); } catch { value=null; }
    const imported = value ? mioraAccountFromExport(value) : undefined;
    const parsed = imported ?? parseMioraAccounts(credentials).accounts[0];
    const tokens=parsed?.tokens;
    if (!tokens?.authToken || tokens.authToken.length>16384 || /[\r\n]/.test(tokens.cookie ?? '') || tokens.authToken.split('.').length!==3) throw new SystemError(400,'INVALID_CREDENTIALS','A valid Miora export or token is required');
    let subject: string; try { const claims=JSON.parse(Buffer.from(tokens.authToken.split('.')[1]!, 'base64url').toString()); subject=String(claims.sub ?? claims.userId ?? claims.id ?? parsed?.email ?? ''); } catch { subject=''; }
    if (!subject) throw new SystemError(400,'INVALID_CREDENTIALS','Credential account identity is missing');
    const id='managed-miora-'+createHash('sha256').update(subject).digest('hex').slice(0,24);
    if (expectedId && expectedId!==id) throw new SystemError(400,'ACCOUNT_MISMATCH','Credential belongs to another account');
    const current=this.row(id); const expiry=tokenExpiresAt(tokens.authToken); const expiresAt=expiry ? new Date(expiry).toISOString():null;
    const updatedAt=new Date().toISOString();
    this.db.prepare(`INSERT INTO managed_channel_accounts VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,email=excluded.email,updated_at=excluded.updated_at,expires_at=excluded.expires_at,encrypted=excluded.encrypted`).run(id,label ?? current?.label ?? 'Miora',parsed?.email ?? null,current?.enabled ?? 0,current?.archived_at ?? null,updatedAt,expiresAt,this.encrypt(id,tokens));
    return this.public(this.row(id)!);
  }
  update(id: string, changes: {label?:string;enabled?:boolean;archived?:boolean}) { const row=this.row(id); if(!row)throw new SystemError(404,'ACCOUNT_UNAVAILABLE','Channel account is unavailable'); this.db.prepare('UPDATE managed_channel_accounts SET label=?,enabled=?,archived_at=?,updated_at=? WHERE id=?').run(changes.label ?? row.label,changes.archived===true?0:changes.enabled===undefined?row.enabled:Number(changes.enabled),changes.archived===undefined?row.archived_at:changes.archived?new Date().toISOString():null,new Date().toISOString(),id);return this.public(this.row(id)!); }
  session(id: string): SessionRecord | undefined { const row=this.row(id); if (!row) return; return {id,adapterId:'miora-v1',cookies:mioraTokenCookies(this.decrypt(row)),updatedAt:row.updated_at}; }
  sessions() { return (this.db.prepare('SELECT * FROM managed_channel_accounts WHERE enabled=1 AND archived_at IS NULL').all() as Row[]).map(row=>this.session(row.id)!); }
  renew(id: string,tokens:MioraTokens) { const row=this.row(id); if (!row) return; this.db.prepare('UPDATE managed_channel_accounts SET encrypted=?,updated_at=? WHERE id=?').run(this.encrypt(id,tokens),new Date().toISOString(),id); }
}
